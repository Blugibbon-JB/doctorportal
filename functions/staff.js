// Staff view backend: one callable, `staff`, with an `action`. Only verified
// @blugibbon.com.au Google sign-ins get in, and each recruiter can only act on
// doctors assigned to them in ClickUp. Admins can switch to another recruiter.
'use strict';
const { onCall } = require('firebase-functions/v2/https');

const ADMINS = ['josh@blugibbon.com.au', 'gerard@blugibbon.com.au'];
const REVIEW_STAGES = ['new', 'renewed', 'completed']; // waiting on a reviewer (completed = a reference came back)
const TEMPLATES = ['professional', 'clinical', 'combined'];

module.exports = (d) => {
  const { db, CU, G, REQ, fail, key, upperName, CLICKUP_TOKEN, REF_REQUEST_WEBHOOK } = d;

  async function whoAmI(req, cu) {
    const t = (req.auth && req.auth.token) || {};
    const email = String(t.email || '').toLowerCase();
    if (!t.email_verified || !/@blugibbon\.com\.au$/.test(email)) fail('permission-denied', 'The staff view is for Blugibbon staff accounts only.');
    const me = (await cu.members()).find((u) => String(u.email || '').toLowerCase() === email);
    if (!me) fail('permission-denied', 'No ClickUp account found for ' + email + '.');
    return { email, cuId: me.id, name: me.username, admin: ADMINS.includes(email) };
  }

  // Loads a doctor and checks the staff member may work on them.
  async function doctorFor(cu, me, doctorId) {
    const doc = await cu.get('task/' + String(doctorId || '').replace(/[^a-z0-9]/gi, ''));
    if (!CU.DOCTOR_LISTS.includes(String(doc.list && doc.list.id))) fail('invalid-argument', 'That isn’t a doctor record.');
    if (!me.admin && !(doc.assignees || []).some((a) => a.id === me.cuId)) fail('permission-denied', 'That doctor isn’t assigned to you.');
    const medReg = CU.field(doc, CU.F.medReg);
    if (!medReg) fail('failed-precondition', 'This doctor has no Med Reg # in ClickUp yet.');
    const cachePath = 'portal/staffCache/' + doc.id;
    const cache = (await db.ref(cachePath).get()).val() || {};
    return { doc, cachePath, user: { medReg, medKey: key(medReg), doctorId: doc.id, name: doc.name.trim(), inboxId: cache.inboxId,
      recruiter: ((doc.assignees || [])[0] || {}).username || '' } };
  }
  const brief = (t) => ({ id: t.id, name: t.name.trim(), medReg: CU.field(t, CU.F.medReg) || '', email: CU.field(t, CU.F.email) || '',
    status: (t.status && t.status.status) || '', assignee: ((t.assignees || [])[0] || {}).username || '' });
  const taskDoc = (t) => ({ id: t.id, name: t.name, status: (t.status && t.status.status) || '', fileStage: CU.dropdownId(t, CU.F.fileStage),
    docType: CU.dropdownId(t, CU.F.docType), state: CU.dropdownId(t, CU.F.state), reviewer: CU.dropdownId(t, CU.F.reviewer),
    submittedBy: CU.dropdownId(t, CU.F.submittedBy), due: t.due_date ? Number(t.due_date) : null, created: Number(t.date_created || 0),
    link: CU.field(t, CU.F.gdrive) || '', medReg: CU.field(t, CU.F.medReg) || '' });
  const docLabel = (t, user) => { // the box label the doctor saw, else the task name without their name
    const dt = CU.dropdownId(t, CU.F.docType);
    const b = REQ.boxes.find((x) => x.docTypeId === dt || (x.options || []).some((o) => o.docTypeId === dt));
    const o = b && b.kind === 'choice' ? b.options.find((x) => x.docTypeId === dt) : null;
    return (o && o.label) || (b && b.label) || t.name.replace(upperName(user.name), '').replace(/\s+/g, ' ').trim();
  };
  const sydneyMidday = (ymd) => { // expiry dates are whole days; noon Sydney avoids landing on the day before in UTC
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) fail('invalid-argument', 'Please enter the expiry date.');
    return Date.UTC(+m[1], +m[2] - 1, +m[3], 1, 0, 0);
  };

  const actions = {
    async me(cu, me) {
      return { me, recruiters: me.admin ? (await cu.members()).filter((u) => /@blugibbon\.com\.au$/i.test(u.email || ''))
        .map((u) => ({ id: u.id, name: u.username })).sort((a, b) => String(a.name).localeCompare(b.name)) : null };
    },

    // My doctors + everything of theirs waiting for review.
    async doctors(cu, me, p) {
      const who = me.admin && p.recruiterId ? Number(p.recruiterId) : me.cuId;
      const doctors = (await cu.doctorsFor(who)).map(brief).filter((x) => x.medReg);
      const regs = new Set(doctors.map((x) => x.medReg));
      const waiting = [];
      for (const st of REVIEW_STAGES) {
        (await cu.byStage(CU.STAGE[st])).forEach((t) => {
          const x = taskDoc(t);
          if (regs.has(x.medReg) && x.reviewer !== CU.REVIEW.approved && x.reviewer !== CU.REVIEW.rejected && t.parent) waiting.push(x);
        });
      }
      waiting.sort((a, b) => b.created - a.created);
      return { doctors: doctors.sort((a, b) => a.name.localeCompare(b.name)), waiting };
    },

    async doctor(cu, me, p) {
      const { doc, user } = await doctorFor(cu, me, p.doctorId);
      const docs = (await cu.listDocs(user.medReg)).filter((t) => t.parent).map(taskDoc);
      return { doctor: Object.assign(brief(doc), { folder: CU.field(doc, CU.F.gdrive) || '' }), docs };
    },

    // Approve (with expiry where the box has one) or reject. Approving sets "Reviewer Approved?", which
    // fires the same ClickUp automation as approving in ClickUp, so Filing (2 / 2V) runs exactly as now.
    async review(cu, me, p) {
      const t = await cu.get('task/' + String(p.taskId || '').replace(/[^a-z0-9]/gi, ''));
      const x = taskDoc(t);
      const docRec = await cu.findDoctor(x.medReg);
      if (!docRec) fail('not-found', 'Couldn’t find the doctor for this document.');
      const { user } = await doctorFor(cu, me, docRec.id);
      if (!REVIEW_STAGES.some((s) => CU.STAGE[s] === x.fileStage)) fail('failed-precondition', 'This document isn’t waiting for review.');
      if (p.decision === 'approve') {
        if (p.expiry) await cu.put('task/' + t.id, { due_date: sydneyMidday(p.expiry), due_date_time: false });
        await cu.setField(t.id, CU.F.reviewer, CU.REVIEW.approved);
        await cu.post('task/' + t.id + '/comment', { notify_all: false, comment_text: 'Approved in the portal by ' + me.name +
          (p.expiry ? ' · expiry ' + p.expiry.split('-').reverse().join('/') : '') + '.' }).catch(() => {});
      } else if (p.decision === 'reject') {
        const reason = String(p.reason || '').replace(/[<>]/g, '').trim().slice(0, 300);
        if (!reason) fail('invalid-argument', 'Please say why, so the doctor knows what to send instead.');
        await cu.setField(t.id, CU.F.reviewer, CU.REVIEW.rejected);
        await cu.post('task/' + t.id + '/comment', { notify_all: false, comment_text: 'Rejected in the portal by ' + me.name + ': ' + reason }).catch(() => {});
        const email = CU.field(docRec, CU.F.email);
        if (email && p.notify !== false) {
          await G.sendMail(email, 'Please re-upload a document for Blugibbon',
            'Hi Dr ' + user.name + ',\n\nThanks for sending your documents. We couldn’t accept your ' + docLabel(t, user) + ':\n\n' + reason +
            '\n\nPlease upload a new copy in your documents portal:\n' + 'https://blugibbon-jb.github.io/doctorportal/' +
            '\n\nAny questions, just reply to this email or call us on 02 8960 6445.\n\n' + me.name + '\nBlugibbon Medical Recruitment').catch((e) => console.error('reject mail', e.message));
        }
      } else fail('invalid-argument', 'Unknown decision.');
      await d.refreshDocs(cu, user);
      return { ok: true };
    },

    // Upload on a doctor's behalf: same Drive folder and ClickUp tasks as the doctor, marked Submitted By: Recruiter.
    async startUpload(cu, me, p) {
      const { user, cachePath } = await doctorFor(cu, me, p.doctorId);
      return d.openUpload(user, await d.inboxFor(cachePath, user), p);
    },
    async submit(cu, me, p) {
      const { doc, user, cachePath } = await doctorFor(cu, me, p.doctorId);
      return d.createSubmission(cu, user, doc, p.files, await d.inboxFor(cachePath, user),
        { states: p.states, level: p.level, submittedBy: CU.SUBMITTED_BY_RECRUITER, via: 'the staff portal by ' + me.name });
    },

    // The Reference Requester, hosted: staff pick the form types and may edit the message.
    async requestReferences(cu, me, p) {
      const { doc, user } = await doctorFor(cu, me, p.doctorId);
      const rows = (Array.isArray(p.referees) ? p.referees : []).slice(0, d.REF_CFG.max);
      if (!rows.length) fail('invalid-argument', 'Add at least one referee.');
      const referees = rows.map((r) => ({ name: d.cleanText(r.name, 80), email: String(r.email || '').trim().toLowerCase().slice(0, 120),
        templates: [...new Set((r.templates || []).filter((x) => TEMPLATES.includes(x)))] }));
      for (const r of referees) {
        if (!/^[\p{L}][\p{L} .'\-]{1,79}$/u.test(r.name)) fail('invalid-argument', 'Check the name "' + r.name + '".');
        if (!/^[^@\s<>"]+@[^@\s<>"]+\.[a-z]{2,}$/i.test(r.email)) fail('invalid-argument', 'Check the email for ' + r.name + '.');
        if (!r.templates.length) fail('invalid-argument', 'Pick a reference type for ' + r.name + '.');
        if (r.templates.includes('combined')) r.templates = ['combined'];
      }
      const used = new Set((await cu.listDocs(user.medReg)).filter((t) => d.refSlot(t.name) && CU.dropdownId(t, CU.F.fileStage) !== CU.STAGE.archived).map((t) => d.refSlot(t.name)));
      if (used.size + referees.length > d.REF_CFG.max) fail('failed-precondition', 'This doctor has ' + used.size + ' of ' + d.REF_CFG.max + ' referee slots used.');
      const message = String(p.message || '').replace(/<[^>]*>/g, '').slice(0, 4000);
      if (!message.includes('{links}')) fail('invalid-argument', 'The message must include {links} so the referee gets the form links.');
      await d.ensureParent(cu, user, doc);
      const res = await fetch(REF_REQUEST_WEBHOOK.value().trim(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'gibbon', rego: user.medReg, doctorName: '', taskId: '', message,
          referees: referees.map((r) => ({ name: r.name, email: r.email, templates: r.templates.map((type) => ({ type })) })) }) });
      if (!res.ok) fail('unavailable', 'Make didn’t accept the request (' + res.status + '). Try again shortly.');
      await cu.post('task/' + doc.id + '/comment', { notify_all: false, comment_text: 'Reference requests sent by ' + me.name + ' from the staff portal:\n' +
        referees.map((r) => '• ' + r.name + ' ' + r.email + ' (' + r.templates.join(' + ') + ')').join('\n') }).catch(() => {});
      return { count: referees.length };
    }
  };

  return onCall({ secrets: [CLICKUP_TOKEN, REF_REQUEST_WEBHOOK], cors: true, timeoutSeconds: 300 }, async (req) => {
    const p = req.data || {};
    const fn = actions[p.action];
    if (!fn) fail('invalid-argument', 'Unknown action.');
    const cu = CU.client(CLICKUP_TOKEN.value());
    return fn(cu, await whoAmI(req, cu), p);
  });
};
