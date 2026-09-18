// AI-ready booking surface. This endpoint deliberately exposes only public service/pricing
// information and authenticated customer-owned job status. It does NOT expose contractor
// identities, admin data, service-role credentials or other customers' records.
const { getSupabase } = require('./_lib/clients');
const { requireAccount } = require('./_lib/userAuth');
const { loadCategories, publicCatalog, estimateLine } = require('./_lib/serviceCatalog');

module.exports = async (req, res) => {
  try {
    const supabase = getSupabase();
    const action = String((req.query && req.query.action) || (req.body && req.body.action) || 'catalog');

    if (req.method === 'GET' && action === 'catalog') {
      const { categories, updatedAt } = await loadCategories(supabase);
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.status(200).json({
        currency: 'AUD',
        gstInclusive: true,
        operatingRegion: 'Melbourne, Victoria',
        pricingModel: { predictable: 'instant_price', variable: 'project_quote' },
        updatedAt,
        categories: publicCatalog(categories),
      });
      return;
    }

    if (req.method === 'GET' && action === 'service-areas') {
      res.status(200).json({
        country: 'AU',
        state: 'VIC',
        market: 'Melbourne',
        status: 'pilot',
        note: 'Final eligibility is checked from the supplied address/suburb during booking. No contractor home/base locations are exposed.',
      });
      return;
    }

    if (req.method === 'POST' && action === 'estimate') {
      const { category, taskName, qty } = req.body || {};
      const { categories } = await loadCategories(supabase);
      const estimate = estimateLine(categories, { category, taskName, qty });
      if (!estimate.ok) {
        res.status(estimate.serviceMode === 'project_quote' ? 200 : 400).json({
          serviceMode: estimate.serviceMode || 'project_quote',
          reason: estimate.reason,
        });
        return;
      }
      res.status(200).json({ currency: 'AUD', gstInclusive: true, ...estimate });
      return;
    }

    if (req.method === 'GET' && action === 'job-status') {
      const auth = await requireAccount(supabase, req, 'customer');
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
      const jobId = String((req.query && req.query.jobId) || '');
      if (!jobId) { res.status(400).json({ error: 'jobId is required.' }); return; }
      const { data, error } = await supabase.from('jobs')
        .select('id, job_number, category, suburb, status, stage, full_record, created_at, updated_at')
        .eq('id', jobId).eq('customer_email', String(auth.account.email).toLowerCase()).maybeSingle();
      if (error) throw error;
      if (!data) { res.status(404).json({ error: 'Job not found.' }); return; }
      const fr = data.full_record || {};
      res.status(200).json({
        id: data.id,
        jobNumber: data.job_number,
        category: data.category,
        suburb: data.suburb,
        status: fr.operationalStage || data.stage || data.status,
        scheduledDate: fr.scheduledDate || null,
        scheduledTime: fr.scheduledTime || null,
        updatedAt: data.updated_at || null,
      });
      return;
    }

    res.status(405).json({ error: 'Unsupported action or method.' });
  } catch (err) {
    console.error('booking-api error:', err);
    res.status(500).json({ error: 'Could not complete the booking API request.' });
  }
};
