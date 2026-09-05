// POST /api/geocode-distance
// Body: { pickup: string, delivery: string }
// Response: { zone: 'metro'|'regional'|'out_of_range', pickupToDeliveryKm, cbdPickupKm, cbdDeliveryKm, pickupResolved, deliveryResolved }
//
// Backs the Courier Services "Boxes" quoting flow in mysubbies-website.html
// (calculateCourierBoxesPrice()). Geocodes both addresses via OpenStreetMap's
// free Nominatim API (no API key/billing needed -- confirmed with the
// founder in favour of a paid Google Maps alternative) then classifies the
// job using straight-line (haversine) distance, not driving distance.
//
// Zone rule, confirmed directly with the founder (not assumed):
//   - Metro:    distance BETWEEN pickup and delivery is <=15km.
//   - Regional: BOTH pickup and delivery are within 150km of the Melbourne
//               CBD -- this is a separate check from the pickup<->delivery
//               distance, so two points that are both far from the CBD but
//               close to each other do NOT count as Metro.
//   - Anything outside both bands is out_of_range -- there is no rate card
//     price for it, so no price is shown rather than extrapolating one.
//
// Nominatim's usage policy caps free use at ~1 request/second and requires
// a real identifying User-Agent (set below) -- fine for this app's expected
// volume, but if courier volume grows significantly this should move to a
// paid geocoder (Google/Mapbox) or a self-hosted Nominatim instance.

const MELBOURNE_CBD = { lat: -37.8136, lon: 144.9631 };
const METRO_RADIUS_KM = 15;
const REGIONAL_RADIUS_KM = 150;

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { pickup, delivery } = req.body || {};
    if (!pickup || !delivery) {
      res.status(400).json({ error: 'pickup and delivery are required.' });
      return;
    }

    const [pickupGeo, deliveryGeo] = await Promise.all([geocode(pickup), geocode(delivery)]);
    if (!pickupGeo) { res.status(422).json({ error: `Couldn't find "${pickup}" — please check the pickup address.` }); return; }
    if (!deliveryGeo) { res.status(422).json({ error: `Couldn't find "${delivery}" — please check the delivery address.` }); return; }

    const pickupToDeliveryKm = haversineKm(pickupGeo, deliveryGeo);
    const cbdPickupKm = haversineKm(MELBOURNE_CBD, pickupGeo);
    const cbdDeliveryKm = haversineKm(MELBOURNE_CBD, deliveryGeo);

    let zone;
    if (pickupToDeliveryKm <= METRO_RADIUS_KM) zone = 'metro';
    else if (cbdPickupKm <= REGIONAL_RADIUS_KM && cbdDeliveryKm <= REGIONAL_RADIUS_KM) zone = 'regional';
    else zone = 'out_of_range';

    res.status(200).json({
      zone,
      pickupToDeliveryKm: Math.round(pickupToDeliveryKm * 10) / 10,
      cbdPickupKm: Math.round(cbdPickupKm * 10) / 10,
      cbdDeliveryKm: Math.round(cbdDeliveryKm * 10) / 10,
      pickupResolved: pickupGeo.displayName,
      deliveryResolved: deliveryGeo.displayName,
    });
  } catch (err) {
    console.error('geocode-distance error:', err);
    res.status(500).json({ error: 'Could not calculate the distance for this job. Please try again.' });
  }
};
