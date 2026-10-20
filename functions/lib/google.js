// Google Drive (Shared Drive "1.0 ADMIN POOL") and Gmail (send as hello@).
// Drive: the functions' own service account is a member of the Shared Drive.
// Gmail: the same service account, allowed by the Workspace admin to send as
// hello@ (domain-wide delegation, scope gmail.send). No key files anywhere.
'use strict';
const { GoogleAuth } = require('google-auth-library');

const SHARED_DRIVE = '0AOmUgZwrbZKkUk9PVA';                 // 1.0 ADMIN POOL
const NEW_DOCTOR_PARENT = '1SIoU7HL1jSbhHeMbV72Is-2Cu3hVwnpz'; // same folder Filing creates new doctor folders in
const INBOX_NAME = 'PORTAL UPLOADS - FOR REVIEW';
const FOLDER = 'application/vnd.google-apps.folder';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive'] });

async function drive(method, url, body, headers) {
  const c = await auth.getClient();
  const res = await c.request({ method, url: url.startsWith('http') ? url : 'https://www.googleapis.com/drive/v3/' + url,
    data: body, headers: headers || {} , validateStatus: () => true });
  if (res.status >= 300) throw new Error('Drive ' + method + ' ' + url.split('?')[0] + ' -> ' + res.status + ' ' + JSON.stringify(res.data).slice(0, 200));
  return res;
}
const q = (s) => encodeURIComponent(s);
const all = 'supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives'; // doctor folders live in more than one Shared Drive

function folderIdFromLink(link) {
  const m = String(link || '').match(/folders\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

async function findOrCreateFolder(parentId, name) {
  const found = await drive('GET', 'files?' + all + '&fields=files(id,name,webViewLink)&q=' +
    q("'" + parentId + "' in parents and name = '" + name.replace(/'/g, "\\'") + "' and mimeType = '" + FOLDER + "' and trashed = false"));
  if (found.data.files.length) return found.data.files[0];
  const made = await drive('POST', 'files?supportsAllDrives=true&fields=id,name,webViewLink', { name, mimeType: FOLDER, parents: [parentId] });
  return made.data;
}

// Opens a one-time upload straight into Drive. The browser PUTs the file to
// the returned URL, so the file never passes through our servers.
async function startResumable({ folderId, name, mimeType, size, origin }) {
  const res = await drive('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,parents,webViewLink,size',
    { name, parents: [folderId] },
    { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType || 'application/octet-stream',
      'X-Upload-Content-Length': String(size), Origin: origin });
  const loc = res.headers.location || res.headers.Location;
  if (!loc) throw new Error('Drive did not return an upload URL');
  return loc;
}

// Server-side upload (email attachments): small enough to send in one request.
async function uploadBuffer({ folderId, name, mimeType, data }) {
  const boundary = 'bgportal' + Date.now();
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + boundary + '\r\nContent-Type: ' + (mimeType || 'application/octet-stream') + '\r\n\r\n'),
    data, Buffer.from('\r\n--' + boundary + '--')]);
  const res = await drive('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,parents,webViewLink',
    body, { 'Content-Type': 'multipart/related; boundary=' + boundary });
  return res.data;
}

async function getFile(fileId) {
  return (await drive('GET', 'files/' + fileId + '?supportsAllDrives=true&fields=id,name,parents,webViewLink,size,mimeType')).data;
}

// ---------- Gmail as hello@ via domain-wide delegation (signed by IAM, no key) ----------
const SENDER = 'hello@blugibbon.com.au';
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify'; // read + label hello@ (email intake); needs adding to the delegation
const tokens = {};
async function gmailToken(scope = SEND) {
  if (tokens[scope] && tokens[scope].exp > Date.now() + 60000) return tokens[scope].token;
  const base = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const c = await base.getClient();
  const email = (await base.getCredentials()).client_email;
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: email, sub: SENDER, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const signed = await c.request({ method: 'POST',
    url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + email + ':signJwt', data: { payload: JSON.stringify(claims) } });
  const tok = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + q('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + signed.data.signedJwt });
  const out = await tok.json();
  if (!out.access_token) throw new Error('Gmail auth failed (' + scope.split('/').pop() + '): ' + JSON.stringify(out).slice(0, 200));
  tokens[scope] = { token: out.access_token, exp: Date.now() + (out.expires_in || 3600) * 1000 };
  return out.access_token;
}
// reply: { messageId, threadId } to send as a reply in the same Gmail thread.
async function sendMail(to, subject, text, reply) {
  const enc = (v) => /^[\x20-\x7e]*$/.test(v) ? v : '=?UTF-8?B?' + Buffer.from(v).toString('base64') + '?=';
  const head = ['From: Blugibbon <' + SENDER + '>', 'To: ' + to, 'Subject: ' + enc(subject), 'Content-Type: text/plain; charset=UTF-8'];
  if (reply && reply.messageId) head.push('In-Reply-To: ' + reply.messageId, 'References: ' + reply.messageId);
  const raw = Buffer.from(head.concat(['', text]).join('\r\n')).toString('base64url');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + (await gmailToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify(reply && reply.threadId ? { raw, threadId: reply.threadId } : { raw }) });
  if (!res.ok) throw new Error('Gmail send -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

// Reading hello@ (email intake). path is relative to users/me/.
async function gmail(method, path, body) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { method,
    headers: { Authorization: 'Bearer ' + (await gmailToken(MODIFY)), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  if (!res.ok) throw new Error('Gmail ' + method + ' ' + path.split('?')[0] + ' -> ' + res.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : {};
}
async function labelIds(names) { // finds or creates Gmail labels, returns { name: id }
  const have = (await gmail('GET', 'labels')).labels || [];
  const out = {};
  for (const n of names) {
    const hit = have.find((l) => l.name.toLowerCase() === n.toLowerCase());
    out[n] = hit ? hit.id : (await gmail('POST', 'labels', { name: n, labelListVisibility: 'labelShow', messageListVisibility: 'show' })).id;
  }
  return out;
}

module.exports = { uploadBuffer, gmail, labelIds, findOrCreateFolder, startResumable, getFile, folderIdFromLink, sendMail, NEW_DOCTOR_PARENT, INBOX_NAME };
