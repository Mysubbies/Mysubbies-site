// POST /api/notify-job-assigned
// Body: { customerEmail, category, suburb, contractorName }
//
// Fired from mysubbies-contractor-portal.html's acceptJob() right after a
// contractor accepts a job, so the customer gets an email confirming a
// contractor has been matched. Takes the details directly from the client
// (already in memory at accept time) rather than re-reading the jobs table,
// which would race against sync-jobs.js's own fire-and-forget write of the
// same acceptance.
const { sendEmail, wrapEmail } = require('./_lib/email');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
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
  } catch (err) {
    console.error('notify-job-assigned error:', err);
    res.status(200).json({ sent: false }); // never block the accept flow over an email hiccup
  }
};
