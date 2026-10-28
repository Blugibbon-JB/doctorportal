/* Blugibbon doctor document portal: documents page.
   Boxes come from requirements.json. Status comes from ClickUp (via the
   Firebase status copy) in live mode, or from SAMPLE below in mock mode. */
(function () {
  'use strict';
  const CFG = window.PORTAL_CONFIG;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- sample data (mock mode only) ----------
  const SAMPLE = {
    profile: { name: 'Josh Test', medReg: 'MED0001234567', recruiter: 'Izzy Ferrada', states: ['NSW', 'QLD'], level: 'Registrar' },
    status: {
      ahpra: { st: 'valid', exp: '30.09.27' }, indem: { st: 'expiring', exp: '14.11.26' }, degree: { st: 'valid' },
      cpd: { st: 'valid', exp: '13.04.28' }, cv: { st: 'valid' }, dl: { st: 'valid', exp: '30.09.27' },
      pp: { st: 'expired', exp: '02.10.26' }, ncrc: { st: 'valid', exp: '16.04.27' }, wwcc_qld: { st: 'valid', exp: '22.03.28' },
      nswstat: { st: 'review' }, mmr: { st: 'valid' }, hepb: { st: 'valid' }, vari: { st: 'valid' },
      dtpa: { st: 'valid', exp: '29.07.27' }, flu: { st: 'expiring', exp: '30.10.26' }
    },
    refs: [{ slot: 1, name: 'Stephen Sun', parts: { professional: 'done', clinical: 'received' } }],
    sent: [{ name: 'Stephen Sun', position: 'Director of Emergency', workplace: 'Westmead Hospital', requestedAt: Date.now() - 6 * 86400000 }]
  };

  const S = { req: null, profile: null, status: {}, staged: {}, choice: {}, open: 'base', busy: false, live: CFG.mode === 'live',
    refs: [], sent: [], refDraft: [blankRef()], refConsent: false, refBusy: false, refMsg: '' };
  function blankRef() { return { name: '', email: '', position: '', workplace: '', phone: '' }; }
  let pickTarget = null;

  // ---------- rules ----------
  const okStates = ['valid', 'expiring', 'review'];
  function applies(b) {
    const p = S.profile;
    if (b.states[0] !== 'ALL' && !b.states.some((s) => p.states.includes(s))) return false;
    if (b.excludeLevels && b.excludeLevels.includes(p.level)) return false;
    return true;
  }
  function isOptional(b) {
    if (b.requiredForLevels && b.requiredForLevels.includes(S.profile.level)) return false;
    return !!b.optional;
  }
  function stOf(b) { return (S.status[b.id] && S.status[b.id].st) || 'missing'; }
  function done(b) { return okStates.includes(stOf(b)); }
  function doctorUpper() { return S.profile.name.replace(/^Dr\.?\s+/i, '').trim().toUpperCase(); }
  function savedAs(b) {
    let prefix = b.namePrefix;
    if (b.kind === 'choice') {
      const o = b.options.find((x) => x.id === S.choice[b.id]) || b.options[0];
      prefix = o.namePrefix;
    }
    return prefix + ' ' + doctorUpper();
  }
  function hasExpiry(b) {
    if (b.kind === 'choice') { const o = b.options.find((x) => x.id === S.choice[b.id]) || b.options[0]; return o.expiry; }
    return b.expiry;
  }

  // ---------- pills ----------
  function pill(b) {
    const s = S.status[b.id] || {};
    const st = stOf(b);
    if ((S.staged[b.id] || []).some((f) => !f.err)) return ['Ready to submit', 'p-staged'];
    if (st === 'valid') return [s.exp ? 'Valid · exp ' + s.exp : 'Valid', 'p-valid'];
    if (st === 'expiring') return ['Expires ' + s.exp, 'p-expiring'];
    if (st === 'expired') return ['Expired ' + s.exp, 'p-expired'];
    if (st === 'review') return ['In review', 'p-review'];
    if (st === 'rejected') return ['Not accepted · upload again', 'p-expired'];
    if (isOptional(b)) return ['Not added', 'p-optional'];
    return ['Missing', 'p-missing'];
  }

  // ---------- render ----------
  function render() {
    const boxes = S.req.boxes.filter(applies);
    const req = boxes.filter((b) => !isOptional(b));
    const nValid = req.filter((b) => ['valid', 'expiring'].includes(stOf(b))).length;
    const nRev = req.filter((b) => stOf(b) === 'review').length;
    const pV = req.length ? Math.round(nValid / req.length * 100) : 0;
    const pR = req.length ? Math.round(nRev / req.length * 100) : 0;
    const count = (st) => boxes.filter((b) => stOf(b) === st && !(st === 'missing' && isOptional(b))).length;

    const ready = S.profile.states.map((st) => {
      const need = boxes.filter((b) => !isOptional(b) && (b.states[0] === 'ALL' || b.states.includes(st)) && !done(b)).length;
      return need ? '<span class="pill p-optional">' + esc(st) + ' · ' + need + ' to go</span>' : '<span class="pill p-valid"><b>' + esc(st) + ' ✓ ready</b></span>';
    }).join('') || '<span class="pill p-optional">Pick your states below</span>';

    let html = '<section class="card summary">' +
      '<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap"><h1>' + (pV + pR) + '% complete</h1>' +
      '<span class="hint">' + (nValid + nRev) + ' of ' + req.length + ' required documents provided</span></div>' +
      '<div class="track" aria-hidden="true"><i style="width:' + pV + '%;background:var(--green)"></i><i style="width:' + pR + '%;background:#A78BFA"></i></div>' +
      '<div class="pills">' +
      '<span class="pill p-valid"><b>' + count('valid') + '</b> valid</span>' +
      '<span class="pill p-review"><b>' + count('review') + '</b> in review</span>' +
      '<span class="pill p-expiring"><b>' + count('expiring') + '</b> expiring soon</span>' +
      '<span class="pill p-expired"><b>' + count('expired') + '</b> expired</span>' +
      '<span class="pill p-missing"><b>' + count('missing') + '</b> missing</span></div>' +
      '<div class="ready">Ready to work in: ' + ready + '</div></section>';

    S.req.sections.forEach((sec, i) => {
      const rows = boxes.filter((b) => b.section === sec.id);
      const rq = rows.filter((b) => !isOptional(b));
      const dn = rq.filter(done).length;
      const rc = refCounts();
      const pct = sec.id === 'refs' ? Math.min(100, Math.round(rc.got / rc.need * 100)) : (rq.length ? Math.round(dn / rq.length * 100) : 100);
      const complete = pct === 100;
      const open = S.open === sec.id;
      const sub = sec.id === 'state' ? (S.profile.states.join(', ') || 'No states picked') + ' · ' + S.profile.level : sec.sub;
      html += '<section class="card">' +
        '<button class="sec-h" type="button" data-sec="' + sec.id + '" aria-expanded="' + open + '">' +
        '<span class="num' + (complete ? ' done' : '') + '">' + (complete ? '✓' : i + 1) + '</span>' +
        '<span class="sec-t"><b>' + esc(sec.title) + '</b><span>' + esc(sub) + '</span></span>' +
        '<span class="hint" style="white-space:nowrap">' + (sec.id === 'refs' ? rc.got + ' of ' + rc.need + ' received' : dn + ' of ' + rq.length) + '</span>' +
        '<span class="mini"><i style="width:' + pct + '%;' + (complete ? 'background:var(--green)' : '') + '"></i></span>' +
        '<span class="chev" aria-hidden="true">' + (open ? '–' : '+') + '</span></button>';
      if (open) {
        html += '<div class="sec-b">';
        if (sec.id === 'state') html += prefsHtml();
        if (sec.id === 'refs') html += refsHtml();
        html += rows.map(rowHtml).join('');
        if (sec.id === 'state' && !rows.length) html += '<div class="note">Pick at least one state above to see its documents.</div>';
        if (sec.id === 'vacc') html += '<div class="note">Got everything on one immunisation history? Use the "Full vaccination record" box and your reviewer will split it out.</div>';
        html += '</div>';
      }
      html += '</section>';
    });
    html += '<p class="foot">Files go straight to Blugibbon’s secure Google Drive and are named for you. This page only shows file names and status. Expiry dates are checked by our team when they review your documents.</p>';
    $('app').innerHTML = html;

    const staged = Object.values(S.staged).flat().filter((f) => !f.err);
    $('tray').classList.toggle('hidden', !staged.length);
    $('trayText').textContent = staged.length + (staged.length === 1 ? ' file ready' : ' files ready');
    $('submitBtn').disabled = S.busy;
    $('submitBtn').textContent = S.busy ? 'Sending…' : 'Submit for review';
  }

  // ---------- references ----------
  const refCfg = () => Object.assign({ required: 2, max: 3 }, S.req.references || {});
  const refPartsDone = (r) => Object.values(r.parts).length && Object.values(r.parts).every((p) => p !== 'waiting');
  function refCounts() { return { got: S.refs.filter(refPartsDone).length, need: refCfg().required }; }
  function refsOnFile() {
    // ClickUp reference tasks, with the details the doctor typed matched on by name.
    const lc = (x) => String(x || '').trim().toLowerCase();
    const list = S.refs.map((r) => Object.assign({}, r, { info: S.sent.find((x) => lc(x.name) === lc(r.name)) || null }));
    S.sent.forEach((x) => {
      if (!list.some((r) => lc(r.name) === lc(x.name)) && Date.now() - x.requestedAt < 30 * 60 * 1000)
        list.push({ slot: 9, name: x.name, parts: {}, info: x, sending: true });
    });
    return list;
  }
  function refsHtml() {
    const cfg = refCfg(), onFile = refsOnFile(), left = Math.max(0, cfg.max - onFile.length);
    const label = { waiting: ['Waiting on referee', 'p-optional'], received: ['Received · in review', 'p-review'], done: ['Verified', 'p-valid'] };
    let h = onFile.map((r) => {
      const pills = r.sending ? '<span class="pill p-optional">Sending request…</span>' : Object.keys(r.parts).sort().map((t) =>
        '<span class="pill ' + label[r.parts[t]][1] + '">' + (t === 'clinical' ? 'Clinical' : 'Professional') + ': ' + label[r.parts[t]][0] + '</span>').join('');
      const sub = r.info ? esc([r.info.position, r.info.workplace].filter(Boolean).join(', ')) : 'Referee ' + r.slot;
      return '<div class="row"><div class="r-main"><div class="r-t"><b>' + esc(r.name || 'Referee') + '</b></div><span class="hint">' + sub + '</span></div>' +
        '<div class="refpills">' + pills + '</div></div>';
    }).join('');
    if (!onFile.length) h += '<div class="note">We need references from <b>' + cfg.required + '</b> senior colleagues who have supervised your work, ideally in the last 12 months. Add them below and we’ll email each one a short form.</div>';
    const got = S.refs.filter(refPartsDone).length;
    if (cfg.minimum && got >= cfg.minimum && got < cfg.required) h += '<div class="note">' + got + ' references may be enough for some roles. ' + esc(S.profile.recruiter) + ' will confirm, or add one more below.</div>';
    if (!left) return h + '<div class="note">You have ' + cfg.max + ' referees on file. If you need to change one, contact ' + esc(S.profile.recruiter) + '.</div>';

    S.refDraft = S.refDraft.slice(0, left);
    const f = (i, k, lbl, type, ph) => '<label>' + lbl + '<input data-rf="' + i + ':' + k + '" type="' + type + '" value="' + esc(S.refDraft[i][k]) + '" placeholder="' + ph + '" autocomplete="off"' + (S.refBusy ? ' disabled' : '') + '></label>';
    h += '<div class="refform">';
    S.refDraft.forEach((r, i) => {
      h += '<div class="rf">' + (S.refDraft.length > 1 ? '<button class="x" type="button" aria-label="Remove referee" data-refrm="' + i + '">×</button>' : '') +
        f(i, 'name', 'Referee name', 'text', 'e.g. Stephen Sun') + f(i, 'email', 'Email', 'email', 'name@hospital.org.au') +
        f(i, 'position', 'Their position', 'text', 'e.g. Director of Emergency') + f(i, 'workplace', 'Hospital or practice', 'text', 'Where you worked together') +
        f(i, 'phone', 'Phone (optional)', 'tel', 'Best number for them') + '</div>';
    });
    if (S.refDraft.length < left) h += '<button class="btn" type="button" data-refadd="1">+ Add another referee</button>';
    h += '<label class="consent"><input type="checkbox" data-refconsent="1"' + (S.refConsent ? ' checked' : '') + '> <span>I give Blugibbon permission to contact these referees about my work, and I’ve let them know to expect an email from hello@blugibbon.com.au.</span></label>' +
      '<button class="btn primary" type="button" data-refsend="1"' + (S.refBusy ? ' disabled' : '') + '>' + (S.refBusy ? 'Sending…' : 'Send reference requests') + '</button>' +
      '<span class="hint">Each referee gets a professional and a clinical reference form. ' + esc(S.profile.recruiter) + ' is told when you send them.</span>' +
      (S.refMsg ? '<p class="hint" role="status" style="color:var(--red,#B91C1C)">' + esc(S.refMsg) + '</p>' : '') + '</div>';
    return h;
  }
  async function sendRefs() {
    const rows = S.refDraft.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v).trim()]))).filter((r) => r.name || r.email);
    const bad = !rows.length ? 'Please add at least one referee.'
      : rows.map((r) => !r.name ? 'Each referee needs a name.' : !/^\S+@\S+\.\S+$/.test(r.email) ? 'Please check the email for ' + r.name + '.'
        : (!r.position || !r.workplace) ? 'Please add the position and hospital or practice for ' + r.name + '.' : '').find(Boolean)
      || (!S.refConsent ? 'Please tick the box to give us permission to contact your referees.' : '');
    if (bad) { S.refMsg = bad; render(); return; }
    S.refBusy = true; S.refMsg = ''; render();
    try {
      if (S.live) await window.PortalAuth.call('requestReferences', { referees: rows, consent: true });
      else { await new Promise((r) => setTimeout(r, 600)); rows.forEach((r) => S.sent.push(Object.assign({ requestedAt: Date.now() }, r))); }
      S.refDraft = [blankRef()]; S.refConsent = false;
      toast('Reference request' + (rows.length > 1 ? 's' : '') + ' sent. We’ll let you know when they come back.');
    } catch (e) { S.refMsg = e.message.replace(/^.*?:\s*/, ''); }
    S.refBusy = false; render();
  }

  function prefsHtml() {
    const st = S.req.states.map((s) => '<button class="tog" type="button" data-state="' + s + '" aria-pressed="' + S.profile.states.includes(s) + '">' + s + '</button>').join('');
    const lv = S.req.levels.map((l) => '<button class="tog" type="button" data-level="' + esc(l) + '" aria-pressed="' + (S.profile.level === l) + '">' + esc(l) + '</button>').join('');
    return '<div class="prefs"><div style="display:flex;flex-direction:column;gap:8px"><b>Which states do you want to work in?</b><div class="pills">' + st + '</div></div>' +
      '<div style="display:flex;flex-direction:column;gap:8px"><b>Your level</b><div class="pills">' + lv + '</div></div>' +
      '<span class="hint">These decide which boxes show. Change them any time and nothing already uploaded is lost.</span></div>';
  }

  function rowHtml(b) {
    const [label, cls] = pill(b);
    const files = S.staged[b.id] || [];
    const st = stOf(b);
    const isForm = b.kind === 'form';
    let tags = '';
    if (isOptional(b)) tags += '<span class="tag p-optional">if applicable</span>';
    if (isForm) tags += '<span class="tag p-form">form to sign</span>';
    if (b.multi) tags += '<span class="tag p-optional">add several</span>';
    let choice = '';
    if (b.kind === 'choice') {
      choice = '<label class="hint">Which document? <select class="choice" data-choice="' + b.id + '">' +
        b.options.map((o) => '<option value="' + o.id + '"' + (S.choice[b.id] === o.id ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') + '</select></label>';
    }
    const fileList = files.length ? '<div class="files">' + files.map((f, i) =>
      '<span class="file' + (f.err ? ' err' : '') + '">' + esc(f.err ? f.name + ': ' + f.err : f.name + ' · ' + kb(f.size)) +
      '<button type="button" aria-label="Remove ' + esc(f.name) + '" data-rm="' + b.id + ':' + i + '">×</button></span>').join('') + '</div>' : '';
    const saved = isForm ? 'Completed online. Filed for you as ' + esc(b.namePrefix) + '…'
      : 'Saved as ' + esc(savedAs(b)) + (hasExpiry(b) ? ' (expiry added at review)' : '');
    let action;
    if (isForm) action = '<a class="act form" href="' + esc(b.formUrl) + '" target="_blank" rel="noopener">Open form ↗</a>';
    else {
      const needs = ['missing', 'expired', 'expiring', 'rejected'].includes(st);
      const txt = files.length && !b.multi ? 'Replace file' : (files.length ? 'Add another' : (st === 'missing' ? 'Upload' : (needs ? 'Upload new' : 'Replace')));
      action = '<button class="act' + (needs || files.length ? ' go' : '') + '" type="button" data-up="' + b.id + '">' + txt + '</button>';
    }
    return '<div class="row" data-drop="' + (isForm ? '' : b.id) + '">' +
      '<div class="r-main"><div class="r-t"><b>' + esc(b.label) + '</b>' + tags + '</div>' +
      '<span class="hint">' + esc(b.hint) + '</span>' + choice + fileList + '<span class="saved">' + saved + '</span></div>' +
      '<span class="pill ' + cls + '">' + esc(label) + '</span>' + action + '</div>';
  }

  const kb = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  // ---------- files ----------
  async function addFiles(boxId, list) {
    const b = S.req.boxes.find((x) => x.id === boxId);
    if (!b) return;
    let arr = Array.from(list);
    if (!b.multi) arr = arr.slice(0, 1);
    const prepared = [];
    for (const f of arr) prepared.push(await prepare(f));
    S.staged[boxId] = b.multi ? (S.staged[boxId] || []).concat(prepared) : prepared;
    render();
  }

  // Photos over the limit are shrunk in the browser; other big files are refused.
  async function prepare(file) {
    const max = CFG.maxUploadBytes;
    const item = { name: file.name, size: file.size, file: file, err: '' };
    if (file.size <= max) return item;
    if (/^image\/(jpeg|png|webp)$/.test(file.type)) {
      try {
        const small = await shrinkImage(file, max);
        return { name: file.name.replace(/\.\w+$/, '') + '.jpg', size: small.size, file: small, err: '' };
      } catch (e) { /* fall through */ }
    }
    item.err = 'too big (max ' + kb(max) + '). Try a smaller scan or send it to your recruiter';
    return item;
  }
  function shrinkImage(file, max) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth, h = img.naturalHeight, scale = Math.min(1, 2400 / Math.max(w, h));
        const c = document.createElement('canvas');
        const tryQ = (q) => {
          c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          c.toBlob((blob) => {
            if (!blob) return reject(new Error('shrink failed'));
            if (blob.size <= max || q < 0.45) return blob.size <= max ? resolve(blob) : reject(new Error('still too big'));
            scale *= 0.85; tryQ(q - 0.1);
          }, 'image/jpeg', q);
        };
        tryQ(0.85);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => reject(new Error('not an image'));
      img.src = URL.createObjectURL(file);
    });
  }

  // After a submit: what arrived, and what's still to do (by section), e.g. "please continue with your vaccinations and references".
  function receivedMessage(n) {
    const SECTION = { base: 'baseline documents', state: 'state documents', vacc: 'vaccinations', refs: 'references' };
    const todo = [];
    S.req.sections.forEach((sec) => {
      if (sec.id === 'refs') { if ((S.sent || []).length < refCfg().required) todo.push(SECTION.refs); return; }
      const open = S.req.boxes.filter((b) => b.section === sec.id && applies(b) && !isOptional(b))
        .some((b) => ['missing', 'expired', 'rejected'].includes(stOf(b)));
      if (open) todo.push(SECTION[sec.id] || String(sec.label || sec.id).toLowerCase());
    });
    const list = todo.length > 1 ? todo.slice(0, -1).join(', ') + ' and ' + todo[todo.length - 1] : todo[0];
    return '✓ ' + n + (n === 1 ? ' file' : ' files') + ' received. ' + (n === 1 ? 'It' : 'These') + ' will be checked by our support team, and you’ll be notified when ' +
      (n === 1 ? 'it has' : 'they have') + ' been approved. ' + (todo.length ? 'Please continue with your ' + list + '.' : '');
  }

  // ---------- submit ----------
  async function submit() {
    const items = [];
    Object.keys(S.staged).forEach((id) => S.staged[id].forEach((f) => { if (!f.err) items.push({ id, f }); }));
    if (!items.length) return;
    S.busy = true; render();
    try {
      if (S.live) await submitLive(items);
      else await new Promise((r) => setTimeout(r, 700));
      const ids = [...new Set(items.map((x) => x.id))];
      ids.forEach((id) => { S.status[id] = { st: 'review' }; delete S.staged[id]; });
      if (S.live) window.PortalAuth.savePrefs(S.profile);
      toast(receivedMessage(items.length), 20000);
    } catch (e) {
      toast('Something went wrong sending your files. Nothing was lost. Please try again. (' + e.message + ')');
    }
    S.busy = false; render();
  }

  // Live path: each file goes straight to the doctor's Drive folder through a
  // one-time upload link, then one submit call creates the ClickUp tasks.
  async function submitLive(items) {
    const uploaded = new Array(items.length);
    let n = 0;
    const btn = $('submitBtn'), tray = $('trayText');
    const show = () => { btn.textContent = 'Uploading ' + n + ' of ' + items.length + '…'; tray.textContent = 'Please keep this page open while your files upload'; };
    show();
    const one = async (k) => {
      const { id, f } = items[k];
      const fileId = await window.PortalAuth.upload(id, S.choice[id] || null, f.file, f.name);
      uploaded[k] = { boxId: id, choice: S.choice[id] || null, fileId, fileName: f.name };
      n++; show();
    };
    for (let k = 0; k < items.length; k += 4) await Promise.all(items.slice(k, k + 4).map((x, j) => one(k + j))); // 4 at a time
    btn.textContent = 'Saving…';
    await window.PortalAuth.call('submit', { states: S.profile.states, level: S.profile.level, files: uploaded });
  }

  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), ms || 5000);
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button,a'); if (!el) return;
    if (el.dataset.sec) { S.open = S.open === el.dataset.sec ? '' : el.dataset.sec; render(); }
    else if (el.dataset.state) {
      const s = el.dataset.state, p = S.profile;
      p.states = p.states.includes(s) ? p.states.filter((x) => x !== s) : p.states.concat([s]);
      if (S.live) window.PortalAuth.savePrefs(p); render();
    } else if (el.dataset.level) { S.profile.level = el.dataset.level; if (S.live) window.PortalAuth.savePrefs(S.profile); render(); }
    else if (el.dataset.up) {
      const b = S.req.boxes.find((x) => x.id === el.dataset.up);
      pickTarget = b.id; $('picker').multiple = !!b.multi; $('picker').value = ''; $('picker').click();
    } else if (el.dataset.refadd) { S.refDraft.push(blankRef()); render(); }
    else if (el.dataset.refrm) { S.refDraft.splice(+el.dataset.refrm, 1); render(); }
    else if (el.dataset.refsend) { sendRefs(); }
    else if (el.dataset.rm) {
      const [id, i] = el.dataset.rm.split(':'); S.staged[id].splice(+i, 1);
      if (!S.staged[id].length) delete S.staged[id]; render();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.dataset && e.target.dataset.choice) { S.choice[e.target.dataset.choice] = e.target.value; render(); }
    if (e.target.dataset && e.target.dataset.refconsent) S.refConsent = e.target.checked;
  });
  // Typed referee details live in S.refDraft so a re-render (e.g. a ClickUp update) doesn't wipe them.
  document.addEventListener('input', (e) => {
    const k = e.target.dataset && e.target.dataset.rf; if (!k) return;
    const [i, f] = k.split(':'); if (S.refDraft[+i]) S.refDraft[+i][f] = e.target.value;
  });
  $('picker').addEventListener('change', (e) => { if (pickTarget && e.target.files.length) addFiles(pickTarget, e.target.files); });
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => {
    const row = e.target.closest && e.target.closest('[data-drop]');
    if (!row || !row.dataset.drop) return;
    e.preventDefault(); row.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
    const row = e.target.closest && e.target.closest('[data-drop]');
    if (row) row.classList.remove('drag');
    if (t === 'drop') {
      e.preventDefault();
      if (row && row.dataset.drop && e.dataTransfer.files.length) addFiles(row.dataset.drop, e.dataTransfer.files);
    }
  }));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  $('submitBtn').addEventListener('click', submit);
  $('clearBtn').addEventListener('click', () => { S.staged = {}; render(); });
  window.addEventListener('beforeunload', (e) => { if (Object.keys(S.staged).length) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- start ----------
  async function start() {
    S.req = await (await fetch('requirements.json', { cache: 'no-cache' })).json();
    if (S.live) {
      const data = await window.PortalAuth.load(S.req, (s) => { S.status = s.status; Object.assign(S.choice, s.choice); S.refs = s.refs || []; S.sent = s.sent || []; render(); });
      S.profile = data.profile; S.status = data.status || {}; Object.assign(S.choice, data.choice); S.refs = data.refs || []; S.sent = data.sent || [];
      $('recruiter').insertAdjacentHTML('afterend', ' <a href="#" id="outLink" style="font-size:13px">Sign out</a>');
      $('outLink').onclick = (e) => { e.preventDefault(); window.PortalAuth.signOut(); };
    } else {
      S.profile = JSON.parse(JSON.stringify(SAMPLE.profile)); S.status = JSON.parse(JSON.stringify(SAMPLE.status));
      S.refs = JSON.parse(JSON.stringify(SAMPLE.refs)); S.sent = JSON.parse(JSON.stringify(SAMPLE.sent));
      $('mockTag').classList.remove('hidden');
    }
    $('whoLine').textContent = 'Dr ' + S.profile.name + ' · ' + S.profile.medReg;
    $('recruiter').innerHTML = 'Your recruiter: <b>' + esc(S.profile.recruiter) + '</b>';
    render();
  }
  start().catch((e) => { $('app').innerHTML = '<div class="card summary">Couldn’t load the portal: ' + esc(e.message) + '</div>'; });
})();
