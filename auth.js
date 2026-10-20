/* Sign-in, rego linking and the live status copy (Firebase). Only used when
   PORTAL_CONFIG.mode === 'live'. Exposes window.PortalAuth for app.js. */
(function () {
  'use strict';
  const CFG = window.PORTAL_CONFIG;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let fb, auth, db, fns;

  function init() {
    fb = firebase.initializeApp(CFG.firebase, 'portal');
    auth = fb.auth(); db = fb.database(); fns = fb.functions('australia-southeast1');
  }
  const call = async (name, data) => (await fns.httpsCallable(name)(data || {})).data;
  const niceErr = (e) => (e && e.message ? e.message.replace(/^.*?:\s*/, '') : 'Something went wrong. Please try again.');

  // ---------- screens ----------
  function screen(inner) {
    $('whoLine').textContent = auth && auth.currentUser ? 'Signed in as ' + (auth.currentUser.email || '') : 'Please sign in';
    $('app').innerHTML = '<section class="card summary" style="max-width:440px;margin:24px auto">' + inner + '</section>';
  }
  function signInScreen(msg) {
    screen('<h1>Your compliance, in one place</h1><p class="hint">Upload your documents once and see what’s done, missing or about to expire.</p>' +
      '<button class="btn" id="gBtn" type="button" style="height:50px;font-weight:600">Continue with Google</button>' +
      '<label class="hint" for="emailIn">Or get a sign-in link by email</label>' +
      '<input id="emailIn" type="email" autocomplete="email" placeholder="you@example.com" style="height:46px;border-radius:8px;border:1px solid var(--line2);padding:0 12px;font:inherit;background:var(--card);color:var(--text)">' +
      '<button class="btn" id="eBtn" type="button">Email me a link</button>' +
      '<p class="hint" id="msg" role="status">' + esc(msg || '') + '</p>');
    $('gBtn').onclick = () => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch((e) => ($('msg').textContent = niceErr(e)));
    $('eBtn').onclick = async () => {
      const email = $('emailIn').value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) { $('msg').textContent = 'Please enter your email address.'; return; }
      try {
        await auth.sendSignInLinkToEmail(email, { url: location.href.split('?')[0], handleCodeInApp: true });
        localStorageSafe('set', 'portalEmail', email);
        $('msg').textContent = 'Check your inbox for a sign-in link from Blugibbon.';
      } catch (e) { $('msg').textContent = niceErr(e); }
    };
  }
  function linkScreen(resolve) {
    screen('<h1>Link your AHPRA registration</h1><p class="hint">This connects your sign-in to your Blugibbon file. You only do it once.</p>' +
      '<label class="hint" for="rego"><b>AHPRA registration number</b></label>' +
      '<input id="rego" placeholder="MED0001234567" autocomplete="off" style="height:48px;border-radius:8px;border:1px solid var(--line2);padding:0 12px;font:inherit;font-size:16px;letter-spacing:.04em;background:var(--card);color:var(--text)">' +
      '<button class="btn primary" id="sendBtn" type="button">Send my code</button>' +
      '<p class="hint">We’ll email a 6-digit code to the address we have on file for this registration.</p><p class="hint" id="msg" role="status"></p>' +
      '<button class="btn" id="outBtn" type="button">Use a different sign-in</button>');
    $('outBtn').onclick = () => auth.signOut();
    $('sendBtn').onclick = async () => {
      $('sendBtn').disabled = true; $('msg').textContent = 'Sending…';
      try { const r = await call('linkStart', { medReg: $('rego').value }); codeScreen(resolve, r.sentTo); }
      catch (e) { $('msg').textContent = niceErr(e); $('sendBtn').disabled = false; }
    };
  }
  function codeScreen(resolve, sentTo) {
    screen('<h1>Check your email</h1><p class="hint">We sent a code to <b>' + esc(sentTo) + '</b></p>' +
      '<label class="hint" for="code"><b>6-digit code</b></label>' +
      '<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" style="height:56px;border-radius:8px;border:1px solid var(--line2);padding:0 12px;font:inherit;font-size:24px;letter-spacing:.3em;text-align:center;background:var(--card);color:var(--text)">' +
      '<button class="btn primary" id="okBtn" type="button">Confirm</button><p class="hint" id="msg" role="status"></p>' +
      '<p class="hint">Wrong email or no access? Ask your recruiter to update it in your profile.</p>');
    $('okBtn').onclick = async () => {
      $('okBtn').disabled = true; $('msg').textContent = 'Checking…';
      try { resolve(await call('linkVerify', { code: $('code').value })); }
      catch (e) { $('msg').textContent = niceErr(e); $('okBtn').disabled = false; }
    };
  }

  function localStorageSafe(op, k, v) { try { return op === 'set' ? localStorage.setItem(k, v) : op === 'del' ? localStorage.removeItem(k) : localStorage.getItem(k); } catch (e) { return null; } }

  // Finishes an emailed sign-in link if this page was opened from one.
  async function finishEmailLink() {
    if (!auth.isSignInWithEmailLink(location.href)) return;
    let email = localStorageSafe('get', 'portalEmail') || window.prompt('Please confirm your email address');
    if (!email) return;
    await auth.signInWithEmailLink(email, location.href);
    localStorageSafe('del', 'portalEmail');
    history.replaceState(null, '', location.pathname);
  }

  // ---------- status copy -> box status ----------
  function toStatus(req, docs) {
    const S = req.clickup.fileStageOptions;
    const skip = [S.archived, S.doctorRecord, S.formResponse, S.processed];
    const ddmmyy = (ms) => { const d = new Date(ms); return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + String(d.getFullYear()).slice(-2); };
    const list = Object.values(docs || {}).filter((d) => !skip.includes(d.fileStage));
    const status = {}, choice = {};
    req.boxes.forEach((b) => {
      const types = b.kind === 'choice' ? b.options.map((o) => o.docTypeId) : [b.docTypeId];
      const hit = list.filter((d) => (b.docTypeId || b.kind === 'choice' ? types.includes(d.docType) : String(d.name || '').startsWith(b.namePrefix)) &&
        (!b.stateOptionId || d.state === b.stateOptionId)).sort((x, y) => y.created - x.created)[0];
      if (!hit) return;
      let st = 'valid';
      const now = Date.now(), soon = now + 30 * 86400000; // the expiry date wins over a stale ClickUp status
      if ((hit.fileStage === S.new || hit.fileStage === S.renewed) && hit.reviewer === req.clickup.reviewerOptions.rejected) st = 'rejected';
      else if (hit.fileStage === S.new || hit.fileStage === S.renewed) st = 'review';
      else if ((hit.due && hit.due < now) || /expired/i.test(hit.status)) st = 'expired';
      else if ((hit.due && hit.due < soon) || /expiring/i.test(hit.status)) st = 'expiring';
      else if (/missing/i.test(hit.status)) st = 'missing';
      status[b.id] = { st, exp: hit.due ? ddmmyy(hit.due) : '' };
      if (b.kind === 'choice') { const o = b.options.find((x) => x.docTypeId === hit.docType); if (o) choice[b.id] = o.id; }
    });
    return { status, choice, refs: buildRefs(docs) };
  }

  // Reference tasks made by Scenario 4 ("1.2.N Professional Ref - Name DD.MM.YY" or the NSW combined
  // "2.4 NSW … 1.2.N - Name DD.MM.YY"), grouped into one entry per referee slot.
  function buildRefs(docs) {
    const S = window.PORTAL_REQ.clickup.fileStageOptions;
    const bySlot = {};
    Object.values(docs || {}).forEach((d) => {
      const m = /(?:^|\s)1\.2\.([1-3])\s/.exec(d.name || '');
      if (!m || d.fileStage === S.archived) return;
      const slot = Number(m[1]);
      const e = bySlot[slot] || (bySlot[slot] = { slot, name: '', parts: {}, created: d.created });
      const after = String(d.name).split(' - ')[1];
      if (after && !e.name) e.name = after.replace(/\s+\d{2}\.\d{2}\.\d{2}.*$/, '').trim();
      const type = /clinical/i.test(d.name) ? 'clinical' : 'professional';
      const st = d.fileStage === S.filed ? 'done' : d.fileStage === S.completed ? 'received' : 'waiting';
      e.parts[type] = st;
    });
    return Object.values(bySlot).sort((a, b) => a.slot - b.slot);
  }

  // ---------- public ----------
  window.PortalAuth = {
    // Resolves with { profile, status, choice } once signed in + linked; onChange fires on every ClickUp update.
    load(req, onChange) {
      init();
      return new Promise((resolve) => {
        finishEmailLink().catch((e) => signInScreen(niceErr(e)));
        auth.onAuthStateChanged(async (u) => {
          if (!u) return signInScreen();
          let user = (await db.ref('portal/users/' + u.uid).get()).val();
          if (!user) user = await new Promise((r) => linkScreen(r));
          const profile = { name: user.name, medReg: user.medReg, recruiter: user.recruiter,
            states: JSON.parse(localStorageSafe('get', 'portalStates') || '["NSW"]'), level: localStorageSafe('get', 'portalLevel') || 'Registrar' };
          window.PORTAL_REQ = req;
          let first = true, docs = null, sent = null, gotDocs = false;
          const emit = () => {
            if (!gotDocs) return;
            const s = Object.assign(toStatus(req, docs), { sent: Object.values(sent || {}) });
            if (first) { first = false; resolve(Object.assign({ profile }, s)); } else onChange(s);
          };
          db.ref('portal/docs/' + user.medKey).on('value', (snap) => { docs = snap.val(); gotDocs = true; emit(); });
          db.ref('portal/users/' + u.uid + '/refs').on('value', (snap) => { sent = snap.val(); emit(); });
          call('refreshMyStatus').catch(() => {});
        });
      });
    },
    savePrefs(p) { localStorageSafe('set', 'portalStates', JSON.stringify(p.states)); localStorageSafe('set', 'portalLevel', p.level); },
    signOut: () => auth.signOut().then(() => location.reload()),
    call,
    // Sends one file straight to Google Drive through a one-time upload link.
    async upload(boxId, choice, file, name) {
      const { uploadUrl } = await call('startUpload', { boxId, choice, fileName: name, mimeType: file.type || 'application/octet-stream', size: file.size });
      const res = await fetch(uploadUrl, { method: 'PUT', body: file });
      if (!res.ok) throw new Error('Upload failed (' + res.status + ')');
      return (await res.json()).id;
    }
  };
})();
