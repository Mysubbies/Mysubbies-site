// POST /api/notify
// Body: { type: 'job-assigned' | 'stage-requested' | 'new-job-available', ...type-specific fields }
//
// Combines what were separate notify-job-assigned.js / notify-stage-requested.js
// endpoints into one file — Vercel's Hobby plan caps a deployment at 12
// serverless functions, and this project was about to go over that with
// every new one-off endpoint. Splitting by `type` in the body keeps the
// same behavior without spending a function slot per notification kind.
//
// job-assigned: { customerEmail, category, suburb, contractorName } — fired
//   from mysubbies-contractor-portal.html's acceptJob().
// stage-requested: { customerEmail, category, stageLabel } — fired from
//   mysubbies-contractor-portal.html's requestStageApproval().
// new-job-available: { category, suburb, taskName } — fired from
//   mysubbies-booking.html once a job is created. Added Aug 2026: until
//   this existed, a contractor had NO way to learn a new job existed
//   except opening the portal and checking the Job Feed tab themselves —
//   no email, SMS or push of any kind. Looks up matching contractors
//   itself (same trade-match rule the Job Feed already filters by --
//   approved status + trades array includes this category) rather than
//   trusting a client-supplied recipient list.
const { sendEmail, wrapEmail } = require('./_lib/email');
const { getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { type } = req.body || {};

    if (type === 'job-assigned') {
      const { customerEmail, category, suburb, contractorName } = req.body || {};
      if (!customerEmail || !category) { res.status(400).json({ error: 'customerEmail and category are required.' }); return; }
      await sendEmail({
        to: customerEmail,
        subject: `A contractor has been matched to your ${category} job`,
        html: wrapEmail(`
          <h2 style="margin-top:0;">Good news — you're matched!</h2>
          <p>${contractorName ? `<strong>${contractorName}</strong> has` : 'A vetted contractor has'} accepted your <strong>${category}</strong> job${suburb ? ` in <strong>${suburb}</strong>` : ''}.</p>
          <p>You can message them directly and track progress any time in <a href="https://mysubbies-site.vercel.app/mysubbies-customer-portal.html">My Jobs</a>.</p>
        `),
      });
      res.status(200).json({ sent: true });
      return;
    }

    if (type === 'stage-requested') {
      const { customerEmail, category, stageLabel } = req.body || {};
      if (!customerEmail || !category || !stageLabel) { res.status(400).json({ error: 'customerEmail, category and stageLabel are required.' }); return; }
      await sendEmail({
        to: customerEmail,
        subject: `Action needed — approve the ${stageLabel} stage for your ${category} job`,
        html: wrapEmail(`
          <h2 style="margin-top:0;">Your contractor is ready for the next stage</h2>
          <p>Your contractor has marked the <strong>${stageLabel}</strong> stage ready on your <strong>${category}</strong> job. Review and approve the payment in <a href="https://mysubbies-site.vercel.app/mysubbies-customer-portal.html">My Jobs</a> to keep things moving.</p>
          <p>Nothing is charged until you approve it there.</p>
        `),
      });
      res.status(200).json({ sent: true });
      return;
    }

    if (type === 'new-job-available') {
      const { category, suburb, taskName } = req.body || {};
      if (!category) { res.status(400).json({ error: 'category is required.' }); return; }

      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('contractors')
        .select('full_application')
        .not('full_application', 'is', null)
        .limit(500);
      if (error) throw error;

      // Same trade-match rule as feedJobs in mysubbies-contractor-portal.html
      // (status approved + trades array includes this category) -- not
      // filtered by suburb, since the Job Feed itself doesn't filter by
      // suburb either. Keep both in sync if that ever changes.
      const matches = (data || [])
        .map(r => r.full_application)
        .filter(a => a && a.status === 'approved' && Array.isArray(a.trades) && a.trades.includes(category) && a.email);

      await Promise.all(matches.map(a => sendEmail({
        to: a.email,
        subject: `New ${category} job available${suburb ? ` in ${suburb}` : ''}`,
        html: wrapEmail(`
          <h2 style="margin-top:0;">A new job just came in</h2>
          <p>A customer needs <strong>${taskName || category}</strong>${suburb ? ` in <strong>${suburb}</strong>` : ''}. No lead fees, no bidding — first to accept gets it.</p>
          <p><a href="https://mysubbies-site.vercel.app/mysubbies-contractor-portal.html">Open Job Feed →</a></p>
        `),
      })));

      res.status(200).json({ sent: true, notified: matches.length });
      return;
    }

    res.status(400).json({ error: 'Unknown notification type.' });
  } catch (err) {
    console.error('notify error:', err);
    res.status(200).json({ sent: false }); // never block the caller's flow over an email hiccup
  }
};
