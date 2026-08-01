// Guest controller page (§5.4.2): name + room code in, inputs out. The sim
// lives entirely on the host, and so does the picture — this page never draws
// a pitch, a ball or a scoreline. It samples the same InputHub the game uses
// (so the bindings can never drift apart), packs the state into the 6-byte
// hot-path packet, and shows a slot banner, a connection pip and the RTT it
// actually measured.

import './join.css';
import { ACTIONS, InputHub, type PlayerInput } from '../input/input';
import { GuestLink } from '../net/guestLink';
import { CODE_LENGTH, SPRINT_BIT, isRoomCode, type GuestInputType } from '../net/protocol';

const NAME_KEY = 'ss26-guest-name';
const TOKEN_KEY = 'ss26-guest-token';
/** Sampling cadence (§5.4.4) — a 144Hz display must not send 144 packets/s. */
const SAMPLE_MS = 1000 / 60;

const root = document.getElementById('join-root')!;
const banner = document.getElementById('slot-banner')!;

const KEY_BINDS: [string, string][] = [
  ['MOVE', 'WASD / ARROWS'],
  ['SHORT PASS · PRESSURE', 'J'],
  ['LOFTED PASS · CROSS', 'K'],
  ['SHOOT (HOLD) · SLIDE', 'L'],
  ['THROUGH BALL', 'I'],
  ['SPRINT', 'SHIFT'],
  ['SWITCH PLAYER', 'SPACE'],
];

const PAD_BINDS: [string, string][] = [
  ['MOVE', 'LEFT STICK / DPAD'],
  ['SHORT PASS · PRESSURE', 'A'],
  ['LOFTED PASS · CROSS', 'B'],
  ['SHOOT (HOLD) · SLIDE', 'X'],
  ['THROUGH BALL', 'Y'],
  ['SPRINT', 'RT'],
  ['SWITCH PLAYER', 'LB'],
];

// ------------------------------------------------------------------ storage
// Private browsing throws on both of these; the page just works without the
// convenience (and, for the token, without the reserved-slot rejoin).

function readStored(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* nothing to lose */ }
}

/** Stable per-browser id: the host reserves our slot against it (§5.4.5). */
function rejoinToken(): string {
  const existing = readStored(TOKEN_KEY);
  if (existing) return existing;
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  writeStored(TOKEN_KEY, token);
  return token;
}

// ------------------------------------------------------------- input sampling
// The real InputHub, not a copy: keyboard map, gamepad polling, dpad fallback
// and the blur-neutralise guard all come along for free.

const hub = new InputHub();
const seat: PlayerInput = hub.seat('merged');

function inputType(): GuestInputType {
  return hub.connectedPads().length > 0 ? 'gamepad' : 'keyboard';
}

// ------------------------------------------------------------------- screens

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function showEntry(prefillCode: string, notice = ''): void {
  const name = readStored(NAME_KEY);
  root.innerHTML = `
    <div class="panel">
      <h2>JOIN A MATCH</h2>
      <p class="muted">Your host opened an <b>INVITE PLAYERS</b> screen and read you a
        four-letter room code. Everyone watches the host's screen — this page is
        just your controller.</p>
      ${notice ? `<p class="muted" style="color:#ff8d7d">${esc(notice)}</p>` : ''}
      <div class="field">
        <label for="f-code">ROOM CODE</label>
        <input id="f-code" class="code" maxlength="${CODE_LENGTH}" autocomplete="off"
          autocapitalize="characters" spellcheck="false" value="${esc(prefillCode)}" />
      </div>
      <div class="field">
        <label for="f-name">YOUR NAME</label>
        <input id="f-name" maxlength="18" autocomplete="off" spellcheck="false"
          placeholder="GUEST" value="${esc(name)}" />
      </div>
      <button id="f-go">CONNECT</button>
    </div>`;

  const codeEl = root.querySelector<HTMLInputElement>('#f-code')!;
  const nameEl = root.querySelector<HTMLInputElement>('#f-name')!;
  const goEl = root.querySelector<HTMLButtonElement>('#f-go')!;

  const go = (): void => {
    const code = codeEl.value.trim().toUpperCase();
    if (!isRoomCode(code)) {
      codeEl.focus();
      codeEl.select();
      return;
    }
    const who = nameEl.value.trim().slice(0, 18) || 'GUEST';
    writeStored(NAME_KEY, who);
    connect(code, who);
  };
  goEl.addEventListener('click', go);
  for (const el of [codeEl, nameEl]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  codeEl.addEventListener('input', () => {
    codeEl.value = codeEl.value.toUpperCase();
  });
  (prefillCode.length === CODE_LENGTH ? nameEl : codeEl).focus();
}

function showError(code: string, message: string): void {
  root.innerHTML = `
    <div class="panel error">
      <h2>CAN'T CONNECT</h2>
      <p class="muted">${esc(message)}</p>
      <button id="f-retry">TRY AGAIN</button>
    </div>`;
  root.querySelector('#f-retry')!.addEventListener('click', () => showEntry(code));
}

// ------------------------------------------------------------------ live page

function connect(code: string, name: string): void {
  const link = new GuestLink(code, {
    v: 1, token: rejoinToken(), name, input: inputType(),
  });

  root.innerHTML = `
    <div class="strip">
      <span class="pip" id="s-pip"></span>
      <span id="s-status">CONNECTING…</span>
      <span class="sep">·</span>
      <span>ROOM ${esc(code)}</span>
      <span class="sep">·</span>
      <span class="rtt" id="s-rtt">RTT —</span>
    </div>
    <div class="panel">
      <div class="card-head">
        <h2 id="c-title">YOUR CONTROLS</h2>
        <span class="kind" id="c-kind">KEYBOARD</span>
      </div>
      <div class="binds" id="c-binds"></div>
    </div>
    <p class="muted" id="c-foot">Waiting for the host to give you a slot. Keep this tab
      focused — a background tab stops sending, and the host will hand your
      player to the AI.</p>`;

  const pipEl = root.querySelector<HTMLElement>('#s-pip')!;
  const statusEl = root.querySelector<HTMLElement>('#s-status')!;
  const rttEl = root.querySelector<HTMLElement>('#s-rtt')!;
  const kindEl = root.querySelector<HTMLElement>('#c-kind')!;
  const bindsEl = root.querySelector<HTMLElement>('#c-binds')!;
  const footEl = root.querySelector<HTMLElement>('#c-foot')!;

  let shownKind: GuestInputType | null = null;
  const renderBinds = (kind: GuestInputType): void => {
    if (shownKind === kind) return;
    shownKind = kind;
    kindEl.textContent = kind === 'gamepad' ? 'GAMEPAD' : 'KEYBOARD';
    const rows = kind === 'gamepad' ? PAD_BINDS : KEY_BINDS;
    bindsEl.innerHTML = rows
      .map(([a, k]) => `<span class="act">${a}</span><span class="key">${k}</span>`)
      .join('');
  };
  renderBinds(inputType());

  // the pad card swaps in the moment a controller is plugged in, and back out
  // when it's yanked — the host's lobby list follows over the control channel
  const onPadChange = (): void => {
    const kind = inputType();
    renderBinds(kind);
    link.setInputType(kind);
  };
  window.addEventListener('gamepadconnected', onPadChange);
  window.addEventListener('gamepaddisconnected', onPadChange);

  let bannerSlot: number | null = null;
  const render = (): void => {
    if (link.status === 'error') {
      window.removeEventListener('gamepadconnected', onPadChange);
      window.removeEventListener('gamepaddisconnected', onPadChange);
      showError(code, link.error ?? 'Unknown error.');
      return;
    }
    const brief = link.state?.brief ?? null;
    const live = link.status === 'live';
    pipEl.className = `pip${live ? ' ok' : link.status === 'reconnecting' ? ' warn' : ''}`;
    statusEl.textContent = live
      ? brief ? `PLAYER ${brief.slot + 1} — ${brief.teamCode}` : 'CONNECTED'
      : link.status === 'reconnecting' ? 'RECONNECTING…'
      : link.status === 'closed' ? 'DISCONNECTED' : 'CONNECTING…';
    rttEl.textContent = link.rttMs >= 0 ? `RTT ${link.rttMs} MS` : 'RTT —';

    if (brief && brief.slot !== bannerSlot) {
      bannerSlot = brief.slot;
      showBanner(brief.slot, brief.teamName, brief.shirt, brief.text);
    }
    if (!brief) bannerSlot = null;

    footEl.textContent = brief
      ? `You are playing as ${brief.teamName}. The match is on the host's screen — this page only sends your inputs.`
      : link.state?.note
        ? link.state.note
        : 'Waiting for the host to give you a slot.';
  };
  link.onChange = render;
  link.start();
  render();

  // ------------------------------------------------------- 60Hz sample loop
  let acc = 0;
  let last = performance.now();
  const tick = (now: number): void => {
    requestAnimationFrame(tick);
    acc += now - last;
    last = now;
    if (acc < SAMPLE_MS) return;
    acc = Math.min(acc - SAMPLE_MS, SAMPLE_MS); // never burn down a backlog
    hub.pollGamepads();
    let buttons = 0;
    for (let i = 0; i < ACTIONS.length; i++) {
      if (seat.isHeld(ACTIONS[i])) buttons |= 1 << i;
    }
    if (seat.isSprinting()) buttons |= 1 << SPRINT_BIT;
    const stick = seat.getStick();
    link.sendInput(buttons, stick.x, stick.y);
  };
  requestAnimationFrame(tick);

  // a backgrounded tab stops firing rAF: ship one neutral packet on the way
  // out so the host's player doesn't jog into the corner flag forever
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) link.sendInput(0, 0, 0);
  });
  window.addEventListener('pagehide', () => link.close());
}

function showBanner(slot: number, team: string, shirt: string, text: string): void {
  banner.style.background = shirt;
  banner.style.color = text;
  banner.innerHTML = `
    <div class="who">YOU ARE<br>PLAYER ${slot + 1}</div>
    <div class="team">${esc(team.toUpperCase())}</div>
    <div class="dismiss">TAP TO DISMISS</div>`;
  banner.classList.add('show');
  const hide = (): void => banner.classList.remove('show');
  banner.onclick = hide;
  window.setTimeout(hide, 3500);
}

// -------------------------------------------------------------------- boot

const urlCode = (new URLSearchParams(location.search).get('c') ?? '').toUpperCase();
showEntry(isRoomCode(urlCode) ? urlCode : '');
