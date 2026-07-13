// Phone-as-controller relay: a tiny WebSocket hub living inside the Vite
// dev/preview server. The game page registers with a room code; controller
// pages (phones) join the same code and their input is relayed to the game.
// Dev-server only — the built game is still fully static, the feature simply
// reports "unavailable" when no relay answers.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';

const WS_PATH = '/ss26-input';

interface Room {
  game: WebSocket | null;
  controllers: Map<number, WebSocket>;
}

export default function controllerRelay(): Plugin {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Room>();

  const send = (ws: WebSocket | null, msg: unknown): void => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const cleanup = (code: string): void => {
    const room = rooms.get(code);
    if (room && !room.game && room.controllers.size === 0) rooms.delete(code);
  };

  const handle = (ws: WebSocket, url: URL): void => {
    const role = url.searchParams.get('role');
    const code = (url.searchParams.get('code') ?? '').toUpperCase();
    if (!code || code.length > 8 || (role !== 'game' && role !== 'controller')) {
      ws.close();
      return;
    }
    let room = rooms.get(code);
    if (!room) {
      room = { game: null, controllers: new Map() };
      rooms.set(code, room);
    }

    if (role === 'game') {
      room.game?.close(); // a reloaded game page supersedes the old one
      room.game = ws;
      // phones that connected while the game was loading
      for (const id of room.controllers.keys()) send(ws, { t: 'joined', id });
      ws.on('close', () => {
        if (room.game === ws) room.game = null;
        cleanup(code);
      });
      ws.on('error', () => { /* close follows */ });
      return;
    }

    // controller: smallest free id so the first phone is always P1-capable
    let id = 0;
    while (room.controllers.has(id)) id++;
    room.controllers.set(id, ws);
    send(ws, { t: 'ok', id });
    send(room.game, { t: 'joined', id });
    ws.on('message', (data) => {
      if (typeof data !== 'string' && !(data instanceof Buffer)) return;
      const text = String(data);
      if (text.length > 512) return; // controller messages are tiny
      let m: unknown;
      try { m = JSON.parse(text); } catch { return; }
      send(room.game, { t: 'in', id, m });
    });
    ws.on('close', () => {
      room.controllers.delete(id);
      send(room.game, { t: 'left', id });
      cleanup(code);
    });
    ws.on('error', () => { /* close follows */ });
  };

  const attach = (httpServer: { on: (ev: string, fn: (...a: never[]) => void) => void } | null): void => {
    if (!httpServer) return;
    (httpServer as unknown as {
      on(ev: 'upgrade', fn: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void;
    }).on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== WS_PATH) return; // not ours (e.g. Vite HMR)
      wss.handleUpgrade(req, socket, head, (ws) => handle(ws, url));
    });
  };

  return {
    name: 'ss26-controller-relay',
    configureServer(server) { attach(server.httpServer); },
    configurePreviewServer(server) { attach(server.httpServer); },
  };
}
