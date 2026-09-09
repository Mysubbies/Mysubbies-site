const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const admin = readFileSync(join(root, 'mysubbies-admin-portal.html'), 'utf8');
const index = readFileSync(join(root, 'index.html'), 'utf8');
const website = readFileSync(join(root, 'mysubbies-website.html'), 'utf8');
const api = readFileSync(join(root, 'api/rate-card.js'), 'utf8');

test('admin category image uses the rate-card upload and persistence path', () => {
  assert.match(admin, /action: 'upload-photo', dataUrl, catLabel, taskName: '__category__'/);
  assert.match(admin, /cat\.photoUrl = url/);
  assert.match(admin, /saveRateCard\(categories\)/);
  assert.match(admin, /id="rcNewCategoryPhoto"/);
  assert.match(admin, /onCategoryPhotoSelected/);
});

test('public category cards prefer the saved category image with a safe fallback', () => {
  assert.match(index, /category\.photoUrl \|\| category\.photoDataUrl \|\| `images\/categories\/\$\{slug\}\.jpg`/);
  assert.match(index, /onerror="this\.style\.display='none';this\.nextElementSibling\.style\.display='grid'"/);
  assert.equal(index, website, 'index.html and mysubbies-website.html must remain synchronized');
});

test('legacy embedded category images migrate to storage without affecting task images', () => {
  assert.match(api, /if \(cat\.photoDataUrl && !cat\.photoUrl\)/);
  assert.match(api, /uploadPhoto\(supabase, cat\.label, '__category__', cat\.photoDataUrl\)/);
  assert.match(api, /if \(task\.photoDataUrl && !task\.photoUrl\)/);
});
