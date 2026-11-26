// Shared top bar. Loaded as a normal script in <head> so pages can use
// window.mePromise straight away: { accounts: bool, user: { username, ratings } | null }.
(function () {
  window.mePromise = fetch('/api/me', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { accounts: false, user: null }))
    .catch(() => ({ accounts: false, user: null }));

  window.fmtRating = (r) => (r ? `${r.rating}${r.provisional ? '?' : ''}` : '');

  // ---------- personal settings (saved in this browser) ----------
  const PIECE_SETS = ['cburnett', 'merida', 'chessnut', 'celtic', 'fantasy', 'spatial', 'papercut', 'rhosgfx', 'shapes'];
  const BOARDS = {
    green: ['#ebecd0', '#779556'],
    brown: ['#f0d9b5', '#b58863'],
    blue: ['#dee3e6', '#8ca2ad'],
    purple: ['#e8e1f0', '#9b7bb8'],
    grey: ['#d9d9d9', '#8c8c8c'],
    coral: ['#f3e0d2', '#d08770'],
    ice: ['#eef6fb', '#7fa7c4'],
  };
  const DEFAULTS = { pieces: 'cburnett', board: 'green', blindfold: false, sounds: true, premoves: true, gifs: true };
  let settings = { ...DEFAULTS };
  try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('chess-settings') || '{}') }; } catch {}
  if (!PIECE_SETS.includes(settings.pieces)) settings.pieces = DEFAULTS.pieces;
  if (!BOARDS[settings.board]) settings.board = DEFAULTS.board;

  function applyBoard() {
    const [light, dark] = BOARDS[settings.board];
    document.documentElement.style.setProperty('--light', light);
    document.documentElement.style.setProperty('--dark', dark);
  }
  applyBoard();

  window.settings = {
    get: (k) => settings[k],
    all: () => ({ ...settings }),
    set(k, v) {
      settings[k] = v;
      try { localStorage.setItem('chess-settings', JSON.stringify(settings)); } catch {}
      if (k === 'board') applyBoard();
      document.dispatchEvent(new CustomEvent('settings-change', { detail: { key: k, value: v } }));
    },
    pieceUrl: (color, type) => `/pieces/${settings.pieces}/${color}${type.toUpperCase()}.svg`,
    PIECE_SETS,
    BOARDS,
  };

  // Sounds are synthesized (no audio files to license): a short wooden
  // "tock" for moves, a double clack for captures, soft marimba notes for
  // check, game end and notifications.
  let audio = null, noise = null;
  function ctx() {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    if (!noise) {
      noise = audio.createBuffer(1, audio.sampleRate * 0.05, audio.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    }
    return audio;
  }
  // One wooden knock: a filtered noise click plus a short low "body" thump.
  function knock(at, { pitch = 1, vol = 0.5 } = {}) {
    const a = audio, out = a.createGain();
    out.gain.value = vol;
    out.connect(a.destination);
    const src = a.createBufferSource();
    src.buffer = noise;
    const bp1 = a.createBiquadFilter(); bp1.type = 'bandpass'; bp1.frequency.value = 1150 * pitch; bp1.Q.value = 5;
    const bp2 = a.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 2600 * pitch; bp2.Q.value = 7;
    const g1 = a.createGain(); g1.gain.value = 1.4;
    const g2 = a.createGain(); g2.gain.value = 0.5;
    src.connect(bp1).connect(g1).connect(out);
    src.connect(bp2).connect(g2).connect(out);
    src.start(at);
    const body = a.createOscillator(), bg = a.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(210 * pitch, at);
    body.frequency.exponentialRampToValueAtTime(120 * pitch, at + 0.05);
    bg.gain.setValueAtTime(0.0001, at);
    bg.gain.exponentialRampToValueAtTime(0.35, at + 0.003);
    bg.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    body.connect(bg).connect(out);
    body.start(at); body.stop(at + 0.08);
  }
  // A soft mallet note (fundamental plus a quiet overtone, quick decay).
  function mallet(at, freq, { vol = 0.18, dur = 0.5 } = {}) {
    const a = audio;
    for (const [mult, v] of [[1, 1], [4, 0.12]]) {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol * v, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur / mult);
      o.connect(g).connect(a.destination);
      o.start(at); o.stop(at + dur);
    }
  }
  window.playSound = (kind) => {
    if (!settings.sounds) return;
    try {
      const a = ctx(), t = a.currentTime + 0.005;
      const vary = 0.96 + Math.random() * 0.08; // tiny variation so repeats sound natural
      if (kind === 'move') knock(t, { pitch: vary, vol: 0.85 });
      else if (kind === 'capture') { knock(t, { pitch: 0.9 * vary, vol: 1.0 }); knock(t + 0.045, { pitch: 1.05 * vary, vol: 0.6 }); }
      else if (kind === 'check') { knock(t, { pitch: vary, vol: 0.85 }); mallet(t + 0.04, 880, { vol: 0.1, dur: 0.35 }); }
      else if (kind === 'end') { mallet(t, 523.25, { dur: 0.7 }); mallet(t + 0.16, 659.25, { dur: 0.7 }); mallet(t + 0.32, 783.99, { dur: 0.9 }); }
      else if (kind === 'notify') { mallet(t, 659.25, { vol: 0.14, dur: 0.4 }); mallet(t + 0.12, 987.77, { vol: 0.14, dur: 0.55 }); }
    } catch {}
  };

  function openSettings() {
    let dlg = document.getElementById('settings-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'settings-dialog';
      dlg.className = 'settings';
      document.body.appendChild(dlg);
    }
    const toggle = (key, label, help) => `
      <label class="toggle"><input type="checkbox" data-key="${key}" ${settings[key] ? 'checked' : ''}>
        <span><strong>${label}</strong><span class="muted small">${help}</span></span></label>`;
    dlg.innerHTML = `
      <form method="dialog" class="settings-body">
        <div class="settings-head"><h2>Settings</h2><button value="close" aria-label="Close">✕</button></div>
        <h3>Pieces</h3>
        <div class="piece-grid">${PIECE_SETS.map((p) => `
          <button type="button" class="piece-opt ${p === settings.pieces ? 'on' : ''}" data-pieces="${p}" title="${p}">
            <img src="/pieces/${p}/wN.svg" alt=""><img src="/pieces/${p}/bQ.svg" alt=""><span>${p}</span>
          </button>`).join('')}</div>
        <h3>Board</h3>
        <div class="board-grid">${Object.entries(BOARDS).map(([name, [l, d]]) => `
          <button type="button" class="board-opt ${name === settings.board ? 'on' : ''}" data-board="${name}" title="${name}"
            style="background: conic-gradient(${d} 0 25%, ${l} 0 50%, ${d} 0 75%, ${l} 0)"><span>${name}</span></button>`).join('')}</div>
        <h3>Play</h3>
        ${toggle('premoves', 'Premoves', 'Queue a move while your opponent is thinking.')}
        ${toggle('sounds', 'Sounds', 'Move, capture and check sounds.')}
        ${toggle('blindfold', 'Blindfold', 'Hide the pieces on your screen. Use the move list to follow the game.')}
        ${toggle('gifs', 'Show GIFs', "Show GIF reactions from other players. Turn off if you'd rather not see them.")}
      </form>`;
    dlg.querySelectorAll('[data-pieces]').forEach((b) => (b.onclick = () => {
      window.settings.set('pieces', b.dataset.pieces);
      dlg.querySelectorAll('[data-pieces]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    dlg.querySelectorAll('[data-board]').forEach((b) => (b.onclick = () => {
      window.settings.set('board', b.dataset.board);
      dlg.querySelectorAll('[data-board]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    dlg.querySelectorAll('[data-key]').forEach((i) => (i.onchange = () => window.settings.set(i.dataset.key, i.checked)));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click backdrop to close
    dlg.showModal();
  }
  window.openSettings = openSettings;

  const el = (tag, attrs = {}, text) => {
    const e = document.createElement(tag);
    Object.assign(e, attrs);
    if (text !== undefined) e.textContent = text;
    return e;
  };

  async function render() {
    const nav = document.getElementById('nav');
    if (!nav) return;
    const me = await window.mePromise;
    nav.innerHTML = '';
    const left = el('div', { className: 'nav-left' });
    left.append(el('a', { href: '/', className: 'brand' }, '♞ Chess Online'));
    left.append(el('a', { href: '/analysis', className: 'nav-link' }, 'Analysis'));
    if (me.accounts) left.append(el('a', { href: '/leaderboard', className: 'nav-link' }, 'Leaderboard'));
    nav.append(left);

    const right = el('div', { className: 'nav-right' });
    const gear = el('button', { className: 'nav-link plain gear', title: 'Settings', ariaLabel: 'Settings' }, '⚙');
    gear.onclick = openSettings;
    right.append(gear);
    if (me.user) {
      right.append(el('a', { href: '/u/' + encodeURIComponent(me.user.username), className: 'nav-user' }, me.user.username));
      const out = el('button', { className: 'nav-link plain' }, 'Log out');
      out.onclick = async () => {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
        location.reload();
      };
      right.append(out);
    } else if (me.accounts) {
      const next = encodeURIComponent(location.pathname + location.search);
      right.append(el('a', { href: '/login?next=' + next, className: 'nav-link' }, 'Log in'));
      right.append(el('a', { href: '/login?signup=1&next=' + next, className: 'btn primary small-btn' }, 'Sign up'));
    }
    nav.append(right);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
