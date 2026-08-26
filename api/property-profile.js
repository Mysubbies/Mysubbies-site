// GET /api/property-profile?customerEmail=...
//
// Returns this customer's Property Profile(s) -- every address they've
// booked a job at, each with its history timeline of *completed* jobs
// (auto-populated by api/sync-jobs.js on every job sync, see that file and
// supabase/schema_v5_property_profiles.sql). Mirrors api/get-jobs.js's
// shape/conventions: same client, same "read full_record for the customer's
// own jobs" approach for finding which addresses belong to them, since
// property_profiles/property_history are address-keyed, not customer-keyed
// (a property's history is meant to outlive any one customer account).
const { getSupabase } = require('./_lib/clients');

function normalizeAddress(addr) {
  return String(addr || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { customerEmail } = req.query || {};
    if (!customerEmail) { res.status(400).json({ error: 'customerEmail is required.' }); return; }

    const supabase = getSupabase();

    const { data: jobRows, error: jobsErr } = await supabase
      .from('jobs')
      .select('full_record')
      .eq('customer_email', customerEmail)
      .not('full_record', 'is', null);
    if (jobsErr) throw jobsErr;

    const normalizedAddresses = Array.from(new Set(
      (jobRows || [])
        .map(r => normalizeAddress(r.full_record && r.full_record.address))
        .filter(Boolean)
    ));

    if (normalizedAddresses.length === 0) { res.status(200).json({ properties: [] }); return; }

    const { data: profiles, error: profilesErr } = await supabase
      .from('property_profiles')
      .select('id, address, suburb, normalized_address')
      .in('normalized_address', normalizedAddresses);
    if (profilesErr) throw profilesErr;

    const propertyIds = (profiles || []).map(p => p.id);
    let historyByProperty = {};
    if (propertyIds.length > 0) {
      const { data: history, error: historyErr } = await supabase
        .from('property_history')
        .select('property_id, job_id, category, task_summary, contractor_name, contractor_email, amount_paid_cents, completed_at')
        .in('property_id', propertyIds)
        .order('completed_at', { ascending: false });
      if (historyErr) throw historyErr;
      (history || []).forEach(h => {
        if (!historyByProperty[h.property_id]) historyByProperty[h.property_id] = [];
        historyByProperty[h.property_id].push({
          jobId: h.job_id,
          category: h.category,
          taskSummary: h.task_summary,
          contractorName: h.contractor_name,
          contractorEmail: h.contractor_email,
          amountPaidCents: h.amount_paid_cents,
          completedAt: h.completed_at,
        });
      });
    }

    const properties = (profiles || []).map(p => ({
      propertyId: p.id,
      address: p.address,
      suburb: p.suburb,
      history: historyByProperty[p.id] || [],
    }));

    res.status(200).json({ properties });
  } catch (err) {
    console.error('property-profile error:', err);
    res.status(500).json({ error: 'Could not load property profile.' });
  }
};
