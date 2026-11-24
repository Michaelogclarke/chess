// Shared top bar. Loaded as a normal script in <head> so pages can use
// window.mePromise straight away: { accounts: bool, user: { username, ratings } | null }.
(function () {
  window.mePromise = fetch('/api/me', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { accounts: false, user: null }))
    .catch(() => ({ accounts: false, user: null }));

  window.fmtRating = (r) => (r ? `${r.rating}${r.provisional ? '?' : ''}` : '');

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
    if (me.accounts) left.append(el('a', { href: '/leaderboard', className: 'nav-link' }, 'Leaderboard'));
    nav.append(left);

    const right = el('div', { className: 'nav-right' });
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
