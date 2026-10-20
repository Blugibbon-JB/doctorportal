// Blugibbon doctor portal backend (Firebase Cloud Functions, Sydney region).
// The browser only ever talks to these functions and Firebase. ClickUp and
// Drive access stays here, server-side.
'use strict';
const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const CU = require('./lib/clickup');
const G = require('./lib/google');
const REQ = require('./requirements.json');

admin.initializeApp();
setGlobalOptions({ region: 'australia-southeast1', maxInstances: 5 });
const db = admin.database();
const CLICKUP_TOKEN = defineSecret('CLICKUP_TOKEN');
const CLICKUP_WEBHOOK_SECRET = defineSecret('CLICKUP_WEBHOOK_SECRET');
const REF_REQUEST_WEBHOOK = defineSecret('REF_REQUEST_WEBHOOK'); // Make Scenario 4 webhook address
const PORTAL_ORIGIN = defineString('PORTAL_ORIGIN', { default: 'https://blugibbon-jb.github.io' });
const opts = { secrets: [CLICKUP_TOKEN], cors: true };

const MAX_BYTES = 50 * 1024 * 1024;
const key = (s) => String(s).replace(/[.#$[\]/\s]/g, '_');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const upperName = (n) => String(n || '').replace(/^Dr\.?\s+/i, '').trim().toUpperCase();
const mask = (e) => String(e).replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => a + '•'.repeat(Math.min(6, b.length)) + c);
const fail = (code, msg) => { throw new HttpsError(code, msg); };

function needAuth(req) { if (!req.auth) fail('unauthenticated', 'Please sign in first.'); return req.auth.uid; }
async function linkedUser(uid) {
  const u = (await db.ref('portal/users/' + uid).get()).val();
  if (!u) fail('failed-precondition', 'Link your registration first.');
  return u;
}
function boxPrefix(box, choice) {
  if (box.kind !== 'choice') return { prefix: box.namePrefix, docTypeId: box.docTypeId };
  const o = box.options.find((x) => x.id === choice) || box.options[0];
  return { prefix: o.namePrefix, docTypeId: o.docTypeId };
}

// ---------- 1. Link a sign-in to a doctor (6-digit code to the ClickUp email) ----------
exports.linkStart = onCall(opts, async (req) => {
  const uid = needAuth(req);
  const medReg = String((req.data && req.data.medReg) || '').replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{3,16}$/.test(medReg)) fail('invalid-argument', 'That doesn’t look like an AHPRA registration number.');
  const prev = (await db.ref('portal/codes/' + uid).get()).val();
  if (prev && Date.now() - prev.sentAt < 60 * 1000) fail('resource-exhausted', 'Please wait a minute before asking for another code.');

  const cu = CU.client(CLICKUP_TOKEN.value());
  const doc = await cu.findDoctor(medReg);
  if (!doc) fail('not-found', 'We couldn’t find that registration. Please check it, or ask your recruiter.');
  const email = CU.field(doc, CU.F.email);
  if (!email) fail('failed-precondition', 'We don’t have an email on file for you yet. Please ask your recruiter to add it.');

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.ref('portal/codes/' + uid).set({ doctorId: doc.id, medReg: CU.field(doc, CU.F.medReg), codeHash: sha(uid + code),
    expires: Date.now() + 15 * 60 * 1000, tries: 0, sentAt: Date.now() });
  await G.sendMail(email, 'Your Blugibbon code: ' + code,
    'Hi,\n\nYour code to link your Blugibbon documents account is: ' + code + '\n\nIt expires in 15 minutes. ' +
    'If you didn’t ask for this, you can ignore this email.\n\nBlugibbon Medical Recruitment');
  return { sentTo: mask(email) };
});

exports.linkVerify = onCall(opts, async (req) => {
  const uid = needAuth(req);
  const ref = db.ref('portal/codes/' + uid);
  const rec = (await ref.get()).val();
  if (!rec || rec.expires < Date.now()) fail('deadline-exceeded', 'That code has expired. Please ask for a new one.');
  if (rec.tries >= 5) fail('resource-exhausted', 'Too many attempts. Please ask for a new code.');
  if (sha(uid + String((req.data && req.data.code) || '').replace(/\D/g, '')) !== rec.codeHash) {
    await ref.child('tries').set(rec.tries + 1);
    fail('permission-denied', 'That code isn’t right. Please check and try again.');
  }
  const cu = CU.client(CLICKUP_TOKEN.value());
  const doc = await cu.get('task/' + rec.doctorId);
  const user = { medReg: rec.medReg, medKey: key(rec.medReg), doctorId: doc.id, name: doc.name.trim(),
    recruiter: ((doc.assignees || [])[0] || {}).username || 'your recruiter', linkedAt: Date.now() };
  await db.ref('portal/users/' + uid).set(user);
  await ref.remove();
  await refreshDocs(cu, user);
  return user;
});

// ---------- 2. Upload: open a one-time Drive upload in the doctor's folder ----------
exports.startUpload = onCall(opts, async (req) => {
  const uid = needAuth(req);
  const user = await linkedUser(uid);
  const d = req.data || {};
  const box = REQ.boxes.find((b) => b.id === d.boxId);
  if (!box || box.kind === 'form') fail('invalid-argument', 'Unknown upload box.');
  if (!(d.size > 0) || d.size > MAX_BYTES) fail('invalid-argument', 'Files must be under 50 MB.');
  const inboxId = await inboxFor(uid, user);
  const { prefix } = boxPrefix(box, d.choice);
  const safe = String(d.fileName || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const uploadUrl = await G.startResumable({ folderId: inboxId, name: prefix + ' ' + upperName(user.name) + ' - ' + safe,
    mimeType: d.mimeType, size: d.size, origin: PORTAL_ORIGIN.value() });
  return { uploadUrl };
});

async function inboxFor(uid, user) {
  if (user.inboxId) return user.inboxId;
  const cu = CU.client(CLICKUP_TOKEN.value());
  const doc = await cu.get('task/' + user.doctorId);
  let folderId = G.folderIdFromLink(CU.field(doc, CU.F.gdrive));
  if (!folderId) { // no doctor folder yet: create it where Filing would, and write it back to ClickUp
    const f = await G.findOrCreateFolder(G.NEW_DOCTOR_PARENT, 'Dr ' + upperName(user.name));
    folderId = f.id;
    await cu.setField(doc.id, CU.F.gdrive, f.webViewLink);
    await cu.setField(doc.id, CU.F.folderId, f.id).catch(() => {});
  }
  const inbox = await G.findOrCreateFolder(folderId, G.INBOX_NAME);
  await db.ref('portal/users/' + uid).update({ folderId, inboxId: inbox.id });
  return inbox.id;
}

// The "Dr <name>" parent in the Compliance Documents list; created if this doctor has none yet.
async function ensureParent(cu, user, doc) {
  let parent = await cu.findParent(user.medReg);
  if (!parent) {
    parent = await cu.post('list/' + CU.COMPLIANCE_LIST + '/task', { name: 'Dr ' + user.name, notify_all: false, custom_fields: [
      { id: CU.F.fileStage, value: CU.STAGE.doctorRecord }, { id: CU.F.medReg, value: user.medReg },
      { id: CU.F.gdrive, value: CU.field(doc, CU.F.gdrive) || '' }] });
    await cu.setField(parent.id, CU.F.relatedDoctor, { add: [doc.id] }).catch(() => {});
  }
  return parent;
}

// ---------- 3b. References: the doctor adds referees, Scenario 4 emails them ----------
// The email wording is fixed here (not sent from the browser), so the portal can't be
// used to send arbitrary messages from hello@. {referee} {doctor} {links} are filled by Make.
const REF_MESSAGE = 'Hello {referee},\n\n' +
  'Blugibbon is a medical recruitment company that places locum doctors across Australia.\n\n' +
  'Dr {doctor} has named you as a referee and given us permission to contact you. We understand your time is valuable and very much appreciate your help.\n\n' +
  'Could you please complete the reference request(s) by clicking the link(s) below:\n\n{links}\n\n' +
  'If you would prefer to give the reference over the phone, please call us on 02 8960 6445.\n\n' +
  'Warm regards,\nBlugibbon\n\n' +
  'P.S. If you are a doctor interested in locum work, or you are looking to fill locum shifts of your own, we would love to hear from you: visit blugibbon.com.au or call us on 02 8960 6445.';
const REF_CFG = Object.assign({ required: 2, max: 3, templates: [{ type: 'professional' }, { type: 'clinical' }] }, REQ.references || {});
const refSlot = (name) => { const m = /(?:^|\s)1\.2\.([1-3])\s/.exec(String(name || '')); return m ? Number(m[1]) : null; };
const cleanText = (v, n) => String(v || '').replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

exports.requestReferences = onCall({ secrets: [CLICKUP_TOKEN, REF_REQUEST_WEBHOOK], cors: true, timeoutSeconds: 120 }, async (req) => {
  const uid = needAuth(req);
  const user = await linkedUser(uid);
  const d = req.data || {};
  if (d.consent !== true) fail('failed-precondition', 'Please tick the box to give us permission to contact your referees.');
  const last = user.refsLastAt || 0;
  if (Date.now() - last < 2 * 60 * 1000) fail('resource-exhausted', 'Your last request is still being sent. Please wait a couple of minutes.');

  const rows = (Array.isArray(d.referees) ? d.referees : []).slice(0, REF_CFG.max);
  if (!rows.length) fail('invalid-argument', 'Please add at least one referee.');
  const referees = rows.map((r) => ({
    name: cleanText(r.name, 80), email: String(r.email || '').trim().toLowerCase().slice(0, 120),
    position: cleanText(r.position, 100), workplace: cleanText(r.workplace, 120), phone: cleanText(r.phone, 30)
  }));
  for (const r of referees) {
    if (!/^[\p{L}][\p{L} .'\-]{1,79}$/u.test(r.name)) fail('invalid-argument', 'Please check the referee name "' + r.name + '" (letters only).');
    if (!/^[^@\s<>"]+@[^@\s<>"]+\.[a-z]{2,}$/i.test(r.email)) fail('invalid-argument', 'Please check the email for ' + r.name + '.');
    if (!r.position || !r.workplace) fail('invalid-argument', 'Please add the position and hospital or practice for ' + r.name + '.');
  }
  if (new Set(referees.map((r) => r.email)).size !== referees.length) fail('invalid-argument', 'Each referee needs a different email address.');

  const cu = CU.client(CLICKUP_TOKEN.value());
  const doc = await cu.get('task/' + user.doctorId);
  const ownEmail = String(CU.field(doc, CU.F.email) || '').trim().toLowerCase();
  if (ownEmail && referees.some((r) => r.email === ownEmail)) fail('invalid-argument', 'A referee can’t use your own email address.');

  // Scenario 4 has three referee slots (1.2.1-1.2.3). Don't let the doctor overrun them or repeat someone.
  const existing = (await cu.listDocs(user.medReg)).filter((t) => refSlot(t.name) && CU.dropdownId(t, CU.F.fileStage) !== CU.STAGE.archived);
  const used = new Set(existing.map((t) => refSlot(t.name)));
  if (used.size + referees.length > REF_CFG.max) {
    fail('failed-precondition', used.size >= REF_CFG.max ? 'You already have ' + REF_CFG.max + ' referees on file. Please ask your recruiter if you need to change one.'
      : 'You can add ' + (REF_CFG.max - used.size) + ' more referee' + (REF_CFG.max - used.size === 1 ? '' : 's') + '.');
  }
  const prevEmails = Object.values(user.refs || {}).map((r) => r.email);
  const repeat = referees.find((r) => prevEmails.includes(r.email));
  if (repeat) fail('already-exists', repeat.name + ' has already been asked. We’ll chase them for you.');

  await db.ref('portal/users/' + uid + '/refsLastAt').set(Date.now());
  await ensureParent(cu, user, doc); // Scenario 4 hangs the reference tasks off this record

  const res = await fetch(REF_REQUEST_WEBHOOK.value().trim(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'gibbon', rego: user.medReg, doctorName: '', taskId: '', message: REF_MESSAGE,
      referees: referees.map((r) => ({ name: r.name, email: r.email, templates: REF_CFG.templates })) })
  });
  if (!res.ok) {
    await db.ref('portal/users/' + uid + '/refsLastAt').remove();
    fail('unavailable', 'We couldn’t send the requests just now. Please try again in a few minutes.');
  }

  const at = Date.now();
  const updates = {};
  referees.forEach((r) => { updates[db.ref().push().key] = { name: r.name, email: r.email, position: r.position, workplace: r.workplace, phone: r.phone, requestedAt: at }; });
  await db.ref('portal/users/' + uid + '/refs').update(updates);

  const when = new Date(at).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  const lines = referees.map((r) => '• ' + r.name + ' (' + r.position + ', ' + r.workplace + ') ' + r.email + (r.phone ? ' · ' + r.phone : '')).join('\n');
  await cu.post('task/' + doc.id + '/comment', { notify_all: true, comment_text:
    'Reference requests sent from the doctor portal (' + when + ').\nThe doctor ticked permission for us to contact these referees:\n' + lines +
    '\n\nReference tasks are under Dr ' + user.name + ' in Compliance Documents.' }).catch((e) => console.error('ref comment', e.message));
  return { count: referees.length };
});

// ---------- 3. Submit: one ClickUp task per document, same shape as the Splitter ----------
exports.submit = onCall({ ...opts, timeoutSeconds: 300 }, async (req) => {
  const uid = needAuth(req);
  const user = await linkedUser(uid);
  const files = ((req.data && req.data.files) || []).slice(0, 40);
  if (!files.length) fail('invalid-argument', 'Nothing to submit.');
  const inboxId = await inboxFor(uid, user);
  const cu = CU.client(CLICKUP_TOKEN.value());
  const doc = await cu.get('task/' + user.doctorId);
  const NAME = upperName(user.name);

  // Check every file really is in this doctor's upload folder.
  const checked = [];
  for (const f of files) {
    const box = REQ.boxes.find((b) => b.id === f.boxId);
    const g = await G.getFile(String(f.fileId || ''));
    if (!box || !(g.parents || []).includes(inboxId)) fail('permission-denied', 'One of the files could not be verified.');
    checked.push({ box, choice: f.choice, g, original: f.fileName || g.name });
  }

  const parent = await ensureParent(cu, user, doc);

  const assignees = (doc.assignees || []).map((a) => a.id);
  const list = checked.map((c) => '• ' + boxPrefix(c.box, c.choice).prefix + ': ' + c.original).join('\n');
  const submission = await cu.post('list/' + CU.COMPLIANCE_LIST + '/task', {
    name: 'Dr ' + user.name, assignees, notify_all: true,
    description: 'Submitted through the doctor portal (' + checked.length + ' file' + (checked.length > 1 ? 's' : '') + ').\n\n' + list +
      '\n\nStates: ' + ((req.data.states || []).join(', ') || '-') + ' · Level: ' + (req.data.level || '-') + '\nFiles are in the doctor’s Drive folder › ' + G.INBOX_NAME + '.',
    custom_fields: [{ id: CU.F.fileStage, value: CU.STAGE.formResponse }, { id: CU.F.medReg, value: user.medReg },
      { id: CU.F.submittedBy, value: CU.SUBMITTED_BY_DOCTOR }] });

  const existing = await cu.listDocs(user.medReg);
  for (const c of checked) {
    const { prefix, docTypeId } = boxPrefix(c.box, c.choice);
    const name = prefix + ' ' + NAME + (c.box.multi ? ' (' + c.original.replace(/\.[^.]+$/, '') + ')' : '');
    let prev = null;
    if (c.box.supersede && docTypeId) {
      prev = existing.filter((t) => CU.dropdownId(t, CU.F.docType) === docTypeId &&
          CU.dropdownId(t, CU.F.fileStage) === CU.STAGE.filed &&
          (!c.box.stateOptionId || CU.dropdownId(t, CU.F.state) === c.box.stateOptionId))
        .sort((a, b) => Number(b.date_created) - Number(a.date_created))[0] || null;
    }
    const fields = [
      { id: CU.F.fileStage, value: prev ? CU.STAGE.renewed : CU.STAGE.new }, { id: CU.F.medReg, value: user.medReg },
      { id: CU.F.sourceSubmission, value: submission.id }, { id: CU.F.submissionDate, value: Date.now() },
      { id: CU.F.gdrive, value: c.g.webViewLink }, { id: CU.F.submittedBy, value: CU.SUBMITTED_BY_DOCTOR }];
    if (docTypeId) fields.push({ id: CU.F.docType, value: docTypeId });
    if (c.box.stateOptionId) fields.push({ id: CU.F.state, value: c.box.stateOptionId });
    if (prev) fields.push({ id: CU.F.supersedes, value: prev.id });
    const t = await cu.post('list/' + CU.COMPLIANCE_LIST + '/task', { name, parent: parent.id, notify_all: false, custom_fields: fields });
    await cu.setField(t.id, CU.F.relatedDoctor, { add: [doc.id] }).catch(() => {});
  }
  await refreshDocs(cu, user);
  return { submissionId: submission.id, count: checked.length };
});

// ---------- 4. Status copy: ClickUp -> Firebase (read-only to the doctor) ----------
function slim(t) {
  return { name: t.name, status: (t.status && t.status.status) || '', fileStage: CU.dropdownId(t, CU.F.fileStage),
    docType: CU.dropdownId(t, CU.F.docType), state: CU.dropdownId(t, CU.F.state), reviewer: CU.dropdownId(t, CU.F.reviewer),
    due: t.due_date ? Number(t.due_date) : null, created: Number(t.date_created || 0), parent: t.parent || null };
}
async function refreshDocs(cu, user) {
  const tasks = await cu.listDocs(user.medReg);
  const out = {}, idx = {};
  tasks.forEach((t) => { out[t.id] = slim(t); idx[t.id] = user.medKey; });
  await db.ref('portal/docs/' + user.medKey).set(out);
  await db.ref('portal/taskIndex').update(idx);
}
exports.refreshMyStatus = onCall(opts, async (req) => {
  const user = await linkedUser(needAuth(req));
  await refreshDocs(CU.client(CLICKUP_TOKEN.value()), user);
  return { ok: true };
});

// ClickUp webhook on the Compliance Documents list (created by scripts/create-clickup-webhook.js).
exports.clickupWebhook = onRequest({ secrets: [CLICKUP_TOKEN, CLICKUP_WEBHOOK_SECRET] }, async (req, res) => {
  const sig = crypto.createHmac('sha256', CLICKUP_WEBHOOK_SECRET.value()).update(req.rawBody).digest('hex');
  if (req.get('X-Signature') !== sig) { res.status(401).send('bad signature'); return; }
  const { event, task_id: id } = req.body || {};
  try {
    if (event === 'taskDeleted') {
      const k = (await db.ref('portal/taskIndex/' + id).get()).val();
      if (k) await db.ref('portal/docs/' + k + '/' + id).remove();
    } else {
      const t = await CU.client(CLICKUP_TOKEN.value()).get('task/' + id);
      const medReg = CU.field(t, CU.F.medReg);
      if (medReg) {
        await db.ref('portal/docs/' + key(medReg) + '/' + id).set(slim(t));
        await db.ref('portal/taskIndex/' + id).set(key(medReg));
      }
    }
  } catch (e) { console.error('webhook', id, e.message); }
  res.status(200).send('ok'); // reply after the work: Cloud Run may pause the function once it has answered
});
