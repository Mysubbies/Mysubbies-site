// MySubbies AI Workforce: isolated prospect ingestion core.
// This module does NOT fetch data, send messages, or run on a schedule.
// Call only from a separately authenticated server-side admin endpoint.
function clean(value, limit = 300) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
function normalizeProspect(raw) {
  const business_name = clean(raw?.business_name);
  const category = clean(raw?.category, 100);
  const suburb = clean(raw?.suburb, 100);
  const source_url = clean(raw?.source_url, 1000);
  const provider = clean(raw?.provider, 100);
  if (!business_name || !category || !suburb || !provider || !/^https:\/\//i.test(source_url)) {
    throw new Error('Prospect must include business name, category, suburb, provider and HTTPS source URL');
  }
  return {
    business_name, category, suburb, source_url, provider,
    provider_place_id: clean(raw?.provider_place_id, 200) || null,
    website: clean(raw?.website, 1000) || null,
    phone: clean(raw?.phone, 50) || null,
    public_email: clean(raw?.public_email, 254) || null
  };
}
async function ingestProspects(supabase, rawProspects, { maxBatch = 25 } = {}) {
  if (!Array.isArray(rawProspects) || rawProspects.length > maxBatch) throw new Error('Invalid batch size');
  const rows = rawProspects.map(normalizeProspect);
  // Only provider IDs can be safely upserted. No guesswork on business names.
  const withIds = rows.filter(r => r.provider_place_id);
  const withoutIds = rows.filter(r => !r.provider_place_id);
  let stored = 0;
  if (withIds.length) {
    const { error } = await supabase.from('ai_prospects').upsert(withIds, { onConflict: 'provider,provider_place_id', ignoreDuplicates: true });
    if (error) throw error;
    stored += withIds.length;
  }
  // Missing provider IDs require human deduplication; do not insert automatically.
  return { processed: rows.length, submitted: stored, needs_review: withoutIds.length };
}
module.exports = { normalizeProspect, ingestProspects };
