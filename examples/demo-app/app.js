// Demo Co: a tiny client-side app for scenecast tests and examples. No framework, no build step.
(function () {
  const root = document.getElementById('app');
  const signedIn = () => localStorage.getItem('token') !== null;

  const SAMPLE_WORKLIST = [
    { title: 'Approve the March travel request', due: 'Due today' },
    { title: 'Sign the updated work agreement', due: 'Due Friday' },
    { title: 'Review two new requests', due: 'This week' },
  ];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const NAV = [
    ['/dashboard', 'Dashboard'],
    ['/requests', 'Requests'],
    ['/form', 'Agreement'],
    ['/slow', 'Reports'],
    ['/live', 'Live'],
  ];

  function shell(path, body) {
    const links = NAV.map(([href, label]) => `<a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    root.innerHTML = `
      <header class="topbar">
        <span class="brand">Demo Co</span>
        <nav class="nav">${links}</nav>
        <div class="menu-wrap">
          <button id="menu-button" class="ghost" aria-haspopup="menu" aria-expanded="false">Sam R. ▾</button>
          <div id="account-menu" class="menu" role="menu" hidden>
            <button role="menuitem">Profile</button>
            <button role="menuitem">Settings</button>
            <button role="menuitem" id="signout">Sign out</button>
          </div>
        </div>
      </header>
      <main>${body}</main>`;
    const btn = document.getElementById('menu-button');
    const menu = document.getElementById('account-menu');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    });
    document.addEventListener('click', () => {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
    document.getElementById('signout').addEventListener('click', () => {
      localStorage.removeItem('token');
      location.href = '/login';
    });
  }

  const pages = {
    '/login'() {
      root.innerHTML = `
        <main class="login card">
          <h1>Sign in to Demo Co</h1>
          <form id="login-form">
            <label for="email">Email</label>
            <input id="email" type="email" autocomplete="username" required />
            <label for="password">Password</label>
            <input id="password" type="password" autocomplete="current-password" required />
            <div class="actions"><button id="signin" type="submit">Sign in</button></div>
          </form>
        </main>`;
      document.getElementById('login-form').addEventListener('submit', (e) => {
        e.preventDefault();
        localStorage.setItem('token', 'demo-' + Date.now());
        location.href = '/dashboard';
      });
    },
    '/dashboard'(path) {
      shell(path, `
        <h1>Good morning, Sam</h1>
        <section class="card">
          <h2>What needs you</h2>
          <ul class="worklist"></ul>
        </section>`);
      const list = root.querySelector('.worklist');
      const show = (items) => {
        list.innerHTML = items.length
          ? items.map((i) => `<li><span>${esc(i.title)}</span><span class="tag">${esc(i.due)}</span></li>`).join('')
          : '<li class="empty">Nothing needs you right now.</li>';
      };
      // server.mjs serves the seeded worklist; a plain static server has no API, so use the sample list.
      fetch('/api/worklist')
        .then((r) => (r.ok && (r.headers.get('content-type') || '').includes('json') ? r.json() : SAMPLE_WORKLIST))
        .catch(() => SAMPLE_WORKLIST)
        .then(show);
    },
    '/requests'(path) {
      const rows = [
        ['R-1041', 'Laptop replacement', 'Open', 'Mar 3'],
        ['R-1040', 'Travel to the north office', 'Approved', 'Mar 1'],
        ['R-1039', 'Desk move', 'Closed', 'Feb 26'],
        ['R-1038', 'Software licence', 'Open', 'Feb 24'],
      ]
        .map(([id, title, status, date]) => `<tr><td>${id}</td><td>${title}</td><td>${status}</td><td class="hide-phone">${date}</td></tr>`)
        .join('');
      shell(path, `
        <h1>Requests</h1>
        <section class="card">
          <table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th class="hide-phone">Opened</th></tr></thead><tbody>${rows}</tbody></table>
        </section>`);
    },
    '/form'(path) {
      shell(path, `
        <h1>Work agreement</h1>
        <section class="card">
          <p>Please read the agreement, tick the box and type your full name to sign.</p>
          <label class="check"><input id="agree" type="checkbox" /> I have read and agree to the terms</label>
          <label for="name">Full name</label>
          <input id="name" type="text" autocomplete="name" />
          <div class="actions"><button id="sign" type="button">Sign</button></div>
          <p id="signed" class="signed" hidden></p>
        </section>`);
      document.getElementById('sign').addEventListener('click', () => {
        const name = document.getElementById('name').value.trim();
        const ok = document.getElementById('agree').checked && name !== '';
        const out = document.getElementById('signed');
        out.textContent = ok ? `Signed by ${name}` : 'Tick the box and enter your name first.';
        out.hidden = false;
      });
    },
    '/slow'(path) {
      shell(path, `<h1>Reports</h1><section class="card" id="report"><div class="is-loading">Loading reports…</div></section>`);
      setTimeout(() => {
        const card = document.getElementById('report');
        if (!card) return;
        card.innerHTML = `<p>3 reports are ready.</p><button id="slow-action" type="button">Open latest report</button>`;
      }, 2500);
    },
    // Keeps an EventSource and a streamed fetch open, with a determinate progress bar: a settled page
    // that is never network-idle. Without a server behind /events and /stream it just retries quietly.
    '/live'(path) {
      shell(path, `
        <h1>Live activity</h1>
        <section class="card">
          <p>Storage used</p>
          <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"><span style="width: 40%"></span></div>
          <p id="live-status">Waiting for updates…</p>
          <button id="live-action" type="button">Refresh</button>
        </section>`);
      const status = document.getElementById('live-status');
      const events = new EventSource('/events');
      events.onmessage = (e) => (status.textContent = e.data);
      fetch('/stream')
        .then((r) => r.body && r.body.getReader().read())
        .catch(() => {});
    },
  };

  let path = location.pathname.replace(/\/+$/, '') || '/dashboard';
  if (!signedIn() && path !== '/login') {
    history.replaceState(null, '', '/login');
    path = '/login';
  }
  (pages[path] || pages['/dashboard'])(path);
})();
