// POST /api/notify
// Body: { type: 'job-assigned' | 'stage-requested', ...type-specific fields }
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
const { sendEmail, wrapEmail } = require('./_lib/email');

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

    res.status(400).json({ error: 'Unknown notification type.' });
  } catch (err) {
    console.error('notify error:', err);
    res.status(200).json({ sent: false }); // never block the caller's flow over an email hiccup
  }
};
