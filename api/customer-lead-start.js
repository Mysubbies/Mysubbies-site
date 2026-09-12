// POST /api/customer-lead-start
// Captures an authenticated customer as BOOKING_STARTED as soon as they
// finish the customer-details step and enter the booking/payment flow.
const { getSupabase } = require('./_lib/clients');
const { requireAccount } = require('./_lib/userAuth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { jobId, category, suburb, attribution, marketingConsent, marketingConsentAt } = req.body || {};
    if (!jobId || !category) { res.status(400).json({ error: 'jobId and category are required.' }); return; }

    const supabase = getSupabase();
    const auth = await requireAccount(supabase, req, 'customer');
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }

    const bounded = value => value == null ? null : String(value).slice(0, 500);
    const campaign = attribution && typeof attribution === 'object' ? attribution : {};
    const email = String(auth.account.email).toLowerCase();

    const { data: priorLead } = await supabase.from('customer_leads')
      .select('stage, booking_status').eq('booking_job_id', jobId).maybeSingle();

    const { data: lead, error } = await supabase.from('customer_leads').upsert({
      booking_job_id: jobId,
      customer_id: auth.account.id,
      name: bounded(auth.account.name),
      email,
      mobile: bounded(auth.account.phone),
      requested_service: bounded(category),
      suburb: bounded(suburb),
      source: bounded(campaign.utm_source || campaign.referrer || 'direct'),
      utm_source: bounded(campaign.utm_source),
      utm_medium: bounded(campaign.utm_medium),
      utm_campaign: bounded(campaign.utm_campaign),
      utm_content: bounded(campaign.utm_content),
      utm_term: bounded(campaign.utm_term),
      landing_page: bounded(campaign.landing_page),
      stage: priorLead && priorLead.stage === 'BOOKED' ? 'BOOKED' : 'BOOKING_STARTED',
      booking_status: priorLead && priorLead.booking_status || null,
      marketing_consent: marketingConsent === true,
      marketing_consent_at: marketingConsent === true && marketingConsentAt ? String(marketingConsentAt).slice(0, 50) : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'booking_job_id' }).select('id, stage').single();
    if (error) throw error;

    if (lead && lead.stage !== 'BOOKED') {
      await supabase.from('customer_lead_events').upsert(
        ['NEW', 'PRICE_STARTED', 'PRICE_COMPLETED', 'BOOKING_STARTED'].map(stage => ({ lead_id: lead.id, stage })),
        { onConflict: 'lead_id,stage', ignoreDuplicates: true }
      );
    }

    res.status(200).json({ captured: true, stage: lead.stage });
  } catch (err) {
    console.error('customer-lead-start error:', err);
    res.status(500).json({ error: 'Could not record booking progress.' });
  }
};
