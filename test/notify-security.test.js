const test = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/notify');

function invoke(type) {
  return new Promise(resolve => {
    const req = { method: 'POST', body: { type, customerEmail: 'victim@example.com', category: 'Plumbing' } };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
    handler(req, res);
  });
}

test('public clients cannot spoof customer assignment notifications', async () => {
  const response = await invoke('job-assigned');
  assert.equal(response.status, 410);
});
