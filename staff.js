/* Blugibbon staff view: my doctors, review queue, review + upload on a doctor's
   behalf, and the Reference Requester. Everything goes through the `staff`
   backend function, which checks the sign-in is Blugibbon staff and that the
   doctor is assigned to them. ?mock=1 shows sample data. */
(function () {
  'use strict';
  const CFG = window.PORTAL_CONFIG;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const live = CFG.mode === 'live';
  const ddmmyy = (ms) => { const d = new Date(ms); return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + String(d.getFullYear()).slice(-2); };
  const REF_MSG = 'Hello {referee},\n\nBlugibbon is a medical recruitment company that places locum doctors across Australia.\n\n' +
    'Your name has been provided to act as a referee for Dr {doctor}. We understand your time is valuable and very much appreciate your assistance.\n\n' +
    'Could you please complete the reference request(s) by clicking the link(s) below:\n\n{links}\n\n' +
    'If you\'d prefer to complete this verbally, please call us on 02 8960 6445.\n\nWarm regards,\nBlugibbon';
  const blankRef = () => ({ name: '', email: '', templates: ['professional', 'clinical'] });
  const S = { req: null, me: null, recruiters: null, recruiterId: '', doctors: [], waiting: [], tab: 'doctors', q: '', doctor: null, docs: [],
    staged: {}, choice: {}, states: [], expiry: {}, reject: {}, busy: false, refDraft: [blankRef()], refMsg: REF_MSG };
  let fns, auth, pickTarget = null;

  // ---------- backend ----------
  async function api(action, data) {
    if (!live) return MOCK(action, data || {});
    return (await fns.httpsCallable('staff')(Object.assign({ action }, data || {}))).data;
  }
  const niceErr = (e) => (e && e.message ? e.message.replace(/^.*?:\s*/, '') : 'Something went wrong.');
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 5000); }

  // ---------- status rules (same as the doctor's page) ----------
  const ST = () => S.req.clickup.fileStageOptions, RV = () => S.req.clickup.reviewerOptions;
  const inReview = (d) => [ST().new, ST().renewed, ST().completed].includes(d.fileStage) && d.reviewer !== RV().approved && d.reviewer !== RV().rejected;
  function boxStatus(b) {
    const skip = [ST().archived, ST().doctorRecord, ST().formResponse, ST().processed];
    const types = b.kind === 'choice' ? b.options.map((o) => o.docTypeId) : [b.docTypeId];
    const hit = S.docs.filter((d) => !skip.includes(d.fileStage) && (b.docTypeId || b.kind === 'choice' ? types.includes(d.docType) : String(d.name).startsWith(b.namePrefix)) &&
      (!b.stateOptionId || d.state === b.stateOptionId)).sort((x, y) => y.created - x.created)[0];
    if (!hit) return { st: 'missing' };
    const now = Date.now();
    let st = 'valid';
    if ((hit.fileStage === ST().new || hit.fileStage === ST().renewed) && hit.reviewer === RV().rejected) st = 'rejected';
    else if (inReview(hit)) st = 'review';
    else if ((hit.due && hit.due < now) || /expired/i.test(hit.status)) st = 'expired';
    else if (hit.due && hit.due < now + 30 * 86400000) st = 'expiring';
    return { st, hit, exp: hit.due ? ddmmyy(hit.due) : '' };
  }
  const PILL = { valid: ['Valid', 'p-valid'], review: ['To review', 'p-review'], expiring: ['Expiring', 'p-expiring'], expired: ['Expired', 'p-expired'],
    rejected: ['Rejected · waiting for new copy', 'p-expired'], missing: ['Missing', 'p-missing'] };
  const hasExpiry = (b, docType) => b.kind === 'choice' ? ((b.options.find((o) => o.docTypeId === docType) || b.options[0]).expiry) : b.expiry;
  function refsFrom(docs) {
    const by = {};
    docs.forEach((d) => {
      const m = /(?:^|\s)1\.2\.([1-3])\s/.exec(d.name || ''); if (!m || d.fileStage === ST().archived) return;
      const e = by[m[1]] || (by[m[1]] = { slot: +m[1], name: (String(d.name).split(' - ')[1] || '').replace(/\s+\d{2}\.\d{2}\.\d{2}.*$/, '').trim(), parts: [] });
      e.parts.push({ type: /clinical/i.test(d.name) ? 'Clinical' : 'Professional', d,
        st: d.fileStage === ST().filed ? 'done' : d.fileStage === ST().completed ? (inReview(d) ? 'review' : 'received') : 'waiting' });
    });
    return Object.values(by).sort((a, b) => a.slot - b.slot);
  }
  const linkBtn = (href, text) => '<a class="btn sm" style="display:inline-flex;align-items:center;text-decoration:none" href="' + esc(href) + '" target="_blank" rel="noopener">' + text + '</a>';

  // ---------- views ----------
  function render() {
    let h = '<div class="tabs" role="tablist">' +
      '<button class="tab" role="tab" data-tab="doctors" aria-selected="' + (S.tab === 'doctors') + '">My doctors<span class="count">' + S.doctors.length + '</span></button>' +
      '<button class="tab" role="tab" data-tab="review" aria-selected="' + (S.tab === 'review') + '">To review<span class="count">' + S.waiting.length + '</span></button>' +
      (S.doctor ? '<button class="tab" role="tab" data-tab="doctor" aria-selected="' + (S.tab === 'doctor') + '">Dr ' + esc(S.doctor.name) + '</button>' : '') + '</div>';
    if (S.tab === 'doctors') h += doctorsHtml();
    else if (S.tab === 'review') h += reviewHtml();
    else h += doctorHtml();
    $('app').innerHTML = h;
    const staged = Object.values(S.staged).flat();
    $('tray').classList.toggle('hidden', !(S.tab === 'doctor' && staged.length));
    $('trayText').textContent = staged.length + (staged.length === 1 ? ' file' : ' files') + ' for Dr ' + (S.doctor ? S.doctor.name : '');
    $('submitBtn').disabled = S.busy;
    $('submitBtn').textContent = S.busy ? 'Sending…' : 'Submit';
  }
  function doctorsHtml() {
    const waitBy = {}; S.waiting.forEach((w) => { waitBy[w.medReg] = (waitBy[w.medReg] || 0) + 1; });
    const q = S.q.trim().toLowerCase();
    const list = S.doctors.filter((d) => !q || (d.name + ' ' + d.medReg + ' ' + d.email).toLowerCase().includes(q))
      .sort((a, b) => (waitBy[b.medReg] || 0) - (waitBy[a.medReg] || 0) || a.name.localeCompare(b.name));
    return '<section class="card"><div class="head"><input class="search" id="q" type="search" placeholder="Search name, rego or email" value="' + esc(S.q) + '" aria-label="Search doctors"></div>' +
      '<div class="list">' + (list.map((d) => '<div class="row" data-open="' + d.id + '"><div class="r-main"><div class="r-t"><b>Dr ' + esc(d.name) + '</b></div>' +
        '<span class="hint">' + esc(d.medReg) + ' · ' + esc(d.status) + '</span></div>' +
        (waitBy[d.medReg] ? '<span class="pill p-review">' + waitBy[d.medReg] + ' to review</span>' : '') + '</div>').join('') ||
        '<div class="empty">' + (S.doctors.length ? 'No doctors match.' : 'No doctors are assigned to you in ClickUp.') + '</div>') + '</div></section>';
  }
  function reviewHtml() {
    const byReg = {}; S.doctors.forEach((d) => { byReg[d.medReg] = d; });
    return '<section class="card"><div class="list">' + (S.waiting.map((w) => {
      const d = byReg[w.medReg] || {};
      const by = /(?:^|\s)1\.2\.[1-3]\s/.test(w.name) ? 'referee' : w.submittedBy === S.req.clickup.submittedByOptions.recruiter ? 'recruiter' : 'doctor';
      return '<div class="row" data-open="' + (d.id || '') + '"><div class="r-main"><div class="r-t"><b>' + esc(w.name) + '</b></div>' +
        '<span class="hint">Dr ' + esc(d.name || w.medReg) + ' · sent ' + ddmmyy(w.created) + ' by ' + by + '</span></div><span class="pill p-review">Review</span></div>';
    }).join('') || '<div class="empty">Nothing waiting for review.</div>') + '</div></section>';
  }
  function reviewControls(d, b) {
    const ex = b && hasExpiry(b, d.docType);
    if (S.reject[d.id] != null) {
      return '<div class="rv"><input type="text" data-reason="' + d.id + '" placeholder="Why? The doctor gets this in an email" value="' + esc(S.reject[d.id]) + '">' +
        '<button class="btn sm no" type="button" data-rejectgo="' + d.id + '">Send rejection</button><button class="btn sm" type="button" data-rejectx="' + d.id + '">Cancel</button></div>';
    }
    return '<div class="rv">' + (d.link ? linkBtn(d.link, 'Open file ↗') : '') +
      (ex ? '<label class="hint">Expiry <input type="date" data-exp="' + d.id + '" value="' + esc(S.expiry[d.id] || '') + '"></label>' : '') +
      '<button class="btn sm ok" type="button" data-approve="' + d.id + '" data-needexp="' + (ex ? 1 : 0) + '"' + (S.busy ? ' disabled' : '') + '>Approve</button>' +
      '<button class="btn sm no" type="button" data-reject="' + d.id + '">Reject</button></div>';
  }
  function doctorHtml() {
    const D = S.doctor;
    if (!D) return '<div class="card empty">Pick a doctor.</div>';
    const st = S.req.states.map((s) => '<button class="tog" type="button" data-state="' + s + '" aria-pressed="' + S.states.includes(s) + '">' + s + '</button>').join('');
    let h = '<section class="card"><div class="head"><div style="display:flex;flex-direction:column;gap:2px"><h1>Dr ' + esc(D.name) + '</h1>' +
      '<span class="hint">' + esc(D.medReg) + ' · ' + esc(D.email || 'no email on file') + ' · ' + esc(D.assignee) + '</span></div><div class="sp"></div>' +
      (D.folder ? linkBtn(D.folder, 'Drive folder ↗') : '') + linkBtn('https://app.clickup.com/t/' + D.id, 'ClickUp ↗') + '</div>' +
      '<div class="prefs"><b>States</b><div class="pills">' + st + '</div><span class="hint">None picked shows every state.</span></div></section>';
    const applies = (b) => b.states[0] === 'ALL' || !S.states.length || b.states.some((s) => S.states.includes(s));
    S.req.sections.filter((s) => s.id !== 'refs').forEach((sec) => {
      const rows = S.req.boxes.filter((b) => b.section === sec.id && applies(b));
      h += '<section class="card"><div class="sec-h" style="cursor:default"><span class="sec-t"><b>' + esc(sec.title) + '</b></span></div>' + rows.map((b) => {
        const s = boxStatus(b), [lbl, cls] = PILL[s.st];
        const files = S.staged[b.id] || [];
        const act = b.kind === 'form' ? '<a class="act form" href="' + esc(b.formUrl) + '" target="_blank" rel="noopener">Form ↗</a>'
          : '<button class="act' + (files.length ? ' go' : '') + '" type="button" data-up="' + b.id + '">' + (files.length ? 'Replace file' : 'Upload for doctor') + '</button>';
        const choice = b.kind === 'choice' ? '<label class="hint">Which? <select class="choice" data-choice="' + b.id + '">' + b.options.map((o) =>
          '<option value="' + o.id + '"' + (S.choice[b.id] === o.id ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</select></label>' : '';
        return '<div class="row"><div class="r-main"><div class="r-t"><b>' + esc(b.label) + '</b></div>' +
          '<span class="hint">' + esc(s.hit ? s.hit.name : b.hint) + '</span>' + choice +
          (files.length ? '<div class="files">' + files.map((f, i) => '<span class="file">' + esc(f.name) + '<button type="button" aria-label="Remove" data-rm="' + b.id + ':' + i + '">×</button></span>').join('') + '</div>' : '') +
          (s.st === 'review' ? reviewControls(s.hit, b) : '') + '</div>' +
          '<span class="pill ' + cls + '">' + lbl + (s.exp && s.st !== 'review' ? ' · ' + s.exp : '') + '</span>' + act + '</div>';
      }).join('') + '</section>';
    });
    return h + refsHtml();
  }
  function refsHtml() {
    const R = S.req.references || { required: 3, minimum: 2, max: 3 };
    const refs = refsFrom(S.docs), left = Math.max(0, R.max - refs.length);
    const L = { waiting: ['Waiting on referee', 'p-optional'], review: ['Back · to review', 'p-review'], received: ['Back', 'p-review'], done: ['Filed', 'p-valid'] };
    let h = '<section class="card"><div class="sec-h" style="cursor:default"><span class="sec-t"><b>References</b><span>' +
      refs.filter((r) => r.parts.every((p) => p.st !== 'waiting')).length + ' of ' + R.required + ' back (' + R.minimum + ' can be enough)</span></span></div>';
    h += refs.map((r) => '<div class="row"><div class="r-main"><div class="r-t"><b>' + esc(r.name || 'Referee ' + r.slot) + '</b><span class="tag p-optional">slot ' + r.slot + '</span></div>' +
      r.parts.filter((p) => p.st === 'review').map((p) => '<span class="hint">' + p.type + ' reference</span>' + reviewControls(p.d, null)).join('') + '</div>' +
      '<div class="refpills">' + r.parts.map((p) => '<span class="pill ' + L[p.st][1] + '">' + p.type + ': ' + L[p.st][0] + '</span>').join('') + '</div></div>').join('');
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
      '<button class="btn primary" type="button" data-refsend="1"' + (S.busy ? ' disabled' : '') + '>Send reference requests</button></div></section>';
    return h;
  }

  // ---------- actions ----------
  async function loadList() {
    const r = await api('doctors', { recruiterId: S.recruiterId || undefined });
    S.doctors = r.doctors; S.waiting = r.waiting; render();
  }
  async function openDoctor(id) {
    if (!id) return toast('That doctor isn’t in your list.');
    if (!S.doctor || S.doctor.id !== id) { S.staged = {}; S.expiry = {}; S.reject = {}; S.refDraft = [blankRef()]; }
    S.tab = 'doctor';
    const r = await api('doctor', { doctorId: id });
    S.doctor = r.doctor; S.docs = r.docs; render();
    try { history.replaceState(null, '', '#d=' + id); } catch (e) { /* preview frames */ }
  }
  async function review(taskId, decision, extra) {
    S.busy = true; render();
    try {
      await api('review', Object.assign({ taskId, decision }, extra));
      toast(decision === 'approve' ? 'Approved. Filing runs now.' : 'Rejected and the doctor has been emailed.');
      delete S.reject[taskId]; delete S.expiry[taskId];
      await openDoctor(S.doctor.id); loadList().catch(() => {});
    } catch (e) { toast(niceErr(e)); }
    S.busy = false; render();
  }
  async function submitFiles() {
    const items = []; Object.keys(S.staged).forEach((id) => S.staged[id].forEach((f) => items.push({ id, f })));
    if (!items.length) return;
    S.busy = true; render();
    try {
      const files = [];
      for (const { id, f } of items) {
        const choice = S.choice[id] || null;
        if (live) {
          const { uploadUrl } = await api('startUpload', { doctorId: S.doctor.id, boxId: id, choice, fileName: f.name, mimeType: f.type || 'application/octet-stream', size: f.size });
          const res = await fetch(uploadUrl, { method: 'PUT', body: f });
          if (!res.ok) throw new Error('Upload failed (' + res.status + ')');
          files.push({ boxId: id, choice, fileId: (await res.json()).id, fileName: f.name });
        } else files.push({ boxId: id, choice, fileName: f.name });
      }
      await api('submit', { doctorId: S.doctor.id, files, states: S.states });
      S.staged = {};
      toast(items.length + ' file' + (items.length > 1 ? 's' : '') + ' added for Dr ' + S.doctor.name + '. They’re now in To review.');
      await openDoctor(S.doctor.id); loadList().catch(() => {});
    } catch (e) { toast(niceErr(e)); }
    S.busy = false; render();
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

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button,a,[data-open]'); if (!el) return;
    const ds = el.dataset;
    if (ds.tab) { S.tab = ds.tab; render(); }
    else if (ds.open !== undefined) openDoctor(ds.open).catch((x) => toast(niceErr(x)));
    else if (ds.state) { S.states = S.states.includes(ds.state) ? S.states.filter((s) => s !== ds.state) : S.states.concat([ds.state]); render(); }
    else if (ds.approve) {
      const exp = S.expiry[ds.approve] || '';
      if (ds.needexp === '1' && !exp) return toast('Enter the expiry date from the document first.');
      review(ds.approve, 'approve', exp ? { expiry: exp } : {});
    } else if (ds.reject) { S.reject[ds.reject] = ''; render(); }
    else if (ds.rejectx) { delete S.reject[ds.rejectx]; render(); }
    else if (ds.rejectgo) {
      if (!String(S.reject[ds.rejectgo] || '').trim()) return toast('Say why, so the doctor knows what to send.');
      review(ds.rejectgo, 'reject', { reason: S.reject[ds.rejectgo] });
    } else if (ds.up) { pickTarget = ds.up; $('picker').value = ''; $('picker').click(); }
    else if (ds.rm) { const [id, i] = ds.rm.split(':'); S.staged[id].splice(+i, 1); if (!S.staged[id].length) delete S.staged[id]; render(); }
    else if (ds.refadd) { S.refDraft.push(blankRef()); render(); }
    else if (ds.refrm) { S.refDraft.splice(+ds.refrm, 1); render(); }
    else if (ds.refsend) sendRefs();
  });
  document.addEventListener('input', (e) => {
    const t = e.target, ds = t.dataset || {};
    if (t.id === 'q') { S.q = t.value; const pos = t.selectionStart; render(); const q = $('q'); q.focus(); q.setSelectionRange(pos, pos); }
    else if (ds.exp) S.expiry[ds.exp] = t.value;
    else if (ds.reason) S.reject[ds.reason] = t.value;
    else if (ds.rf) { const [i, k] = ds.rf.split(':'); S.refDraft[+i][k] = t.value; }
    else if (t.id === 'refMsg') S.refMsg = t.value;
  });
  document.addEventListener('change', (e) => {
    const ds = e.target.dataset || {};
    if (ds.exp) S.expiry[ds.exp] = e.target.value;
    if (ds.choice) S.choice[ds.choice] = e.target.value;
    if (ds.tpl) {
      const [i, v] = ds.tpl.split(':'), r = S.refDraft[+i];
      r.templates = e.target.checked ? (v === 'combined' ? ['combined'] : r.templates.filter((x) => x !== 'combined').concat([v])) : r.templates.filter((x) => x !== v);
      render();
    }
  });
  $('picker').addEventListener('change', (e) => {
    if (!pickTarget || !e.target.files.length) return;
    const f = e.target.files[0];
    if (f.size > CFG.maxUploadBytes) return toast('That file is over 50 MB.');
    S.staged[pickTarget] = [f]; render();
  });
  $('submitBtn').addEventListener('click', submitFiles);
  $('clearBtn').addEventListener('click', () => { S.staged = {}; render(); });
  $('recSel').addEventListener('change', (e) => { S.recruiterId = e.target.value; S.doctor = null; S.tab = 'doctors'; loadList().catch((x) => toast(niceErr(x))); });

  // ---------- start ----------
  async function signedIn() {
    $('app').innerHTML = '<div class="card empty">Loading your doctors…</div>';
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
    const F = ST(), day = 86400000, now = Date.now(), by = S.req.clickup.submittedByOptions;
    MOCK.db = MOCK.db || {
      doctors: [{ id: 'd1', name: 'Josh Test', medReg: 'TEST999', email: 'josh@example.com', status: 'active candidate', assignee: 'Izzy Ferrada', folder: '#' },
        { id: 'd2', name: 'Priya Natarajan', medReg: 'MED0004441111', email: 'priya@example.com', status: 'active candidate', assignee: 'Izzy Ferrada' },
        { id: 'd3', name: 'Sam O\'Connor', medReg: 'MED0009990000', email: 'sam@example.com', status: 'pre-screened', assignee: 'Izzy Ferrada' }],
      docs: [
        { id: 't1', name: '4.1 BG AHPRA EXP JOSH TEST', fileStage: F.renewed, docType: '9c2843f2-bc65-4a1d-83f2-52e80d63485c', created: now - day, medReg: 'TEST999', link: '#', submittedBy: by.doctor },
        { id: 't2', name: '5.2 BG ID PP EXP 03.08.29 JOSH TEST', fileStage: F.filed, docType: '5ed5295a-22b3-4ceb-8401-8a34a732dc7c', due: now + 900 * day, created: now - 60 * day, medReg: 'TEST999' },
        { id: 't3', name: '6.3.1.7 BG VACS FLU JOSH TEST', fileStage: F.new, docType: 'aaaa5b7f-1c09-481a-ad2e-40f745c007d1', created: now - 2 * day, medReg: 'TEST999', link: '#', submittedBy: by.doctor },
        { id: 't4', name: '1.2.1 Professional Ref - Stephen Sun 14.10.26', fileStage: F.completed, created: now - 7 * day, medReg: 'TEST999', link: '#' },
        { id: 't5', name: '1.2.1 Clinical Ref - Stephen Sun 14.10.26', fileStage: F.requested, status: 'missing', created: now - 7 * day, medReg: 'TEST999' }]
    };
    const db = MOCK.db;
    return new Promise((r) => setTimeout(r, 200)).then(() => {
      if (action === 'me') return { me: { name: 'Izzy Ferrada', email: 'izzy@blugibbon.com.au', cuId: 1, admin: false }, recruiters: null };
      if (action === 'doctors') return { doctors: db.doctors, waiting: db.docs.filter(inReview) };
      if (action === 'doctor') { const d = db.doctors.find((x) => x.id === p.doctorId); return { doctor: d, docs: db.docs.filter((x) => x.medReg === d.medReg) }; }
      if (action === 'review') {
        const d = db.docs.find((x) => x.id === p.taskId);
        d.reviewer = p.decision === 'approve' ? RV().approved : RV().rejected;
        if (p.decision === 'approve') { d.fileStage = F.filed; if (p.expiry) d.due = Date.parse(p.expiry); }
        return { ok: true };
      }
      if (action === 'submit') {
        p.files.forEach((f, i) => { const b = S.req.boxes.find((x) => x.id === f.boxId);
          db.docs.push({ id: 'n' + Date.now() + i, name: b.namePrefix + ' JOSH TEST', fileStage: F.new, docType: b.docTypeId, created: Date.now(), medReg: 'TEST999', link: '#', submittedBy: by.recruiter }); });
        return { count: p.files.length };
      }
      if (action === 'requestReferences') return { count: p.referees.length };
      throw new Error('mock: ' + action);
    });
  }
  start().catch((e) => { $('app').innerHTML = '<div class="card empty">Couldn’t load: ' + esc(e.message) + '</div>'; });
})();
