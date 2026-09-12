// POST /api/high-value-booking
// Customer bookings above $9,900 are captured for MySubbies review without
// taking payment and without entering the contractor marketplace.
const { getSupabase } = require('./_lib/clients');
const { requireAccount } = require('./_lib/userAuth');
const { BookingPriceError, authoritativeBookingTotal } = require('./_lib/bookingPrice');
const { sendEmail, wrapEmail, escapeHtml, emailDetailsTable, emailButton } = require('./_lib/email');

const HIGH_VALUE_THRESHOLD_CENTS = 990000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { jobId, suburb, address, items, attribution, marketingConsent, marketingConsentAt, urgency, site, access, jobType, businessName } = req.body || {};
    if (!jobId || !Array.isArray(items) || !items.length) {
      res.status(400).json({ error: 'jobId and booking items are required.' }); return;
    }
    const supabase = getSupabase();
    const auth = await requireAccount(supabase, req, 'customer');
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const totalCents = await authoritativeBookingTotal(supabase, items);
    if (totalCents <= HIGH_VALUE_THRESHOLD_CENTS) {
      res.status(409).json({ error: 'This booking must use the normal payment flow.' }); return;
    }

    const email = String(auth.account.email).toLowerCase();
    const category = [...new Set(items.map(i => i.catLabel).filter(Boolean))].join(', ');
    const bounded = value => value == null ? null : String(value).slice(0, 500);
    const fullRecord = {
      id: jobId, category, items, basePrice: totalCents / 100,
      suburb: bounded(suburb), address: bounded(address),
      customerName: auth.account.name || '', customerPhone: auth.account.phone || '', customerEmail: email,
      jobType: jobType === 'business' ? 'business' : 'private', businessName: bounded(businessName),
      site: bounded(site), access: bounded(access), urgency: bounded(urgency),
      status: 'admin_review', contractor: null, manualReviewRequired: true,
      paymentSchedule: [], paidStages: {}, depositPaymentIntentId: null,
      messages: [], internalMessages: [], createdAt: new Date().toISOString(), attribution: attribution || {},
    };

    const { error: jobError } = await supabase.from('jobs').insert({
      id: jobId, category, suburb: bounded(suburb), address: bounded(address),
      customer_id: auth.account.id, customer_email: email,
      base_price_cents: totalCents, deposit_pct: 0, deposit_amount_cents: 0,
      status: 'pending_deposit', stage: 'submitted', manual_review_required: true,
      contractor_email: null, full_record: fullRecord,
    });
    if (jobError) throw jobError;

    try {
      const campaign = attribution && typeof attribution === 'object' ? attribution : {};
      const { data: lead } = await supabase.from('customer_leads').upsert({
        booking_job_id: jobId, customer_id: auth.account.id,
        name: bounded(auth.account.name), email, mobile: bounded(auth.account.phone),
        requested_service: bounded(category), suburb: bounded(suburb),
        source: bounded(campaign.utm_source || campaign.referrer || 'direct'),
        utm_source: bounded(campaign.utm_source), utm_medium: bounded(campaign.utm_medium),
        utm_campaign: bounded(campaign.utm_campaign), utm_content: bounded(campaign.utm_content),
        utm_term: bounded(campaign.utm_term), landing_page: bounded(campaign.landing_page),
        stage: 'BOOKED', booking_status: 'admin_review_required',
        marketing_consent: marketingConsent === true,
        marketing_consent_at: marketingConsent === true && marketingConsentAt ? String(marketingConsentAt).slice(0, 50) : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'booking_job_id' }).select('id').single();
      if (lead) await supabase.from('customer_lead_events').upsert(
        ['NEW', 'PRICE_STARTED', 'PRICE_COMPLETED', 'BOOKING_STARTED', 'BOOKED'].map(stage => ({ lead_id: lead.id, stage })),
        { onConflict: 'lead_id,stage', ignoreDuplicates: true }
      );
    } catch (leadError) { console.error('high-value lead capture failed:', leadError); }

    const itemSummary = items.map(i => `${escapeHtml(i.taskName || i.catLabel)} — ${escapeHtml(i.qty)}${i.unit ? ' ' + escapeHtml(i.unit) : ''}`).join('<br>');
    await sendEmail({
      to: 'accounts@mysubbies.com.au',
      subject: `Admin review required — $${(totalCents / 100).toLocaleString('en-AU')} booking`,
      html: wrapEmail(`
        <h2 style="margin:0 0 8px;">High-value booking received</h2>
        <p style="margin:0 0 12px;">No deposit was requested and this booking has not been released to any contractor.</p>
        ${emailDetailsTable([
          { label: 'Booking ID', value: escapeHtml(jobId) },
          { label: 'Customer', value: escapeHtml(auth.account.name || email) },
          { label: 'Email', value: escapeHtml(email) },
          { label: 'Phone', value: escapeHtml(auth.account.phone || '') },
          { label: 'Address', value: escapeHtml(address || '') },
          { label: 'Suburb', value: escapeHtml(suburb || '') },
          { label: 'Service', value: escapeHtml(category) },
          { label: 'Items', value: itemSummary },
          { label: 'Estimated total', value: '$' + (totalCents / 100).toLocaleString('en-AU') },
          { label: 'Urgency', value: escapeHtml(urgency || '') },
          { label: 'Site notes', value: escapeHtml(site || '') },
          { label: 'Access', value: escapeHtml(access || '') },
        ])}
        ${emailButton('Open Admin Portal', 'https://app.mysubbies.com.au/mysubbies-admin-portal.html')}
      `),
    });

    res.status(201).json({ booked: true, adminReviewRequired: true, jobId, totalCents });
  } catch (err) {
    if (err instanceof BookingPriceError) { res.status(409).json({ error: err.message }); return; }
    console.error('high-value-booking error:', err);
    res.status(500).json({ error: 'Could not submit this booking for review. Please try again.' });
  }
};
