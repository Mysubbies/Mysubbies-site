const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

const root = join(__dirname, '..');
const admin = readFileSync(join(root, 'mysubbies-admin-portal.html'), 'utf8');
const index = readFileSync(join(root, 'index.html'), 'utf8');
const website = readFileSync(join(root, 'mysubbies-website.html'), 'utf8');
const api = readFileSync(join(root, 'api/rate-card.js'), 'utf8');

function publicCategoryImage(category, slug) {
  const match = index.match(/function categoryCardImageHtml\(category, slug\) \{[\s\S]*?\n  \}/);
  assert(match, 'public category image renderer must exist');
  const context = {
    CATEGORY_FALLBACK_ICON: {},
    escapeHtml: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
  };
  const sandbox = { ...context, input: category, slugValue: slug, result: null };
  vm.runInNewContext(`${match[0]}; result = categoryCardImageHtml(input, slugValue);`, sandbox);
  return sandbox.result;
}

test('admin category image upload is atomically persisted by the upload API', () => {
  assert.match(admin, /action: 'upload-photo', target: 'category', dataUrl, catLabel, taskName: '__category__'/);
  assert.match(api, /if \(target === 'category'\)/);
  assert.match(api, /category\.photoUrl = url/);
  assert.match(api, /updated_by: 'admin'/);
  assert.match(admin, /id="rcNewCategoryPhoto"/);
  assert.match(admin, /onCategoryPhotoSelected/);
});

test('Epoxy public card prioritises uploaded image and retains static/icon fallbacks', () => {
  const uploaded = publicCategoryImage({ label: 'Epoxy', icon: '🔧', photoUrl: 'https://storage.example/epoxy-new.jpg' }, 'epoxy');
  assert.match(uploaded, /src="https:\/\/storage\.example\/epoxy-new\.jpg"/);
  assert.doesNotMatch(uploaded, /src="images\/categories\/epoxy\.jpg"/);

  const defaulted = publicCategoryImage({ label: 'Epoxy', icon: '🔧' }, 'epoxy');
  assert.match(defaulted, /src="images\/categories\/epoxy\.jpg"/);
  assert.match(defaulted, /nextElementSibling\.style\.display='grid'/);
  assert.match(defaulted, />🔧<\/div>/);
  assert.equal(index, website, 'index.html and mysubbies-website.html must remain synchronized');
});

test('removing a category image persists before the admin switches to fallback', () => {
  assert.match(admin, /action: 'remove-category-photo', catLabel/);
  assert.match(api, /if \(action === 'remove-category-photo'\)/);
  assert.match(api, /delete category\.photoUrl/);
  assert.match(admin, /if \(!res\.ok\) throw new Error\('remove failed'\)/);
});

test('legacy embedded category images migrate without changing task image flow', () => {
  assert.match(api, /if \(cat\.photoDataUrl && !cat\.photoUrl\)/);
  assert.match(api, /uploadPhoto\(supabase, cat\.label, '__category__', cat\.photoDataUrl\)/);
  assert.match(api, /if \(task\.photoDataUrl && !task\.photoUrl\)/);
});
