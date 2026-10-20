// Thin ClickUp API helper + the doctor / compliance lookups the portal needs.
'use strict';

const TEAM = '9016018501';
const DOCTOR_LISTS = ['901604837755', '901609291565', '901604837751']; // BG Active, (2nd doctors list), New & Pre-screened
const COMPLIANCE_LIST = '901616167201';
const F = {
  medReg: '118ac6ea-c763-465b-8cf7-3318ed840742',
  email: '69eec44c-38a7-44dc-85cf-31e146618957',
  gdrive: 'a811e4cf-a421-42f0-b9a8-68f04de592fd',
  folderId: '9557fad1-5bd9-4a33-a494-92a2c1960da4',
  fileStage: '007e7962-337d-4df4-b9ba-d1021ff5f1b9',
  docType: 'd35e57f4-e2ab-41d0-bc81-adec84d5c8bd',
  sourceSubmission: '60b464c2-5b65-4b88-beab-4a9a6c406805',
  supersedes: 'df513361-c16c-461f-8419-7a97e2529cff',
  relatedDoctor: '5624e78f-23c4-4f7d-b4f4-8ba4fa1c63b1',
  state: '0a851a52-43fd-43e9-a980-6d8f7c59cc04',
  submittedBy: '29a970a2-c47b-419f-a7d2-039714f89b52',
  submissionDate: '677957d9-640e-4fda-80be-b1b7666070a8',
  reviewer: '9b057797-540f-49fb-a283-4cfe9eb3dba5'
};
const STAGE = {
  new: '9f1d4c94-0dd8-4b73-8b7a-3d69e9c470e7', filed: 'b1fd8836-7d0b-4d7e-b715-a66247beaf70',
  formResponse: '14316989-94b3-4e52-841e-abf0aea6bee7', doctorRecord: 'e6fd10ed-fa46-46ad-9356-3d145271b325',
  renewed: '1fcdf591-5844-4dba-900d-4e2b43074564', archived: '5a580de8-e267-4a1e-9993-415f79f9ca2e',
  processed: '06dc357b-e042-4dc1-a381-766b8294bf7b', requested: '1fd2c336-da7b-4ff2-acae-b3ed34662708',
  completed: '27ee11c7-8f8d-4e1a-8b88-10bba3bc2205'
};
const REVIEW = { approved: 'd16bee32-12b1-46cd-b50d-60a63f8db5c7', rejected: '1c460d8e-9302-4480-8c92-1ea2e96318d8',
  confirm: '93f2e556-d775-4bb5-8d85-4745dd704004' };
const SUBMITTED_BY_RECRUITER = 'fec426db-cc78-40ea-b2fd-f782de820be6';
const SUBMITTED_BY_DOCTOR = '30344cba-83f1-4171-a33b-edfe5bde0872';

const memberCache = { at: 0, list: [] };
function client(rawToken) {
  // Trim stray spaces/newlines from pasting; OAuth-style tokens need 'Bearer'.
  const t = String(rawToken || '').trim();
  const token = /^pk_/.test(t) ? t : 'Bearer ' + t;
  async function call(method, path, body) {
    const res = await fetch('https://api.clickup.com/api/v2/' + path, {
      method, headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error('ClickUp ' + method + ' ' + path.split('?')[0] + ' -> ' + res.status + ' ' + text.slice(0, 200));
    return text ? JSON.parse(text) : {};
  }
  const cf = (filters) => 'custom_fields=' + encodeURIComponent(JSON.stringify(filters));
  return {
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b),
    setField: (taskId, fieldId, value) => call('POST', 'task/' + taskId + '/field/' + fieldId, { value }),

    // Doctor record by Med Reg, searched across the doctor lists (same as the Splitter).
    async findDoctor(medReg) {
      for (const v of medRegVariants(medReg)) {
        const q = 'team/' + TEAM + '/task?include_closed=true&subtasks=true&' +
          DOCTOR_LISTS.map((l) => 'list_ids%5B%5D=' + l).join('&') + '&' + cf([{ field_id: F.medReg, operator: '=', value: v }]);
        const out = await call('GET', q);
        if (out.tasks && out.tasks.length) return out.tasks[0];
      }
      return null;
    },
    // Doctor record by the Email field (email intake: match the sender).
    async findDoctorByEmail(email) {
      const q = 'team/' + TEAM + '/task?include_closed=true&subtasks=true&' + DOCTOR_LISTS.map((l) => 'list_ids%5B%5D=' + l).join('&') + '&' +
        cf([{ field_id: F.email, operator: '=', value: String(email || '').trim().toLowerCase() }]);
      const out = await call('GET', q);
      return (out.tasks || []).find((t) => String(field(t, F.email) || '').trim().toLowerCase() === String(email).trim().toLowerCase()) || null;
    },
    // The "Dr <name>" parent in the Compliance Documents list.
    async findParent(medReg) {
      const out = await call('GET', 'list/' + COMPLIANCE_LIST + '/task?include_closed=true&subtasks=false&' +
        cf([{ field_id: F.medReg, operator: '=', value: medReg }, { field_id: F.fileStage, operator: '=', value: STAGE.doctorRecord }]));
      return (out.tasks || [])[0] || null;
    },
    // Workspace members (cached 10 min): used to match a staff sign-in to their ClickUp user.
    async members() {
      if (memberCache.at > Date.now() - 600000) return memberCache.list;
      const out = await call('GET', 'team');
      const team = (out.teams || []).find((t) => String(t.id) === TEAM) || { members: [] };
      memberCache.list = team.members.map((m) => m.user).filter(Boolean);
      memberCache.at = Date.now();
      return memberCache.list;
    },
    // Doctor records assigned to one ClickUp user, across the doctor lists.
    async doctorsFor(userId) {
      let page = 0, all = [];
      for (; page < 30; page++) {
        const out = await call('GET', 'team/' + TEAM + '/task?include_closed=false&subtasks=false&page=' + page + '&assignees%5B%5D=' + encodeURIComponent(userId) + '&' +
          DOCTOR_LISTS.map((l) => 'list_ids%5B%5D=' + l).join('&'));
        all = all.concat(out.tasks || []);
        if (out.last_page !== false || !(out.tasks || []).length) break;
      }
      return all;
    },
    // Compliance tasks at one File Stage (e.g. everything waiting for review).
    async byStage(stageId) {
      let page = 0, all = [];
      for (; page < 30; page++) {
        const out = await call('GET', 'list/' + COMPLIANCE_LIST + '/task?include_closed=true&subtasks=true&page=' + page + '&' +
          cf([{ field_id: F.fileStage, operator: '=', value: stageId }]));
        all = all.concat(out.tasks || []);
        if (out.last_page !== false || !(out.tasks || []).length) break;
      }
      return all;
    },
    // Every compliance document task for one doctor (used for supersede and the status copy).
    async listDocs(medReg) {
      let page = 0, all = [];
      for (;;) {
        const out = await call('GET', 'list/' + COMPLIANCE_LIST + '/task?include_closed=true&subtasks=true&page=' + page + '&' +
          cf([{ field_id: F.medReg, operator: '=', value: medReg }]));
        all = all.concat(out.tasks || []);
        if (out.last_page !== false || !(out.tasks || []).length) break;
        page++;
      }
      return all;
    }
  };
}

// The Splitter pads a 9-digit number with a leading 0; accept both shapes.
function medRegVariants(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  const digits = s.replace(/[^0-9]/g, '');
  const out = new Set([s]);
  if (digits.length === 9) out.add(s.replace(digits, '0' + digits));
  if (digits.length === 10 && digits[0] === '0') out.add(s.replace(digits, digits.slice(1)));
  return [...out].filter(Boolean);
}

function field(task, id) {
  const f = (task.custom_fields || []).find((x) => x.id === id);
  return f ? f.value : undefined;
}
// Dropdown values come back as an option index or id depending on endpoint; normalise to id.
function dropdownId(task, id) {
  const f = (task.custom_fields || []).find((x) => x.id === id);
  if (!f || f.value == null) return null;
  const opts = (f.type_config && f.type_config.options) || [];
  if (typeof f.value === 'number') return (opts.find((o) => o.orderindex === f.value) || {}).id || null;
  return f.value;
}

module.exports = { client, field, dropdownId, medRegVariants, F, STAGE, REVIEW, TEAM, COMPLIANCE_LIST, DOCTOR_LISTS, SUBMITTED_BY_DOCTOR, SUBMITTED_BY_RECRUITER };
