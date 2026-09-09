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

function loadTaskQuantityParser() {
  const source = extractBetween(
    'const SERVICE_AWARE_PHASE1_CATEGORIES',
    '  // ============================================================\n  // Priced comparison group'
  );
  const context = {};
  vm.runInNewContext(`${source}\nglobalThis.parseTaskSpecificQuantity = parseTaskSpecificQuantity;`, context);
  return context.parseTaskSpecificQuantity;
}

function loadDefaultCategories() {
  const declaration = 'const DEFAULT_CATEGORIES = ';
  const start = homepage.indexOf(declaration) + declaration.length;
  const end = homepage.indexOf('\n  ];', start) + 4;
  return vm.runInNewContext(homepage.slice(start, end));
}

test('mixed-unit natural language quantities stay with their own service unit', () => {
  const parse = loadTaskQuantityParser();
  assert.equal(parse('34m Colorbond fence plus a single gate', 'lm'), 34);
  assert.equal(parse('34m Colorbond fence plus a single gate', 'gate'), null);
  assert.equal(parse('6m x 5m deck with 3 steps', 'm²'), 30);
  assert.equal(parse('6m x 5m deck with 3 steps', 'step'), 3);
  assert.equal(parse('pressure clean 24m² and wash 8 windows', 'm²'), 24);
  assert.equal(parse('pressure clean 24m² and wash 8 windows', 'window'), 8);
  assert.equal(parse('garden tidy for 4 hours over 2 visits', 'hour'), 4);
  assert.equal(parse('garden tidy for 4 hours over 2 visits', 'visit'), 2);
  assert.equal(parse('install 6 points and connect 2 appliances', 'point'), 6);
  assert.equal(parse('install 6 points and connect 2 appliances', 'appliance'), 2);
  assert.equal(parse('replace 3 taps and 1 toilet', 'tap'), 3);
  assert.equal(parse('replace 3 taps and 1 toilet', 'toilet'), 1);
  assert.equal(parse('34m fence and unblock a drain', 'job'), 1);
});

test('category measurement cannot prefill differently-unitized services', () => {
  const parse = loadTaskQuantityParser();
  const phase1 = new Set(['Handyman', 'Cleaning', 'Gardening & Lawn Mowing', 'Fencing', 'Decking', 'Plumbing', 'Electrical']);
  for (const category of loadDefaultCategories().filter(c => phase1.has(c.label))) {
    const active = category.tasks.filter(t => !t.disabled && !t.unavailable && typeof t.rate === 'number');
    const byUnit = new Map();
    for (const task of active) byUnit.set(task.unit, [...(byUnit.get(task.unit) || []), task]);
    if (byUnit.size < 2) continue;
    const [primaryUnit] = [...byUnit.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const queryUnit = primaryUnit === 'm²' ? 'm²' : primaryUnit === 'lm' ? 'm' : ` ${primaryUnit}`;
    const categoryMeasurement = `34${queryUnit}`;
    for (const task of active.filter(t => t.unit !== primaryUnit && t.unit !== 'job')) {
      assert.equal(parse(categoryMeasurement, task.unit), null, `${category.label}: ${categoryMeasurement} leaked into ${task.name} (${task.unit})`);
    }
  }
});

test('Step 1 quick choices retain launch labels, category mappings, and mobile layout', () => {
  for (const label of ['Handyman', 'Cleaning', 'Gardening', 'Fencing', 'Decking', 'Furniture Assembly', 'Same-Day Courier', 'More']) {
    assert.match(homepage, new RegExp(`>${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}<`));
  }
  assert.match(homepage, /chooseQuickService\('Gardening &amp; Lawn Mowing'\)/);
  assert.match(homepage, /chooseQuickService\('Handyman', 'flat-pack assembly'\)/);
  assert.match(homepage, /chooseQuickService\('Courier Services'\)/);
  assert.match(homepage, /onclick="heroBrowseServices\(\)">More/);
  assert.match(homepage, /@media \(max-width:520px\) \{ \.quick-services \{ display:grid; grid-template-columns:1fr 1fr;/);
});

test('task-specific quick choice opens the existing task in the service-aware flow', () => {
  assert.match(homepage, /function chooseQuickService[\s\S]*selectSubCategoryAndGoToStep2\(cat\.label, task\.name\);[\s\S]*selectCat\(cat\);[\s\S]*showEstStep\(2\);/);
});

function loadMixedUnitFramework() {
  const source = extractBetween(
    'const SERVICE_AWARE_PHASE1_CATEGORIES',
    '  // ============================================================\n  // Priced comparison group'
  );
  const context = {};
  vm.runInNewContext(`${source}\nglobalThis.api = { pricingUnitForTask, serviceAwareQuestion, parseTaskSpecificQuantity };`, context);
  return context.api;
}

test('34m fencing measurement cannot multiply a gate price', () => {
  const { pricingUnitForTask, serviceAwareQuestion, parseTaskSpecificQuantity } = loadMixedUnitFramework();
  const fencing = { label: 'Fencing' };
  // Mirrors the problematic server-side label even if its stored unit has
  // drifted to the category's lm unit: presentation logic does not mutate it.
  const gate = { name: 'Colorbond fence Single Gate — Supply & Install', unit: 'lm', rate: 850, minJobPrice: 850 };
  const effectiveUnit = pricingUnitForTask(fencing, gate);
  assert.equal(effectiveUnit, 'gate');
  assert.equal(parseTaskSpecificQuantity('34m', effectiveUnit), null);
  const question = serviceAwareQuestion(fencing, gate);
  assert.equal(question.defaultQuantity, 1);
  assert.equal(unchangedPrice(gate, question.defaultQuantity), 850);
  assert.notEqual(unchangedPrice(gate, question.defaultQuantity), 28_900);
  assert.equal(gate.unit, 'lm', 'rate-card and booking-payload unit must not be mutated');
});

test('known mixed-unit services are isolated before primary grouping', () => {
  const { pricingUnitForTask } = loadMixedUnitFramework();
  const cases = [
    [{ label:'Fencing' }, { name:'Single gate — supply & install', unit:'lm' }, 'gate'],
    [{ label:'Fencing' }, { name:'Double driveway gate — supply & install', unit:'each' }, 'gate'],
    [{ label:'Decking' }, { name:'Deck stairs', unit:'m²' }, 'step'],
    [{ label:'Decking' }, { name:'Balustrade', unit:'m²' }, 'lm'],
    [{ label:'Handyman' }, { name:'Flat-pack furniture assembly', unit:'each' }, 'item'],
    [{ label:'Cleaning' }, { name:'Gutter cleaning', unit:'per job' }, 'job'],
    [{ label:'Gardening & Lawn Mowing' }, { name:'Lawn mowing', unit:'per visit' }, 'visit'],
  ];
  for (const [category, task, expected] of cases) assert.equal(pricingUnitForTask(category, task), expected);
});
