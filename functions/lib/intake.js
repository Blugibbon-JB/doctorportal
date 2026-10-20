// Email intake helpers: which doctor an email is for, which attachments to keep,
// and a best guess at each file's upload box from its file name. Anything unclear
// becomes "unsorted" (task name "TO CLASSIFY …") and the reviewer picks the
// Document Type in ClickUp; the ClickUp webhook then renames it (see index.js).
'use strict';

const KEEP_EXT = /\.(pdf|jpe?g|png|heic|heif|docx?|tiff?|webp|gif)$/i;
const MAX_BYTES = 25 * 1024 * 1024;

// Ordered: first match wins, so the specific rules come before the general ones.
const RULES = [
  [/hep(atitis)?[ _-]*b.*(stat|declar)|stat.*dec.*hep/i, null], // Hep B stat dec is a signed form, reviewer decides
  [/(full|complete|whole).*(vacc|immuni[sz])|immuni[sz]ation[ _-]*(history|record|statement)|vacc(ination)?[ _-]*(record|history|card|summary)|\bair\b.*(statement|history)/i, 'vacrecord'],
  [/\bmmr\b|measles|mumps|rubella/i, 'mmr'],
  [/hep(atitis)?[ _-]*a\b/i, 'hepa'],
  [/hep(atitis)?[ _-]*b|anti[ _-]?hbs|hbsab/i, 'hepb'],
  [/varicella|chicken[ _-]*pox|\bvzv\b/i, 'vari'],
  [/dtpa|boostrix|adacel|pertussis|whooping/i, 'dtpa'],
  [/\btb\b|tubercul|quanti[ _-]*feron|\bigra\b|mantoux|\bbcg\b/i, 'tb'],
  [/\bflu\b|influenza|fluad|vaxigrip|flucelvax/i, 'flu'],
  [/covid|comirnaty|spikevax|pfizer|moderna|novavax/i, 'covid'],
  [/\bmrsa\b/i, 'mrsa'],
  [/polio|\bipv\b/i, 'polio'],
  [/ahpra|medical[ _-]*board|registration[ _-]*(cert|confirm)|\bregistration\b/i, 'ahpra'],
  [/indem|\bmdo\b|avant|\bmiga\b|\bmips\b|\bmda\b|insurance|certificate[ _-]*of[ _-]*currency/i, 'indem'],
  [/passport/i, 'pp'],
  [/driv(er|ers|ing)?[ _-]*licen[cs]e|\blicen[cs]e\b|\bdl\b/i, 'dl'],
  [/\bvisa\b|vevo|grant[ _-]*notice/i, 'visa'],
  [/police|\bncrc\b|\bnpc\b|criminal|\bafp\b|crim[ _-]*check/i, 'ncrc'],
  [/blue[ _-]*card/i, 'wwcc_qld'],
  [/ochre/i, 'wwcc_nt'],
  [/(working|work)[ _-]*with[ _-]*(children|vulnerable)|\bwwc+\b|\bwwvp\b/i, 'wwcc'], // state worked out below
  [/heti|e[ _-]*meds|\bemr\b/i, 'heti'],
  [/\b(als|bls|apls|acls|pals|also|atls|emst|cpd)\d?\b|\bcourse\b|resus/i, 'cpd'],
  [/fellowship|\bfacem\b|\bfracgp\b|\bfracp\b|\bfanzca\b|\bfranzcog\b|\bfranzcp\b|\bfracs\b|\bfacrrm\b/i, 'fellow'],
  [/degree|mbbs|\bmbchb\b|\bmd\b|diploma|graduat|testamur/i, 'degree'],
  [/\bcv\b|resume|résumé|curriculum/i, 'cv'],
  [/medicare/i, 'id100:medicare'],
  [/birth[ _-]*cert/i, 'id100:birth'],
  [/bank[ _-]*statement/i, 'id100:bank'],
  [/utility|electricity|gas[ _-]*bill|water[ _-]*bill|rates[ _-]*notice/i, 'id100:utility']
];
const WWCC_STATE = [['nsw', 'wwcc_nsw'], ['qld|queensland', 'wwcc_qld'], ['vic|victoria', 'wwcc_vic'], ['wa|western', 'wwcc_wa'],
  ['sa|south[ _-]*aus', 'wwcc_sa'], ['tas|tasmania', 'wwcc_tas'], ['nt|northern', 'wwcc_nt'], ['act|canberra', 'wwcc_act']];

// File name -> { boxId, choice } (choice only for the 100-point ID box). "unsorted" when unclear.
function guessBox(fileName, validIds) {
  const n = ' ' + String(fileName || '').replace(/\.[^.]+$/, '').replace(/[_.]+/g, ' ') + ' ';
  for (const [re, target] of RULES) {
    if (!re.test(n)) continue;
    if (!target) return { boxId: 'unsorted' };
    if (target === 'wwcc') {
      const hit = WWCC_STATE.find(([s]) => new RegExp('\\b(' + s + ')\\b', 'i').test(n));
      return { boxId: hit && validIds.has(hit[1]) ? hit[1] : 'unsorted' };
    }
    const [boxId, choice] = target.split(':');
    return validIds.has(boxId) ? { boxId, choice: choice || null } : { boxId: 'unsorted' };
  }
  return { boxId: 'unsorted' };
}

// AHPRA registration (3 letters + 10 digits), or a TEST999-style test rego.
function findRego(text) {
  const m = /\b([A-Z]{3}\d{10})\b/i.exec(text || '') || /\b(TEST\d{3,6})\b/i.exec(text || '');
  return m ? m[1].toUpperCase() : null;
}
function addressOf(header) {
  const m = /<([^>]+)>/.exec(header || '') || /([^\s<>"]+@[^\s<>"]+)/.exec(header || '');
  return m ? m[1].trim().toLowerCase() : '';
}
// For a staff forward: the first outside address in the forwarded text ("From: Dr X <x@y.com>").
function forwardedSender(text) {
  const re = /^\s*(?:>\s*)?From:\s*(.+)$/gim;
  let m;
  while ((m = re.exec(text || ''))) {
    const a = addressOf(m[1]);
    if (a && !/@blugibbon\.com\.au$/.test(a)) return a;
  }
  return null;
}

const header = (msg, name) => ((msg.payload && msg.payload.headers) || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function walk(part, out) {
  if (!part) return out;
  out.push(part);
  (part.parts || []).forEach((p) => walk(p, out));
  return out;
}
function bodyText(msg) {
  return walk(msg.payload, []).filter((p) => p.mimeType === 'text/plain' && p.body && p.body.data)
    .map((p) => Buffer.from(p.body.data, 'base64url').toString('utf8')).join('\n').slice(0, 20000);
}
// Real attachments only: skips signature logos, calendar invites, Outlook winmail.dat and the like.
function attachments(msg) {
  return walk(msg.payload, []).filter((p) => p.filename && p.body && p.body.attachmentId).map((p) => ({
    fileName: p.filename, mimeType: p.mimeType || 'application/octet-stream', size: p.body.size || 0, attachmentId: p.body.attachmentId,
    inline: /inline/i.test(((p.headers || []).find((h) => /content-disposition/i.test(h.name)) || {}).value || '')
  })).filter((a) => KEEP_EXT.test(a.fileName) && a.size <= MAX_BYTES && !(a.mimeType.startsWith('image/') && (a.size < 30 * 1024 || (a.inline && a.size < 80 * 1024))));
}

module.exports = { guessBox, findRego, addressOf, forwardedSender, header, bodyText, attachments };
