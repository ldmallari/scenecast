// Demo Co: a small client-side app for scenecast tests and examples. No framework, no build step,
// no external fonts or assets. Every name and record in it is invented.
(function () {
  const root = document.getElementById('app');
  // The token is in localStorage, or in sessionStorage when the `sessionToken` flag is on.
  const signedIn = () => localStorage.getItem('token') !== null || sessionStorage.getItem('token') !== null;
  const signOut = () => {
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
  };
  // GET /api/flags (server.mjs, or a scene file's route) switches features on. A plain static server has no
  // API, so every flag stays off.
  const FLAGS = { sso: false, sessionToken: false };
  const loadFlags = () =>
    fetch('/api/flags')
      .then((r) => (r.ok && (r.headers.get('content-type') || '').includes('json') ? r.json() : {}))
      .catch(() => ({}))
      .then((f) => ({ ...FLAGS, ...f }));

  const SAMPLE_WORKLIST = [
    { title: 'Approve the March travel request', due: 'Due today' },
    { title: 'Sign the updated work agreement', due: 'Due Friday' },
    { title: 'Review two new requests', due: 'This week' },
  ];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const tone = (due) => (/today/i.test(due) ? 'urgent' : /friday|tomorrow/i.test(due) ? 'soon' : 'later');

  const NAV = [
    ['/dashboard', 'Dashboard'],
    ['/requests', 'Requests'],
    ['/form', 'Agreement'],
    ['/slow', 'Reports'],
    ['/live', 'Live'],
  ];

  const MARK = '<span class="mark" aria-hidden="true"></span>';

  function shell(path, body) {
    const links = NAV.map(([href, label]) => `<a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    root.innerHTML = `
      <header class="topbar">
        <a class="brand" href="/dashboard">${MARK}<span>Demo Co</span></a>
        <nav class="nav" aria-label="Main">${links}</nav>
        <div class="menu-wrap">
          <button id="menu-button" class="account" aria-haspopup="menu" aria-expanded="false">
            <span class="avatar" aria-hidden="true">SR</span><span class="who">Sam R.</span><span class="caret" aria-hidden="true"></span>
          </button>
          <div id="account-menu" class="menu" role="menu" hidden>
            <div class="menu-head"><strong>Sam Rivera</strong><span>sam@example.com</span></div>
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
      signOut();
      location.href = '/login';
    });
  }

  const pages = {
    '/login'() {
      root.innerHTML = `
        <div class="login-page">
          <aside class="login-side">
            <a class="brand brand-light" href="/login">${MARK}<span>Demo Co</span></a>
            <div class="login-pitch">
              <h2>Everything your team needs to get work done, in one place.</h2>
              <p>Requests, approvals and agreements, with a worklist that tells you what to do next.</p>
            </div>
            <p class="login-foot">Demo Co is a sample app for scenecast. All data is invented.</p>
          </aside>
          <main class="login card">
            <h1>Sign in to Demo Co</h1>
            <p class="muted">Welcome back. Use your work account.</p>
            <form id="login-form">
              <label for="email">Work email</label>
              <input id="email" type="email" autocomplete="username" placeholder="name@example.com" required />
              <label for="password">Password</label>
              <input id="password" type="password" autocomplete="current-password" required />
              <div class="actions"><button id="signin" type="submit" class="wide">Sign in</button></div>
            </form>
            <div class="actions" id="sso-row" hidden><button id="sso" type="button" class="secondary wide">Sign in with single sign-on</button></div>
          </main>
        </div>`;
      const flags = loadFlags();
      flags.then((f) => (document.getElementById('sso-row').hidden = !f.sso));
      const signIn = () =>
        flags.then((f) => {
          (f.sessionToken ? sessionStorage : localStorage).setItem('token', 'demo-' + Date.now());
          location.href = '/dashboard';
        });
      document.getElementById('login-form').addEventListener('submit', (e) => {
        e.preventDefault();
        signIn();
      });
      document.getElementById('sso').addEventListener('click', signIn);
    },
    '/dashboard'(path) {
      shell(path, `
        <div class="page-head">
          <div>
            <h1>Good morning, Sam</h1>
            <p class="muted">Here is what needs you this week.</p>
          </div>
          <div class="head-actions">
            <div class="filters-wrap">
              <button id="filters" type="button" class="secondary" aria-expanded="false">Filters</button>
              <div class="filters-pop" hidden>
                <label class="check"><input type="checkbox" checked /> Due this week</label>
                <label class="check"><input type="checkbox" /> Waiting on others</label>
                <label class="check"><input type="checkbox" /> Signed</label>
              </div>
            </div>
            <a class="button secondary" href="/requests">View all requests</a>
          </div>
        </div>
        <div class="grid">
          <div class="stack">
            <section class="card">
              <div class="card-head"><h2>What needs you</h2><span class="count" id="work-count"></span></div>
              <ul class="worklist"></ul>
            </section>
            <section class="card">
              <h2>Coming up</h2>
              <ul class="agenda">
                <li><span class="day"><strong>12</strong>Mar</span><div><strong>Team planning</strong><span>Tuesday, 10:00 to 11:00</span></div></li>
                <li><span class="day"><strong>14</strong>Mar</span><div><strong>Agreement sign-off deadline</strong><span>Friday, end of day</span></div></li>
              </ul>
            </section>
          </div>
          <div class="stack">
            <section class="card">
              <h2>This week</h2>
              <div class="stats">
                <div class="stat"><strong>4</strong><span>Open requests</span></div>
                <div class="stat"><strong>1</strong><span>To sign</span></div>
                <div class="stat"><strong>6</strong><span>Approved</span></div>
              </div>
            </section>
            <section class="card">
              <h2>Recent activity</h2>
              <ul class="activity">
                <li><span class="dot ok"></span><div><strong>Travel to the north office</strong><span>Approved on Mar 1</span></div></li>
                <li><span class="dot"></span><div><strong>Laptop replacement</strong><span>Opened on Mar 3</span></div></li>
                <li><span class="dot"></span><div><strong>Desk move</strong><span>Closed on Feb 26</span></div></li>
              </ul>
            </section>
          </div>
        </div>`);
      const filters = document.getElementById('filters');
      const pop = root.querySelector('.filters-pop');
      filters.addEventListener('click', () => {
        pop.hidden = !pop.hidden;
        filters.setAttribute('aria-expanded', String(!pop.hidden));
      });
      const list = root.querySelector('.worklist');
      const show = (items) => {
        document.getElementById('work-count').textContent = items.length ? `${items.length} items` : '';
        list.innerHTML = items.length
          ? items
              .map((i) => `<li><span class="item">${esc(i.title)}</span><span class="tag ${tone(i.due)}">${esc(i.due)}</span></li>`)
              .join('')
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
        ['R-1037', 'Training course', 'Approved', 'Feb 20'],
      ]
        .map(
          ([id, title, status, date]) =>
            `<tr><td class="id">${id}</td><td>${title}</td><td><span class="pill ${status.toLowerCase()}">${status}</span></td><td class="hide-phone">${date}</td></tr>`,
        )
        .join('');
      shell(path, `
        <div class="page-head">
          <div><h1>Requests</h1><p class="muted">Everything you have asked for, newest first.</p></div>
          <button id="new-request" type="button" class="hide-phone">New request</button>
        </div>
        <section class="card flush">
          <table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th class="hide-phone">Opened</th></tr></thead><tbody>${rows}</tbody></table>
        </section>
        <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" hidden>
          <div class="drawer-head"><h2 id="drawer-title">New request</h2><span class="muted" id="wizard-step">Step 1 of 2</span></div>
          <div class="wizard-step" data-step="1">
            <label for="request-title">What do you need?</label>
            <input id="request-title" type="text" placeholder="For example, a new monitor" />
            <div class="actions"><button id="wizard-next" type="button">Next</button></div>
          </div>
          <div class="wizard-step" data-step="2" hidden>
            <p>Attach a quote or a receipt, if you have one.</p>
            <div class="dropzone" tabindex="0">Drop a file here, or <strong>browse</strong><input id="file" type="file" hidden /></div>
            <ul class="attached"></ul>
            <div class="actions"><button id="wizard-submit" type="button">Send request</button></div>
          </div>
        </aside>`);
      // The drawer and its wizard step live in memory only: no route opens them (a scene starts there with `setup`).
      const drawer = root.querySelector('.drawer');
      const show = (n) => {
        for (const el of root.querySelectorAll('.wizard-step')) el.hidden = el.dataset.step !== String(n);
        document.getElementById('wizard-step').textContent = `Step ${n} of 2`;
      };
      document.getElementById('new-request').addEventListener('click', () => {
        drawer.hidden = false;
        show(1);
      });
      document.getElementById('wizard-next').addEventListener('click', () => show(2));
      document.getElementById('wizard-submit').addEventListener('click', () => (drawer.hidden = true));
      document.addEventListener('keydown', (e) => e.key === 'Escape' && (drawer.hidden = true));
      // The dropzone opens the file chooser through its hidden input; the chosen files are listed below it.
      const input = document.getElementById('file');
      root.querySelector('.dropzone').addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        root.querySelector('.attached').innerHTML = [...input.files]
          .map((f) => `<li><span class="file-name">${esc(f.name)}</span><span class="muted">${Math.max(1, Math.round(f.size / 1024))} KB</span></li>`)
          .join('');
      });
    },
    '/form'(path) {
      shell(path, `
        <div class="page-head">
          <div><h1>Work agreement</h1><p class="muted">Version 3, updated this month. Please sign by Friday.</p></div>
        </div>
        <div class="grid">
          <section class="card agreement">
            <h2>Summary of changes</h2>
            <p>This agreement sets out how we work together day to day. The main changes in this version are:</p>
            <ul>
              <li>Core hours are now 10:00 to 15:00, with the rest of the day flexible.</li>
              <li>Remote days can be booked up to two weeks ahead.</li>
              <li>Equipment requests go through the Requests page.</li>
            </ul>
            <p>Everything else is unchanged from the previous version.</p>
          </section>
          <section class="card sign-panel">
            <h2>Sign</h2>
            <p>Please read the agreement, tick the box and type your full name to sign.</p>
            <label class="check"><input id="agree" type="checkbox" /> I have read and agree to the terms</label>
            <label for="name">Full name</label>
            <input id="name" type="text" autocomplete="name" />
            <div class="actions"><button id="sign" type="button">Sign</button></div>
            <p id="signed" class="signed" hidden></p>
          </section>
        </div>`);
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
