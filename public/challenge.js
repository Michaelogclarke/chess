// Presence + direct challenges, shared by the lobby and game pages.
// Call window.initChallenges(socket) once the page has its socket.
(function () {
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  let clientId = store.get('chess-client-id');
  if (!clientId) {
    clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    store.set('chess-client-id', clientId);
  }

  let socket = null;
  window.myPresenceKey = null;

  const fmtTime = (c) => (c.minutes ? `${c.minutes}+${c.increment}` : 'No clock');
  const colorText = (c, forChallenger) => {
    if (c.color === 'random') return 'random colours';
    const challengerPlays = c.color === 'w' ? 'White' : 'Black';
    const otherPlays = c.color === 'w' ? 'Black' : 'White';
    return forChallenger ? `you play ${challengerPlays}` : `you play ${otherPlays}`;
  };

  // ---------- toasts ----------
  function toastBox() {
    let box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      box.className = 'toasts';
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    return box;
  }
  function toast(id, text, buttons = [], ttl = 0) {
    removeToast(id);
    const t = document.createElement('div');
    t.className = 'toast';
    if (id) t.dataset.id = id;
    const p = document.createElement('p');
    p.textContent = text;
    t.appendChild(p);
    if (buttons.length) {
      const row = document.createElement('div');
      row.className = 'btns';
      for (const [label, fn, primary] of buttons) {
        const b = document.createElement('button');
        b.textContent = label;
        if (primary) b.className = 'primary';
        b.onclick = fn;
        row.appendChild(b);
      }
      t.appendChild(row);
    }
    toastBox().appendChild(t);
    if (ttl) setTimeout(() => t.remove(), ttl);
    return t;
  }
  function removeToast(id) {
    if (id) document.querySelectorAll(`.toast[data-id="${id}"]`).forEach((t) => t.remove());
  }

  // ---------- challenge dialog ----------
  async function challengePlayer(player) {
    const me = await window.mePromise;
    let dlg = document.getElementById('challenge-dialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'challenge-dialog';
      dlg.className = 'settings';
      document.body.appendChild(dlg);
    }
    const canRate = !!(me.user && player.account);
    dlg.innerHTML = `
      <form method="dialog" class="settings-body">
        <div class="settings-head"><h2></h2><button value="cancel" aria-label="Close">✕</button></div>
        <h3>Time control</h3>
        <div class="chips" data-group="tc">
          <button type="button" data-m="3" data-i="2">3+2</button>
          <button type="button" data-m="5" data-i="0">5+0</button>
          <button type="button" data-m="10" data-i="0" class="on">10+0</button>
          <button type="button" data-m="15" data-i="10">15+10</button>
          <button type="button" data-m="30" data-i="0">30+0</button>
          <button type="button" data-m="0" data-i="0">No clock</button>
        </div>
        <h3>You play</h3>
        <div class="chips" data-group="color">
          <button type="button" data-c="w">White</button>
          <button type="button" data-c="random" class="on">Random</button>
          <button type="button" data-c="b">Black</button>
        </div>
        <h3>Game type</h3>
        <div class="chips" data-group="rated">
          <button type="button" data-r="0" class="on">Casual</button>
          <button type="button" data-r="1" ${canRate ? '' : 'disabled'}>Rated</button>
        </div>
        ${canRate ? '' : '<p class="muted small">Rated games need both players logged in.</p>'}
        <button type="submit" value="send" class="primary">Send challenge</button>
      </form>`;
    dlg.querySelector('h2').textContent = 'Challenge ' + player.name;
    dlg.querySelectorAll('[data-group]').forEach((g) => g.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    }));
    dlg.onclose = () => {
      if (dlg.returnValue !== 'send') return;
      const on = (g) => dlg.querySelector(`[data-group="${g}"] .on`);
      const rated = on('rated').dataset.r === '1';
      if (rated && on('tc').dataset.m === '0') return toast(null, 'Rated games need a clock.', [], 4000);
      socket.emit('challenge:send', {
        to: player.key,
        minutes: Number(on('tc').dataset.m),
        increment: Number(on('tc').dataset.i),
        color: on('color').dataset.c,
        rated,
      });
    };
    dlg.returnValue = '';
    dlg.showModal();
  }
  window.challengePlayer = challengePlayer;

  window.initChallenges = function (s) {
    socket = s;
    const hello = () => socket.emit('hello', { clientId, name: store.get('chess-name') });
    if (socket.connected) hello();
    socket.on('connect', hello);
    socket.on('hello-ok', ({ key }) => {
      window.myPresenceKey = key;
      document.dispatchEvent(new CustomEvent('presence-ready'));
    });

    socket.on('challenge:sent', (c) => {
      toast('ch-' + c.id, `Challenge sent to ${c.to}: ${fmtTime(c)}${c.rated ? ' rated' : ''}, ${colorText(c, true)}. Waiting…`,
        [['Cancel', () => socket.emit('challenge:cancel', { id: c.id })]]);
    });
    socket.on('challenge:incoming', (c) => {
      window.playSound?.('notify');
      toast('ch-' + c.id, `${c.from} challenges you: ${fmtTime(c)}${c.rated ? ' rated' : ' casual'}, ${colorText(c, false)}.`, [
        ['Accept', () => socket.emit('challenge:accept', { id: c.id }), true],
        ['Decline', () => socket.emit('challenge:decline', { id: c.id })],
      ]);
    });
    socket.on('challenge:closed', ({ id, reason }) => {
      removeToast('ch-' + id);
      if (reason) toast(null, reason, [], 5000);
    });
    socket.on('challenge:error', (msg) => toast(null, msg, [], 5000));
    socket.on('challenge:start', ({ id, gameId, token }) => {
      removeToast('ch-' + id);
      store.set('chess-token-' + gameId, token);
      location.href = '/g/' + gameId;
    });
  };
})();
