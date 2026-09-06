// POST /api/geocode-distance
// Body: { pickup: string, delivery: string,
//         pickupLat?, pickupLon?, deliveryLat?, deliveryLon? }
// Response: { zone: 'serviceable'|'out_of_range', pickupToDeliveryKm, pickupResolved, deliveryResolved }
//
// Backs the Courier Services "Boxes" quoting flow in mysubbies-website.html
// (calculateCourierBoxesPrice()). Pricing itself (the distance-banded
// ladder) lives client-side in courierBoxLadderPrice() -- this endpoint's
// only job is turning two addresses into a real distance.
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
// whenever the pickup<->delivery distance is <=150km -- this replaced an
// earlier two-metric Metro/Regional-from-CBD design; the ladder is keyed
// entirely off pickup<->delivery distance now, so eligibility uses the same
// metric as pricing. Anything beyond 150km is out_of_range -- there is no
// rate card price for it, so no price is shown rather than extrapolating
// one.
//
// Nominatim's usage policy caps free use at ~1 request/second and requires
// a real identifying User-Agent (set below) -- fine for this app's expected
// volume, and even less relevant once Places Autocomplete is configured
// (most requests then arrive with coordinates already attached, skipping
// Nominatim entirely).

const MAX_SERVICE_KM = 150;

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

async function geocode(address) {
  const q = /australia/i.test(address) ? address : `${address}, Victoria, Australia`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MySubbies-Courier-Quoting/1.0 (accounts@mysubbies.com.au)' },
  });
  if (!res.ok) throw new Error('Geocoding service unavailable');
  const results = await res.json();
  if (!Array.isArray(results) || results.length === 0) return null;
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon), displayName: results[0].display_name };
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
