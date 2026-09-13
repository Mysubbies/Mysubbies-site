// POST /api/geocode-distance
// Body: { pickup: string, delivery: string,
//         pickupLat?, pickupLon?, deliveryLat?, deliveryLon? }
// Response: { zone: 'serviceable'|'out_of_range', pickupToDeliveryKm, pickupResolved, deliveryResolved }
//
// Backs the Courier Services "Boxes"/"Bulk" quoting flow in
// mysubbies-website.html (calculateCourierBoxesPrice()). Pricing itself is
// a hardcoded 4-way table there (metro/regional x small/bulk) -- this
// endpoint's only job is turning two addresses into a real distance, used
// both to pick metro vs regional and to gate the 200km service area.
//
// Sep 2026 (founder feedback, real address typo caused a false "not
// found"): when the client already has a precise lat/lon for an address --
// from a Google Places Autocomplete selection -- it's sent directly via
// pickupLat/pickupLon/deliveryLat/deliveryLon, skipping geocoding for that
// side entirely (this is strictly more reliable, since a selected place is
// guaranteed real, unlike free-text that Nominatim must parse). Plain
// address text is still geocoded via OpenStreetMap's free Nominatim API
// (no API key/billing) as a fallback for whenever Places isn't
// configured/loaded, or the customer typed an address without selecting a
// suggestion.
//
// Serviceability rule (confirmed with the founder): the job is quotable
// whenever the pickup<->delivery distance is <=200km -- this replaced an
// earlier two-metric Metro/Regional-from-CBD design; eligibility is keyed
// entirely off pickup<->delivery distance now. Anything beyond 200km is
// out_of_range -- there is no fixed rate for a delivery that far, so no
// price is shown rather than extrapolating one.
//
// Nominatim's usage policy caps free use at ~1 request/second and requires
// a real identifying User-Agent (set below) -- fine for this app's expected
// volume, and even less relevant once Places Autocomplete is configured
// (most requests then arrive with coordinates already attached, skipping
// Nominatim entirely).
//
// Address-matching retry (Sep 2026, real founder report: valid addresses
// sometimes came back "couldn't find this address"). Two real causes found
// and fixed:
//   1. The old code always appended ", Victoria, Australia" unless the
//      literal word "Australia" was already present -- even for an address
//      that already named a DIFFERENT state (e.g. "...Sydney NSW"), which
//      produced a geographically contradictory query ("...NSW, Victoria,
//      Australia") that Nominatim can't resolve. Now only appended when no
//      Australian state/territory is already named.
//   2. Nominatim frequently fails to resolve a unit/suite/apartment prefix
//      even though the underlying street address is completely real (e.g.
//      "Unit 3/45 Smith St"). If the first lookup comes back empty, a
//      second attempt strips that prefix and retries once before giving up.

const MAX_SERVICE_KM = 200;

const AU_STATE_PATTERN = /\b(vic|nsw|qld|sa|wa|tas|nt|act|victoria|new south wales|queensland|south australia|western australia|tasmania|northern territory|australian capital territory)\b/i;

function toRad(deg) { return (deg * Math.PI) / 180; }

function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// "Unit 3/45 Smith St" / "3/45 Smith St" / "Suite 2, 10 High St" -> the
// plain street address, since Nominatim often can't resolve the sub-unit
// part even when the street address itself is real.
function stripUnitPrefix(address) {
  return address
    .replace(/^\s*(unit|suite|apt|apartment|shop|level|flat)\s*\w*\s*[,/]\s*/i, '')
    .replace(/^\s*\d+[a-z]?\/(?=\d)/i, '');
}

function buildQuery(address) {
  const hasCountry = /australia/i.test(address);
  if (hasCountry) return address;
  const hasState = AU_STATE_PATTERN.test(address);
  return hasState ? `${address}, Australia` : `${address}, Victoria, Australia`;
}

async function geocodeOnce(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MySubbies-Courier-Quoting/1.0 (accounts@mysubbies.com.au)' },
  });
  if (!res.ok) throw new Error('Geocoding service unavailable');
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) return null;
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon), displayName: results[0].display_name };
}

async function geocode(rawAddress) {
  const address = String(rawAddress || '').trim();
  const first = await geocodeOnce(buildQuery(address));
  if (first) return first;
  const stripped = stripUnitPrefix(address);
  if (stripped === address) return null;
  return geocodeOnce(buildQuery(stripped));
}

function isFiniteNum(n) { return typeof n === 'number' && Number.isFinite(n); }

// Resolves one side (pickup or delivery) to { lat, lon, displayName } --
// direct coordinates win when present, otherwise falls back to geocoding
// the address text.
async function resolveSide(address, lat, lon) {
  if (isFiniteNum(lat) && isFiniteNum(lon)) {
    return { lat, lon, displayName: address || `${lat}, ${lon}` };
  }
  return geocode(address);
}

module.exports = async (req, res) => {
  // The Google Maps browser key is intentionally public, but it is supplied
  // from environment configuration so each Vercel environment can use a
  // separately domain-restricted key. Never put a server key here.
  if (req.method === 'GET' && req.query && req.query.config === 'places') {
    res.setHeader('Cache-Control', 'private, max-age=300');
    const browserKey = String(process.env.GOOGLE_MAPS_BROWSER_API_KEY || '').trim();
    res.status(200).json({ enabled: !!browserKey, browserKey: browserKey || null, country: 'au' });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { pickup, delivery, pickupLat, pickupLon, deliveryLat, deliveryLon } = req.body || {};
    if (!pickup || !delivery) {
      res.status(400).json({ error: 'pickup and delivery are required.' });
      return;
    }

    const [pickupGeo, deliveryGeo] = await Promise.all([
      resolveSide(pickup, pickupLat, pickupLon),
      resolveSide(delivery, deliveryLat, deliveryLon),
    ]);
    if (!pickupGeo) { res.status(422).json({ error: `Couldn't find "${pickup}" — please check the pickup address.` }); return; }
    if (!deliveryGeo) { res.status(422).json({ error: `Couldn't find "${delivery}" — please check the delivery address.` }); return; }

    const pickupToDeliveryKm = haversineKm(pickupGeo, deliveryGeo);
    const zone = pickupToDeliveryKm <= MAX_SERVICE_KM ? 'serviceable' : 'out_of_range';

    res.status(200).json({
      zone,
      pickupToDeliveryKm: Math.round(pickupToDeliveryKm * 10) / 10,
      pickupResolved: pickupGeo.displayName,
      deliveryResolved: deliveryGeo.displayName,
    });
  } catch (err) {
    console.error('geocode-distance error:', err);
    res.status(500).json({ error: 'Could not calculate the distance for this job. Please try again.' });
  }
};
