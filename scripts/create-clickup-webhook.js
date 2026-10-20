// One-off: tell ClickUp to call the portal whenever a Compliance Documents task changes.
// Run:  CLICKUP_TOKEN=pk_... node scripts/create-clickup-webhook.js https://<clickupWebhook function URL>
// It prints a secret: save it with  firebase functions:secrets:set CLICKUP_WEBHOOK_SECRET
const url = process.argv[2];
if (!url || !process.env.CLICKUP_TOKEN) { console.error('Usage: CLICKUP_TOKEN=... node scripts/create-clickup-webhook.js <function url>'); process.exit(1); }
fetch('https://api.clickup.com/api/v2/team/9016018501/webhook', {
  method: 'POST', headers: { Authorization: process.env.CLICKUP_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ endpoint: url, list_id: 901616167201,
    events: ['taskCreated', 'taskUpdated', 'taskStatusUpdated', 'taskDueDateUpdated', 'taskDeleted'] })
}).then((r) => r.json()).then((o) => {
  if (!o.webhook) { console.error(o); process.exit(1); }
  console.log('Webhook id:', o.webhook.id, '\nSecret (save as CLICKUP_WEBHOOK_SECRET):', o.webhook.secret);
});
