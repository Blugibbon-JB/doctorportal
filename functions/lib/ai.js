// Gemini (Vertex AI, in the portal's own Google Cloud project) works out what an
// emailed file is when its name doesn't say: a single document, or a bundle of
// several in one PDF. It only names document types and page ranges. Expiry dates
// are left to the reviewer. Uses the functions' own service account, no API key.
'use strict';
const { GoogleAuth } = require('google-auth-library');

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const LOCATION = process.env.GEMINI_LOCATION || 'australia-southeast1';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_MIME = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/i;

// Type codes the model may use: upload boxes, with 100-point ID options as id100:<option>.
function typeCodes(req) {
  const out = [];
  req.boxes.filter((b) => b.kind !== 'form' && b.id !== 'unsorted').forEach((b) => {
    if (b.kind === 'choice') b.options.forEach((o) => out.push([b.id + ':' + o.id, o.label]));
    else out.push([b.id, b.label + (b.hint ? ' (' + b.hint + ')' : '')]);
  });
  return out;
}

function prompt(codes, pages) {
  return 'You are sorting compliance documents that a locum doctor emailed to an Australian medical recruitment agency.\n' +
    'The attached file has ' + pages + ' page' + (pages > 1 ? 's' : '') + '. Work out which separate documents it contains and which pages each one is on. ' +
    'One document can run over several pages (for example an insurance certificate of currency, or the front and back of a licence). ' +
    'Several vaccinations on one page or one immunisation history is a single "vacrecord" document.\n\n' +
    'Use only these type codes:\n' + codes.map(([c, l]) => '- ' + c + ': ' + l).join('\n') +
    '\n- unknown: anything else, or if you are not sure (cover letters, blank pages, email printouts, documents not listed)\n\n' +
    'Rules: every page from 1 to ' + pages + ' must be in exactly one document; list documents in page order; ' +
    'give a confidence from 0 to 1. Do not copy out any personal details, numbers or dates.';
}

const SCHEMA = { type: 'OBJECT', properties: { documents: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
  type: { type: 'STRING' }, pages: { type: 'ARRAY', items: { type: 'INTEGER' } }, confidence: { type: 'NUMBER' } },
  required: ['type', 'pages', 'confidence'] } } }, required: ['documents'] };

// -> raw { documents: [{ type, pages, confidence }] } from the model (validate with intake.cleanGroups).
async function sortFile({ data, mimeType, pages, req }) {
  if (!AI_MIME.test(mimeType)) throw new Error('type not readable by the model: ' + mimeType);
  const project = await auth.getProjectId();
  const host = LOCATION === 'global' ? 'aiplatform.googleapis.com' : LOCATION + '-aiplatform.googleapis.com';
  const c = await auth.getClient();
  const res = await c.request({ method: 'POST', validateStatus: () => true,
    url: 'https://' + host + '/v1/projects/' + project + '/locations/' + LOCATION + '/publishers/google/models/' + MODEL + ':generateContent',
    data: { contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: data.toString('base64') } }, { text: prompt(typeCodes(req), pages) }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA } } });
  if (res.status >= 300) throw new Error('Gemini ' + res.status + ' ' + JSON.stringify(res.data).slice(0, 300));
  const text = (((res.data.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || '').join('') || '';
  return JSON.parse(text);
}

module.exports = { sortFile, typeCodes, prompt, AI_MIME };
