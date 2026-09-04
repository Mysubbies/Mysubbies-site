// GET  /api/rate-card
// POST /api/rate-card { categories }                                  (admin-gated, normal save)
// POST /api/rate-card { action:'upload-photo', dataUrl, catLabel, taskName } (admin-gated)
// POST /api/rate-card { action:'migrate-photos' }                     (admin-gated, one-time)
//
// The single authoritative copy of the rate card (see
// supabase/schema_v12_rate_card_sync.sql for why this exists — previously
// every browser's rate card was purely local, so an admin price/disable/
// removal never reached any customer). GET is ungated: every visitor's
// estimator needs to read this to price a job, same posture as
// GET /api/get-jobs. POST is admin-only.
//
// upload-photo / migrate-photos (added Sep 2026): task photos used to be
// embedded as base64 directly inside `categories` (photoDataUrl), so every
// photo added to the size of the ENTIRE categories blob that
// mysubbies-admin-portal.html's saveRateCard() re-sends on every single
// edit. At ~83 photos that blob reached ~4.27MB — right at Vercel's
// Serverless Function request-body ceiling (~4.3MB, confirmed by testing)
// — so every save past that point returned a silent 413 that the client
// swallowed: photos looked like they'd saved (optimistic local render)
// but never reached the server or any customer's browser. Storing photos
// in Supabase Storage and keeping only a short `photoUrl` string in the
// jsonb blob removes the ceiling entirely instead of just deferring it a
// few dozen photos further. `migrate-photos` is a one-time admin action
// that converts every already-embedded photoDataUrl this way, entirely
// server-side (reads/writes Supabase directly — never passes back through
// an HTTP body), so it isn't subject to the very limit it's fixing.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');

const PHOTO_BUCKET = 'rate-card-photos';

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'photo';
}

async function ensurePhotoBucket(supabase) {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (buckets && buckets.some(b => b.name === PHOTO_BUCKET)) return;
  const { error } = await supabase.storage.createBucket(PHOTO_BUCKET, { public: true, fileSizeLimit: '2MB' });
  if (error && !/already exists/i.test(error.message || '')) throw error;
}

function dataUrlToBuffer(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

async function uploadPhoto(supabase, catLabel, taskName, dataUrl) {
  const parsed = dataUrlToBuffer(dataUrl);
  if (!parsed) throw new Error('Invalid image data.');
  const path = `${slugify(catLabel)}/${slugify(taskName)}-${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`;
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, parsed.buffer, {
    contentType: parsed.contentType || 'image/jpeg', upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase.from('platform_rate_card').select('categories, updated_at').eq('id', true).maybeSingle();
      if (error) throw error;
      res.status(200).json({ categories: data ? data.categories : null, updatedAt: data ? data.updated_at : null });
    } catch (err) {
      console.error('rate-card GET error:', err);
      res.status(500).json({ error: 'Could not fetch the rate card.' });
    }
    return;
  }

  if (req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const { action } = req.body || {};

    if (action === 'upload-photo') {
      try {
        const { dataUrl, catLabel, taskName } = req.body || {};
        if (!dataUrl) { res.status(400).json({ error: 'dataUrl is required.' }); return; }
        await ensurePhotoBucket(supabase);
        const url = await uploadPhoto(supabase, catLabel, taskName, dataUrl);
        res.status(200).json({ url });
      } catch (err) {
        console.error('rate-card upload-photo error:', err);
        res.status(500).json({ error: 'Could not upload the photo.' });
      }
      return;
    }

    if (action === 'migrate-photos') {
      try {
        const { data, error } = await supabase.from('platform_rate_card').select('categories').eq('id', true).maybeSingle();
        if (error) throw error;
        const categories = (data && data.categories) || [];
        await ensurePhotoBucket(supabase);
        let migrated = 0;
        for (const cat of categories) {
          for (const task of cat.tasks || []) {
            if (task.photoDataUrl && !task.photoUrl) {
              task.photoUrl = await uploadPhoto(supabase, cat.label, task.name, task.photoDataUrl);
              delete task.photoDataUrl;
              migrated++;
            }
          }
        }
        const { error: saveErr } = await supabase.from('platform_rate_card').upsert({
          id: true, categories, updated_by: 'admin-migration', updated_at: new Date().toISOString(),
        });
        if (saveErr) throw saveErr;
        res.status(200).json({ migrated });
      } catch (err) {
        console.error('rate-card migrate-photos error:', err);
        res.status(500).json({ error: 'Could not migrate photos.' });
      }
      return;
    }

    try {
      const { categories } = req.body || {};
      if (!Array.isArray(categories)) { res.status(400).json({ error: 'categories must be an array.' }); return; }
      const { error } = await supabase.from('platform_rate_card').upsert({
        id: true, categories, updated_by: 'admin', updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      res.status(200).json({ saved: true });
    } catch (err) {
      console.error('rate-card POST error:', err);
      res.status(500).json({ error: 'Could not save the rate card.' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
