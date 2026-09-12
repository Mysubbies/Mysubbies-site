const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const addressAutocomplete = require('../js/address-autocomplete');
const geocodeDistance = require('../api/geocode-distance');

function response() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('Australian Google place is normalised for persistence and map use', () => {
  const parsed = addressAutocomplete.parsePlace({
    place_id: 'synthetic-place-id',
    formatted_address: '36 Test Street, Craigieburn VIC 3064, Australia',
    geometry: { location: { lat: () => -37.59, lng: () => 144.94 } },
    address_components: [
      { long_name: 'Craigieburn', short_name: 'Craigieburn', types: ['locality'] },
      { long_name: 'Victoria', short_name: 'VIC', types: ['administrative_area_level_1'] },
      { long_name: '3064', short_name: '3064', types: ['postal_code'] },
      { long_name: 'Australia', short_name: 'AU', types: ['country'] },
    ],
  });
  assert.deepEqual(parsed, {
    formattedAddress: '36 Test Street, Craigieburn VIC 3064, Australia', placeId: 'synthetic-place-id',
    latitude: -37.59, longitude: 144.94, suburb: 'Craigieburn', state: 'VIC', postcode: '3064', country: 'AU', verified: true,
  });
});

test('places config exposes only the intentionally public browser key', async () => {
  const before = process.env.GOOGLE_MAPS_BROWSER_API_KEY;
  process.env.GOOGLE_MAPS_BROWSER_API_KEY = 'browser-key-for-test';
  const res = response();
  await geocodeDistance({ method: 'GET', query: { config: 'places' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { enabled: true, browserKey: 'browser-key-for-test', country: 'au' });
  assert.match(res.headers['Cache-Control'], /max-age=300/);
  if (before === undefined) delete process.env.GOOGLE_MAPS_BROWSER_API_KEY;
  else process.env.GOOGLE_MAPS_BROWSER_API_KEY = before;
});

test('places autocomplete safely disables itself when no key is configured', async () => {
  const before = process.env.GOOGLE_MAPS_BROWSER_API_KEY;
  delete process.env.GOOGLE_MAPS_BROWSER_API_KEY;
  const res = response();
  await geocodeDistance({ method: 'GET', query: { config: 'places' } }, res);
  assert.deepEqual(res.body, { enabled: false, browserKey: null, country: 'au' });
  if (before !== undefined) process.env.GOOGLE_MAPS_BROWSER_API_KEY = before;
});

test('customer booking and contractor signup require a suggestion when Places is available', () => {
  const booking = readFileSync('mysubbies-booking.html', 'utf8');
  const contractor = readFileSync('mysubbies-contractor-signup.html', 'utf8');
  for (const page of [booking, contractor]) {
    assert.match(page, /js\/address-autocomplete\.js/);
    assert.match(page, /getSelection\('fAddress'\)/);
    assert.match(page, /Please select .*address from the suggestions/i);
    assert.match(page, /addressLocation:/);
  }
});

test('contractor location migration supports automatic internal map data', () => {
  const migration = readFileSync('supabase/schema_v24_address_locations.sql', 'utf8');
  for (const column of ['address_place_id', 'address_suburb', 'address_postcode', 'address_latitude', 'address_longitude', 'address_verified']) {
    assert.match(migration, new RegExp(column));
  }
  const sync = readFileSync('api/sync-applications.js', 'utf8');
  assert.match(sync, /addressColumns\(location\)/);
});
