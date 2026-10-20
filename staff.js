/* Blugibbon Reference Requester (staff). Pick one of your doctors, see where their
   references are up to, and send new requests. Document review happens in ClickUp
   (Compliance Documents › "To Review" view), not here. Everything goes through the
   `staff` backend function, which checks the sign-in is Blugibbon staff and that
   the doctor is assigned to them. ?mock=1 shows sample data. */
(function () {
  'use strict';
  const CFG = window.PORTAL_CONFIG;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const live = CFG.mode === 'live';
  const REF_MSG = 'Hello {referee},\n\nBlugibbon is a medical recruitment company that places locum doctors across Australia.\n\n' +
    'Your name has been provided to act as a referee for Dr {doctor}. We understand your time is valuable and very much appreciate your assistance.\n\n' +
    'Could you please complete the reference request(s) by clicking the link(s) below:\n\n{links}\n\n' +
    'If you\'d prefer to complete this verbally, please call us on 02 8960 6445.\n\nWarm regards,\nBlugibbon';
  const blankRef = () => ({ name: '', email: '', templates: ['professional', 'clinical'] });
  const S = { req: null, me: null, recruiters: null, recruiterId: '', doctors: [], q: '', doctor: null, docs: [], busy: false, refDraft: [blankRef()], refMsg: REF_MSG };
  let fns, auth;

  async function api(action, data) {
    if (!live) return MOCK(action, data || {});
    return (await fns.httpsCallable('staff')(Object.assign({ action }, data || {}))).data;
  }
  const niceErr = (e) => (e && e.message ? e.message.replace(/^.*?:\s*/, '') : 'Something went wrong.');
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 5000); }
  const linkBtn = (href, text) => '<a class="btn sm" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(href) + '" target="_blank" rel="noopener">' + text + '</a>';

  // Reference tasks made by Scenario 4, one entry per referee slot (1.2.1-1.2.3).
  function refsFrom(docs) {
    const ST = S.req.clickup.fileStageOptions, by = {};
    docs.forEach((d) => {
      const m = /(?:^|\s)1\.2\.([1-3])\s/.exec(d.name || ''); if (!m || d.fileStage === ST.archived) return;
      const e = by[m[1]] || (by[m[1]] = { slot: +m[1], name: (String(d.name).split(' - ')[1] || '').replace(/\s+\d{2}\.\d{2}\.\d{2}.*$/, '').trim(), parts: [] });
      e.parts.push({ type: /clinical/i.test(d.name) ? 'Clinical' : 'Professional', id: d.id,
        st: d.fileStage === ST.filed ? 'done' : d.fileStage === ST.completed ? 'back' : 'waiting' });
    });
    return Object.values(by).sort((a, b) => a.slot - b.slot);
  }

  function render() {
    $('app').innerHTML = S.doctor ? doctorHtml() : listHtml();
  }
  function listHtml() {
    const q = S.q.trim().toLowerCase();
    const list = S.doctors.filter((d) => !q || (d.name + ' ' + d.medReg + ' ' + d.email).toLowerCase().includes(q));
    return '<section class="card"><div class="head"><input class="search" id="q" type="search" placeholder="Search your doctors by name, rego or email" value="' + esc(S.q) + '" aria-label="Search doctors"></div>' +
      '<div class="list">' + (list.map((d) => '<div class="row" data-open="' + d.id + '"><div class="r-main"><div class="r-t"><b>Dr ' + esc(d.name) + '</b></div>' +
        '<span class="hint">' + esc(d.medReg) + ' · ' + esc(d.status) + '</span></div><span class="hint">›</span></div>').join('') ||
        '<div class="empty">' + (S.doctors.length ? 'No doctors match.' : 'No doctors are assigned to you in ClickUp.') + '</div>') + '</div></section>';
  }
  function doctorHtml() {
    const D = S.doctor, R = S.req.references || { required: 3, minimum: 2, max: 3 };
    const refs = refsFrom(S.docs), left = Math.max(0, R.max - refs.length);
    const L = { waiting: ['Waiting on referee', 'p-optional'], back: ['Back · review in ClickUp', 'p-review'], done: ['Filed', 'p-valid'] };
    let h = '<button class="btn sm" type="button" data-back="1" style="align-self:flex-start">‹ All doctors</button>' +
      '<section class="card"><div class="head"><div style="display:flex;flex-direction:column;gap:2px"><h1>Dr ' + esc(D.name) + '</h1>' +
      '<span class="hint">' + esc(D.medReg) + ' · ' + esc(D.email || 'no email on file') + ' · ' + esc(D.assignee) + '</span></div><div class="sp"></div>' +
      linkBtn('https://app.clickup.com/t/' + D.id, 'ClickUp ↗') + '</div></section>';
    h += '<section class="card"><div class="sec-h" style="cursor:default"><span class="sec-t"><b>References</b><span>' +
      refs.filter((r) => r.parts.every((p) => p.st !== 'waiting')).length + ' of ' + R.required + ' back (' + R.minimum + ' can be enough)</span></span></div>';
    h += refs.map((r) => '<div class="row"><div class="r-main"><div class="r-t"><b>' + esc(r.name || 'Referee ' + r.slot) + '</b><span class="tag p-optional">slot ' + r.slot + '</span></div></div>' +
      '<div class="refpills">' + r.parts.map((p) => '<a class="pill ' + L[p.st][1] + '" style="text-decoration:none" target="_blank" rel="noopener" href="https://app.clickup.com/t/' + esc(p.id) + '">' +
        p.type + ': ' + L[p.st][0] + '</a>').join('') + '</div></div>').join('');
    if (!refs.length) h += '<div class="note">No references requested yet.</div>';
    if (!left) return h + '<div class="note">All ' + R.max + ' referee slots are used.</div></section>';
    S.refDraft = S.refDraft.slice(0, left);
    h += '<div class="refform"><b>Request references</b>' + S.refDraft.map((r, i) => '<div class="rf">' +
      (S.refDraft.length > 1 ? '<button class="x" type="button" aria-label="Remove referee" data-refrm="' + i + '">×</button>' : '') +
      '<label>Referee name<input data-rf="' + i + ':name" value="' + esc(r.name) + '" autocomplete="off"></label>' +
      '<label>Email<input type="email" data-rf="' + i + ':email" value="' + esc(r.email) + '" autocomplete="off"></label>' +
      '<div class="chips">' + [['professional', 'Professional'], ['clinical', 'Clinical'], ['combined', 'NSW combined (one form)']].map(([v, t]) =>
        '<label class="chip"><input type="checkbox" data-tpl="' + i + ':' + v + '"' + (r.templates.includes(v) ? ' checked' : '') + '> ' + t + '</label>').join('') + '</div></div>').join('') +
      (S.refDraft.length < left ? '<button class="btn" type="button" data-refadd="1">+ Add another referee</button>' : '') +
      '<label class="hint" style="display:flex;flex-direction:column;gap:6px">Message ({referee}, {doctor} and {links} are filled in for you)<textarea class="msg" id="refMsg">' + esc(S.refMsg) + '</textarea></label>' +
      '<button class="btn primary" type="button" data-refsend="1"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Sending…' : 'Send reference requests') + '</button></div></section>';
    return h;
  }

  async function loadList() {
    $('app').innerHTML = '<div class="card empty">Loading your doctors…</div>';
    S.doctors = (await api('doctors', { recruiterId: S.recruiterId || undefined })).doctors; render();
  }
  async function openDoctor(id) {
    if (!S.doctor || S.doctor.id !== id) S.refDraft = [blankRef()];
    const r = await api('doctor', { doctorId: id });
    S.doctor = r.doctor; S.docs = r.docs; render();
    try { history.replaceState(null, '', '#d=' + id); } catch (e) { /* preview frames */ }
  }
  async function sendRefs() {
    const rows = S.refDraft.filter((r) => r.name.trim() || r.email.trim());
    if (!rows.length) return toast('Add a referee first.');
    S.busy = true; render();
    try {
      const r = await api('requestReferences', { doctorId: S.doctor.id, referees: rows, message: S.refMsg });
      toast(r.count + ' reference request' + (r.count > 1 ? 's' : '') + ' sent.');
      S.refDraft = [blankRef()];
      const id = S.doctor.id;
      setTimeout(() => { if (S.doctor && S.doctor.id === id) openDoctor(id).catch(() => {}); }, 20000); // Scenario 4 takes ~15 s
    } catch (e) { toast(niceErr(e)); }
    S.busy = false; render();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('button,[data-open]'); if (!el) return;
    const ds = el.dataset;
    if (ds.open !== undefined) openDoctor(ds.open).catch((x) => toast(niceErr(x)));
    else if (ds.back) { S.doctor = null; try { history.replaceState(null, '', location.pathname + location.search); } catch (x) { /* ignore */ } render(); }
    else if (ds.refadd) { S.refDraft.push(blankRef()); render(); }
    else if (ds.refrm) { S.refDraft.splice(+ds.refrm, 1); render(); }
    else if (ds.refsend) sendRefs();
  });
  document.addEventListener('input', (e) => {
    const t = e.target, ds = t.dataset || {};
    if (t.id === 'q') { S.q = t.value; const pos = t.selectionStart; render(); const q = $('q'); q.focus(); q.setSelectionRange(pos, pos); }
    else if (ds.rf) { const [i, k] = ds.rf.split(':'); S.refDraft[+i][k] = t.value; }
    else if (t.id === 'refMsg') S.refMsg = t.value;
  });
  document.addEventListener('change', (e) => {
    const ds = e.target.dataset || {};
    if (ds.tpl) {
      const [i, v] = ds.tpl.split(':'), r = S.refDraft[+i];
      r.templates = e.target.checked ? (v === 'combined' ? ['combined'] : r.templates.filter((x) => x !== 'combined').concat([v])) : r.templates.filter((x) => x !== v);
      render();
    }
  });
  $('recSel').addEventListener('change', (e) => { S.recruiterId = e.target.value; S.doctor = null; loadList().catch((x) => toast(niceErr(x))); });

  async function signedIn() {
    $('app').innerHTML = '<div class="card empty">Loading…</div>';
    const r = await api('me');
    S.me = r.me; S.recruiters = r.recruiters;
    $('whoLine').textContent = S.me.name + ' · ' + S.me.email;
    if (S.recruiters) {
      $('recSel').innerHTML = S.recruiters.map((u) => '<option value="' + u.id + '"' + (u.id === S.me.cuId ? ' selected' : '') + '>' + esc(u.name) + '</option>').join('');
      $('recSel').classList.remove('hidden');
    }
    await loadList();
    const m = /#d=([a-z0-9]+)/i.exec(location.hash);
    if (m) openDoctor(m[1]).catch((x) => toast(niceErr(x)));
  }
  async function start() {
    S.req = await (await fetch('requirements.json', { cache: 'no-cache' })).json();
    if (!live) { $('mockTag').classList.remove('hidden'); return signedIn(); }
    const app = firebase.initializeApp(CFG.firebase, 'staff');
    auth = app.auth(); fns = app.functions('australia-southeast1');
    $('outLink').onclick = (e) => { e.preventDefault(); auth.signOut().then(() => location.reload()); };
    auth.onAuthStateChanged((u) => {
      if (!u) {
        $('whoLine').textContent = 'Please sign in';
        $('app').innerHTML = '<section class="card summary" style="max-width:420px;margin:24px auto"><h1>Staff sign-in</h1><p class="hint">Use your @blugibbon.com.au Google account.</p>' +
          '<button class="btn primary" id="gBtn" type="button">Continue with Google</button><p class="hint" id="msg" role="status"></p></section>';
        $('gBtn').onclick = () => {
          const p = new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({ hd: 'blugibbon.com.au', prompt: 'select_account' });
          auth.signInWithPopup(p).catch((x) => ($('msg').textContent = niceErr(x)));
        };
        return;
      }
      $('outLink').classList.remove('hidden');
      signedIn().catch((x) => { $('app').innerHTML = '<div class="card empty">' + esc(niceErr(x)) + '</div>'; });
    });
  }

  // ---------- sample data (?mock=1) ----------
  function MOCK(action, p) {
    const F = S.req.clickup.fileStageOptions, now = Date.now();
    MOCK.db = MOCK.db || {
      doctors: [{ id: 'd1', name: 'Josh Test', medReg: 'TEST999', email: 'josh@example.com', status: 'active candidate', assignee: 'Izzy Ferrada' },
        { id: 'd2', name: 'Priya Natarajan', medReg: 'MED0004441111', email: 'priya@example.com', status: 'active candidate', assignee: 'Izzy Ferrada' }],
      docs: [{ id: 't4', name: '1.2.1 Professional Ref - Stephen Sun 14.10.26', fileStage: F.completed, created: now, medReg: 'TEST999' },
        { id: 't5', name: '1.2.1 Clinical Ref - Stephen Sun 14.10.26', fileStage: F.requested, created: now, medReg: 'TEST999' }]
    };
    const db = MOCK.db;
    return new Promise((r) => setTimeout(r, 200)).then(() => {
      if (action === 'me') return { me: { name: 'Izzy Ferrada', email: 'izzy@blugibbon.com.au', cuId: 1, admin: false }, recruiters: null };
      if (action === 'doctors') return { doctors: db.doctors };
      if (action === 'doctor') { const d = db.doctors.find((x) => x.id === p.doctorId); return { doctor: d, docs: db.docs.filter((x) => x.medReg === d.medReg) }; }
      if (action === 'requestReferences') return { count: p.referees.length };
      throw new Error('mock: ' + action);
    });
  }
  start().catch((e) => { $('app').innerHTML = '<div class="card empty">Couldn’t load: ' + esc(e.message) + '</div>'; });
})();
