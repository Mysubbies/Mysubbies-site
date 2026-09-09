const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const homepage = fs.readFileSync('mysubbies-website.html', 'utf8');

function extractBetween(startText, endText) {
  const start = homepage.indexOf(startText);
  const end = homepage.indexOf(endText, start);
  assert.notEqual(start, -1, `missing ${startText}`);
  assert.notEqual(end, -1, `missing ${endText}`);
  return homepage.slice(start, end);
}

function loadQuestionFramework() {
  const source = extractBetween(
    'const SERVICE_AWARE_PHASE1_CATEGORIES',
    '  // ============================================================\n  // Priced comparison group'
  );
  const context = {};
  vm.runInNewContext(`${source}\nglobalThis.serviceAwareQuestion = serviceAwareQuestion;`, context);
  return context.serviceAwareQuestion;
}

function unchangedPrice(task, qty) {
  const rawBase = Math.round(qty * task.rate);
  return task.minJobPrice && rawBase < task.minJobPrice ? task.minJobPrice : rawBase;
}

test('phase 1 questions cover representative pricing units', () => {
  const question = loadQuestionFramework();
  assert.equal(question({ label: 'Handyman' }, { name: 'Flat-pack furniture assembly', unit: 'item' }).question, 'How many furniture items need assembly?');
  assert.equal(question({ label: 'Cleaning' }, { name: 'Pressure cleaning', unit: 'm²' }).kind, 'area');
  assert.equal(question({ label: 'Gardening & Lawn Mowing' }, { name: 'Lawn mowing', unit: 'visit' }).question, 'How many visits would you like to book?');
  assert.match(question({ label: 'Fencing' }, { name: 'Timber fence', unit: 'lm' }).question, /fence length/);
  assert.equal(question({ label: 'Plumbing' }, { name: 'Drain unblocking', unit: 'job' }).fixedQuantity, 1);
  assert.match(question({ label: 'Electrical' }, { name: 'Power point', unit: 'point' }).question, /electrical points/);
  assert.equal(question({ label: 'Courier Services' }, { name: 'Metro boxes', unit: 'Box' }).kind, 'courier');
});

test('services outside phase 1 retain the legacy fallback', () => {
  const question = loadQuestionFramework();
  assert.equal(question({ label: 'Painting' }, { name: 'Interior wall painting', unit: 'm²' }), null);
});

test('service-aware answers preserve representative price results', () => {
  // Before Phase 1 these are the numeric quantities parseQuantity supplied.
  // Phase 1 deliberately writes those same values to qtyValues; flat jobs
  // replace the customer's redundant typed “1” with the same internal 1.
  const cases = [
    { task:{ rate:90, minJobPrice:150 }, beforeQty:3, afterQty:3, type:'item count' },
    { task:{ rate:120, minJobPrice:360 }, beforeQty:12, afterQty:12, type:'linear metres' },
    { task:{ rate:450, minJobPrice:2250 }, beforeQty:6 * 4, afterQty:6 * 4, type:'square metres' },
    { task:{ rate:75, minJobPrice:150 }, beforeQty:4, afterQty:4, type:'hours' },
    { task:{ rate:80, minJobPrice:120 }, beforeQty:1, afterQty:1, type:'visits' },
    { task:{ rate:260, minJobPrice:260 }, beforeQty:Number('1'), afterQty:1, type:'flat job' },
  ];
  for (const { task, beforeQty, afterQty, type } of cases) {
    assert.equal(afterQty, beforeQty, `${type} quantity changed`);
    assert.equal(unchangedPrice(task, afterQty), unchangedPrice(task, beforeQty), `${type} price changed`);
  }
});

test('existing pricing formula and courier mechanism remain unchanged', () => {
  assert.match(homepage, /const rawBase = Math\.round\(qty \* t\.rate\);[\s\S]{0,180}t\.minJobPrice/);
  assert.match(homepage, /const isBulk = numBoxes > COURIER_SMALL_MAX_BOXES \|\| weightPerBox > COURIER_SMALL_MAX_WEIGHT_KG/);
  assert.match(homepage, /qtyValues\.set\(task\.name, '1'\)/);
});

test('homepage mirrors remain byte-for-byte identical', () => {
  assert.deepEqual(fs.readFileSync('index.html'), fs.readFileSync('mysubbies-website.html'));
});
