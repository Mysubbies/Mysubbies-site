const { getSupabase } = require('./_lib/clients');
const { wrapEmail } = require('./_lib/email');
const { notifyAdmin, notifyContractor } = require('./_lib/contractorNotifications');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' }); return;
  }
  try {
    const supabase = getSupabase();
    const today = new Date();
    const cutoff = new Date(today); cutoff.setUTCDate(cutoff.getUTCDate() + 30);
    const { data, error } = await supabase.from('contractors')
      .select('id,email,business_name,licence_expiry,insurance_expiry,status,licence_reminder_sent_at,insurance_reminder_sent_at')
      .or(`licence_expiry.lte.${cutoff.toISOString().slice(0, 10)},insurance_expiry.lte.${cutoff.toISOString().slice(0, 10)}`);
    if (error) throw error;
    let sent = 0;
    for (const contractor of data || []) {
      const expired = [contractor.licence_expiry, contractor.insurance_expiry].filter(Boolean)
        .some(value => new Date(`${value}T23:59:59Z`) < today);
      if (expired && !['suspended', 'rejected', 'expired_documents'].includes(contractor.status)) {
        await supabase.from('contractors').update({ status: 'expired_documents', updated_at: today.toISOString() }).eq('id', contractor.id);
      }
      for (const kind of ['licence', 'insurance']) {
        const value = contractor[`${kind}_expiry`];
        if (!value || new Date(`${value}T23:59:59Z`) > cutoff) continue;
        const lastSent = contractor[`${kind}_reminder_sent_at`];
        if (lastSent && Date.now() - new Date(lastSent).getTime() < 7 * 24 * 60 * 60 * 1000) continue;
        const isExpired = new Date(`${value}T23:59:59Z`) < today;
        const label = kind === 'licence' ? 'Licence' : 'Insurance';
        const subject = isExpired ? `Action required: ${kind} has expired` : `Reminder: ${kind} expires soon`;
        const body = isExpired ? `Your ${kind} has expired. Provide current evidence before portal access and new job eligibility can resume.`
          : `Your ${kind} expires on ${value}. Provide updated evidence to avoid interruption.`;
        const delivery = await notifyContractor(supabase, { email: contractor.email,
          eventType: isExpired ? `contractor-${kind}-expired` : `contractor-${kind}-expiring`,
          title: `${label} ${isExpired ? 'expired' : 'expires soon'}`, body, subject,
          html: wrapEmail(`<h2 style="margin-top:0;">${subject}</h2><p>Your ${kind} expiry on file is <strong>${value}</strong>. Please securely provide current evidence or contact MySubbies support.</p><p>${isExpired ? 'Expired compliance prevents portal access and new job offers until reviewed.' : 'Keeping it current avoids interruption to job eligibility.'}</p>`) });
        await notifyAdmin(supabase, { eventType: isExpired ? `contractor-${kind}-expired` : `contractor-${kind}-expiring`,
          title: `${label} ${isExpired ? 'expired' : 'expires soon'}`, body: `${contractor.business_name} requires ${kind} review.` });
        if (delivery.ok) {
          sent++;
          await supabase.from('contractors').update({ [`${kind}_reminder_sent_at`]: today.toISOString() }).eq('id', contractor.id);
        }
      }
    }
    res.status(200).json({ reviewed: (data || []).length, sent });
  } catch (err) {
    console.error('contractor compliance reminder error:', err);
    res.status(500).json({ error: 'Could not process compliance reminders.' });
  }
};
