// Phone controller page: turns a phone into a touch gamepad. Left half is a
// thumb-relative virtual stick, right half the action buttons. State streams
// to the game at 30Hz over the /ss26-input relay; button edges send
// immediately so the 150ms input buffer on the game side can do its job.

import './controller.css';

type BtnAction = 'pass' | 'loft' | 'shoot' | 'through' | 'switch' | 'pause';

const root = document.getElementById('controller-root')!;

// --- pairing code: from ?c=XXXX, or typed in
const urlCode = new URLSearchParams(location.search).get('c')?.toUpperCase() ?? '';

function buildJoinCard(onJoin: (code: string) => void): void {
  const card = document.createElement('div');
  card.className = 'join-card';
  card.innerHTML = `
    <h1>SUPER STRIKER '26</h1>
    <p>ENTER THE CODE SHOWN ON THE GAME SCREEN</p>
    <input maxlength="4" autocapitalize="characters" autocomplete="off" spellcheck="false" />
    <button>CONNECT</button>
  `;
  const input = card.querySelector('input')!;
  const btn = card.querySelector('button')!;
  const go = (): void => {
    const code = input.value.trim().toUpperCase();
    if (code.length === 4) { card.remove(); onJoin(code); }
  };
  btn.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  document.body.appendChild(card);
  input.focus();
}

function buildPad(): {
  statusBar: HTMLElement; statusText: HTMLElement;
  stickZone: HTMLElement; stickBase: HTMLElement; stickNub: HTMLElement;
} {
  root.innerHTML = `
    <div class="status-bar">
      <span class="left"><span class="dot"></span><span class="txt">CONNECTING…</span></span>
      <span>SUPER STRIKER '26</span>
    </div>
    <div class="stick-zone">
      <div class="stick-hint">MOVE<br>(touch anywhere here)</div>
      <div class="stick-base"></div>
      <div class="stick-nub"></div>
    </div>
    <div class="pad-zone">
      <button class="btn btn-small btn-switch" data-a="switch">SWITCH</button>
      <button class="btn btn-small btn-pause" data-a="pause">START</button>
      <button class="btn btn-sprint" data-sprint>SPRINT</button>
      <button class="btn btn-through" data-a="through">THRU</button>
      <button class="btn btn-shoot" data-a="shoot">SHOOT</button>
      <button class="btn btn-pass" data-a="pass">PASS</button>
      <button class="btn btn-loft" data-a="loft">LOFT</button>
    </div>
    <div class="rotate-hint">ROTATE YOUR PHONE — LANDSCAPE PLAYS BETTER</div>
  `;
  return {
    statusBar: root.querySelector('.status-bar')!,
    statusText: root.querySelector('.status-bar .txt')!,
    stickZone: root.querySelector('.stick-zone')!,
    stickBase: root.querySelector('.stick-base')!,
    stickNub: root.querySelector('.stick-nub')!,
  };
}

function start(code: string): void {
  const ui = buildPad();

  // ------------------------------------------------------------- connection
  let ws: WebSocket | null = null;
  let open = false;
  let retryMs = 500;

  const setStatus = (connected: boolean, text: string): void => {
    ui.statusBar.classList.toggle('connected', connected);
    ui.statusText.textContent = text;
  };

  const send = (msg: unknown): void => {
    if (open && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const connect = (): void => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ss26-input?role=controller&code=${code}`);
    ws.onopen = () => {
      open = true;
      retryMs = 500;
      setStatus(true, `CONNECTED · CODE ${code}`);
    };
    ws.onclose = () => {
      open = false;
      setStatus(false, 'RECONNECTING…');
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 8000);
    };
    ws.onerror = () => { /* onclose follows */ };
  };
  connect();

  // ------------------------------------------------------------- stick
  let stickId: number | null = null;
  let cx = 0, cy = 0;         // stick center (first touch point)
  let sx = 0, sy = 0;         // current deflection, -1..1
  const RADIUS = 64;

  const showStick = (show: boolean): void => {
    ui.stickBase.style.display = show ? 'block' : 'none';
    ui.stickNub.style.display = show ? 'block' : 'none';
  };

  const moveStick = (x: number, y: number): void => {
    let dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) { dx = (dx / len) * RADIUS; dy = (dy / len) * RADIUS; }
    sx = dx / RADIUS;
    sy = dy / RADIUS;
    ui.stickNub.style.left = `${cx + dx}px`;
    ui.stickNub.style.top = `${cy + dy}px`;
  };

  ui.stickZone.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    stickId = e.pointerId;
    ui.stickZone.setPointerCapture(e.pointerId);
    cx = e.clientX; cy = e.clientY;
    ui.stickBase.style.left = `${cx}px`;
    ui.stickBase.style.top = `${cy}px`;
    showStick(true);
    moveStick(e.clientX, e.clientY);
  });
  ui.stickZone.addEventListener('pointermove', (e) => {
    if (e.pointerId === stickId) moveStick(e.clientX, e.clientY);
  });
  const endStick = (e: PointerEvent): void => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    sx = 0; sy = 0;
    showStick(false);
    send({ t: 'state', sx: 0, sy: 0, sp: sprint }); // don't wait for the tick
  };
  ui.stickZone.addEventListener('pointerup', endStick);
  ui.stickZone.addEventListener('pointercancel', endStick);

  // ------------------------------------------------------------- buttons
  let sprint = false;
  for (const el of root.querySelectorAll<HTMLElement>('[data-a]')) {
    const a = el.dataset.a as BtnAction;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('down');
      send({ t: 'btn', a, d: true });
      if (navigator.vibrate) navigator.vibrate(12);
    });
    const up = (): void => {
      el.classList.remove('down');
      send({ t: 'btn', a, d: false });
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', (e) => {
      if ((e as PointerEvent).buttons !== 0 || el.classList.contains('down')) up();
    });
  }
  const sprintEl = root.querySelector<HTMLElement>('[data-sprint]')!;
  sprintEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sprint = true;
    sprintEl.classList.add('down');
  });
  const sprintUp = (): void => {
    sprint = false;
    sprintEl.classList.remove('down');
  };
  sprintEl.addEventListener('pointerup', sprintUp);
  sprintEl.addEventListener('pointercancel', sprintUp);
  sprintEl.addEventListener('pointerleave', sprintUp);

  // ------------------------------------------------------------- state tick
  window.setInterval(() => send({ t: 'state', sx, sy, sp: sprint }), 33);

  // ------------------------------------------------------------- niceties
  // fullscreen + wake lock on first interaction, both feature-detected
  let enhanced = false;
  document.body.addEventListener('pointerdown', () => {
    if (enhanced) return;
    enhanced = true;
    void document.documentElement.requestFullscreen?.().catch(() => { /* fine */ });
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: string) => Promise<unknown> };
    };
    void nav.wakeLock?.request('screen').catch(() => { /* fine */ });
  }, { capture: true });
  // backgrounded phone: drop everything so the player doesn't run off
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      sx = 0; sy = 0; sprint = false;
      send({ t: 'state', sx: 0, sy: 0, sp: false });
    }
  });
}

if (urlCode.length === 4) start(urlCode);
else buildJoinCard(start);
