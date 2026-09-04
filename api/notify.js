// POST /api/notify
// Body: { type: 'job-assigned' | 'stage-requested' | 'new-job-available' | 'contractor-application-submitted' | 'job-message', ...type-specific fields }
//
// Combines what were separate notify-job-assigned.js / notify-stage-requested.js
// endpoints into one file — Vercel's Hobby plan caps a deployment at 12
// serverless functions, and this project was about to go over that with
// every new one-off endpoint. Splitting by `type` in the body keeps the
// same behavior without spending a function slot per notification kind.
//
// job-assigned: { customerEmail, category, suburb, address, contractorName,
//   jobId, items, qty, unit, urgency } — fired from
//   mysubbies-contractor-portal.html's acceptJob(). Sep 2026: now shows a
//   real job-details table (quantity, address, urgency), not just one line
//   of prose, using whatever the customer entered in the estimator.
// stage-requested: { customerEmail, category, stageLabel } — fired from
//   mysubbies-contractor-portal.html's requestStageApproval().
// new-job-available: { category, suburb, taskName, items, qty, unit,
//   urgency, access, site, photoThumb } — fired from
//   mysubbies-booking.html once a job is created. Added Aug 2026: until
//   this existed, a contractor had NO way to learn a new job existed
//   except opening the portal and checking the Job Feed tab themselves —
//   no email, SMS or push of any kind. Looks up matching contractors
//   itself (same trade-match rule the Job Feed already filters by --
//   approved status + trades array includes this category) rather than
//   trusting a client-supplied recipient list. Sep 2026: now includes a
//   details table (quantity, urgency, access/site notes) and a photo when
//   the customer attached one -- suburb only, not the full street address,
//   which stays hidden from contractors until they actually accept (same
//   boundary as the Job Feed / job detail page). photoThumb is a small
//   client-resized JPEG (see resizeImageDataUrl() in
//   mysubbies-booking.html), never the customer's raw upload — this fans
//   out to every matching contractor, so keeping it small at the source
//   matters here more than almost anywhere else in this codebase.
// contractor-application-submitted: { business, contact, email, phone,
//   trades } — fired from mysubbies-contractor-signup.html once a new
//   application is saved. Added Aug 2026: until this existed, admin had
//   NO way to learn a new application arrived except opening the admin
//   portal's Applications tab and checking themselves — same gap as
//   new-job-available had for contractors, just on the admin side.
//   ADMIN_NOTIFY_EMAIL is optional; defaults to the site's own published
//   contact address so this works with zero extra Vercel config.
const { sendEmail, wrapEmail, escapeHtml, emailDetailsTable, emailButton, emailPhoto } = require('./_lib/email');
const { getSupabase } = require('./_lib/clients');

const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'accounts@mysubbies.com.au';

// A clean "Task — qty unit" line (or one per line for a multi-item job),
// shared by job-assigned and new-job-available so a recipient sees the
// actual scope of the job, not just its category name. Falls back to the
// top-level qty/unit a single-item job already carries when no items
// array was sent.
function itemsSummaryHtml(items, qty, unit) {
  if (Array.isArray(items) && items.length) {
    return items.map(i => `${escapeHtml(i.taskName || '')} — ${i.qty ?? ''} ${escapeHtml(i.unit || '')}`.trim()).join('<br>');
  }
  if (qty != null) return `${qty} ${escapeHtml(unit || '')}`.trim();
  return '';
}

// In-app notification-center row (supabase/schema_v13_notifications.sql),
// written alongside the email each branch below already sends — this is
// the in-app half of the same notification, read by the bell icon/panel
// in each portal (api/notifications.js). Deliberately best-effort and
// isolated in its own try/catch at each call site: a bell-icon row
// failing to write must never break the email or the underlying action
// that's actually being notified about.
async function writeNotification(rows) {
  try {
    await getSupabase().from('notifications').insert(rows);
  } catch (e) { console.error('notification insert error:', e); }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { type } = req.body || {};

    if (type === 'job-assigned') {
      const { customerEmail, category, suburb, address, contractorName, jobId, items, qty, unit, urgency, basePrice } = req.body || {};
      if (!customerEmail || !category) { res.status(400).json({ error: 'customerEmail and category are required.' }); return; }
      await sendEmail({
        to: customerEmail,
        subject: `A contractor has been matched to your ${category} job`,
        html: wrapEmail(`
          <h2 style="margin-top:0;">Good news — you're matched!</h2>
          <p>${contractorName ? `<strong>${escapeHtml(contractorName)}</strong> has` : 'A vetted contractor has'} accepted your <strong>${escapeHtml(category)}</strong> job${suburb ? ` in <strong>${escapeHtml(suburb)}</strong>` : ''}.</p>
          ${emailDetailsTable([
            { label: 'Job', value: escapeHtml(category) },
            { label: 'Quantity', value: itemsSummaryHtml(items, qty, unit) },
            { label: 'Address', value: address ? escapeHtml(address) : (suburb ? escapeHtml(suburb) : '') },
            { label: 'Urgency', value: urgency ? escapeHtml(urgency) : '' },
            { label: 'Price', value: basePrice != null ? `$${Number(basePrice).toLocaleString()}` : '' },
            { label: 'Contractor', value: contractorName ? escapeHtml(contractorName) : '' },
          ])}
          <p>You can message them directly and track progress any time in My Jobs.</p>
          ${emailButton('Open My Jobs →', 'https://mysubbies-site.vercel.app/mysubbies-customer-portal.html')}
        `),
      });
      await writeNotification({
        recipient_role: 'customer', recipient_email: customerEmail, event_type: 'job-assigned',
        title: 'Contractor matched', body: `${contractorName || 'A contractor'} accepted your ${category} job${suburb ? ' in ' + suburb : ''}.`,
        link_job_id: jobId || null,
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
      const { category, suburb, taskName, items, qty, unit, urgency, access, site, photoThumb, basePrice } = req.body || {};
      if (!category) { res.status(400).json({ error: 'category is required.' }); return; }
      // Same 75% figure shown everywhere else a contractor sees a job's
      // value (Job Feed's Payout column, My Jobs, earnings) -- never the
      // gross customer price, which includes Mysubbies' 25% commission.
      const payout = basePrice != null ? Math.round(Number(basePrice) * 0.75) : null;

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

      const emailBody = `
        <h2 style="margin-top:0;">A new job just came in</h2>
        <p>A customer needs <strong>${escapeHtml(taskName || category)}</strong>${suburb ? ` in <strong>${escapeHtml(suburb)}</strong>` : ''}. No lead fees, no bidding — first to accept gets it.</p>
        ${emailPhoto(photoThumb)}
        ${emailDetailsTable([
          { label: 'Job', value: escapeHtml(taskName || category) },
          { label: 'Quantity', value: itemsSummaryHtml(items, qty, unit) },
          { label: 'Suburb', value: suburb ? escapeHtml(suburb) : '' },
          { label: 'Urgency', value: urgency ? escapeHtml(urgency) : '' },
          { label: 'Payout', value: payout != null ? `<strong>$${payout.toLocaleString()}</strong>` : '' },
          { label: 'Site access', value: access ? escapeHtml(access) : '' },
          { label: 'Site notes', value: site ? escapeHtml(site) : '' },
        ])}
        <p style="font-size:12px;color:#6B7280;">Full address is shown once you accept.</p>
        ${emailButton('Open Job Feed →', 'https://mysubbies-site.vercel.app/mysubbies-contractor-portal.html')}
      `;
      await Promise.all(matches.map(a => sendEmail({
        to: a.email,
        subject: `New ${category} job available${suburb ? ` in ${suburb}` : ''}`,
        html: wrapEmail(emailBody),
      })));
      if (matches.length) {
        await writeNotification(matches.map(a => ({
          recipient_role: 'contractor', recipient_email: a.email, event_type: 'new-job-available',
          title: 'New job available', body: `${taskName || category}${suburb ? ' in ' + suburb : ''} — no lead fees, first to accept gets it.`,
        })));
      }

      res.status(200).json({ sent: true, notified: matches.length });
      return;
    }

    // job-message: { toEmail, toRole, fromName, category, jobNumber, text }
    // Fired from both mysubbies-customer-portal.html's and
    // mysubbies-contractor-portal.html's sendMsg() right after saveJobs(),
    // whenever either side sends a message in the job's customer-facing
    // thread (j.messages) -- not the separate private admin thread. Added
    // Sep 2026: until this existed, the only "notification" for a new
    // message was a desktop Notification that only fired while the
    // recipient's tab happened to be open (see checkForNewMessages() in
    // both portals) -- nothing reached a closed tab, a different device,
    // or a phone. This is the part of that gap email can actually close;
    // toRole picks which portal the "reply" link points at.
    if (type === 'job-message') {
      const { toEmail, toRole, fromName, category, jobNumber, jobId, text } = req.body || {};
      if (!toEmail || !toRole || !text) { res.status(400).json({ error: 'toEmail, toRole and text are required.' }); return; }
      const portalUrl = toRole === 'contractor'
        ? 'https://mysubbies-site.vercel.app/mysubbies-contractor-portal.html'
        : 'https://mysubbies-site.vercel.app/mysubbies-customer-portal.html';
      const jobLabel = jobNumber != null ? `Job #${jobNumber}` : (category || 'your job');
      const senderPlain = fromName || (toRole === 'contractor' ? 'The customer' : 'Your contractor');
      const senderLabel = escapeHtml(senderPlain);
      await sendEmail({
        to: toEmail,
        subject: `New message on ${jobLabel}${category ? ` (${category})` : ''}`,
        html: wrapEmail(`
          <h2 style="margin-top:0;">You have a new message</h2>
          <p><strong>${senderLabel}</strong> sent a message on ${jobLabel}:</p>
          <p style="background:#F7F7F5;border-radius:8px;padding:12px 14px;color:#333;">"${escapeHtml(String(text).slice(0, 400))}"</p>
          ${emailButton('Reply in the app →', portalUrl)}
        `),
      });
      await writeNotification({
        recipient_role: toRole, recipient_email: toEmail, event_type: 'job-message',
        title: `New message from ${senderPlain}`, body: String(text).slice(0, 300),
        link_job_id: jobId || null,
      });
      res.status(200).json({ sent: true });
      return;
    }

    if (type === 'contractor-application-submitted') {
      const { business, contact, email, phone, trades } = req.body || {};
      if (!business || !email) { res.status(400).json({ error: 'business and email are required.' }); return; }
      await sendEmail({
        to: ADMIN_NOTIFY_EMAIL,
        subject: `New contractor application — ${business}`,
        html: wrapEmail(`
          <h2 style="margin-top:0;">A new contractor application needs review</h2>
          <p><strong>${escapeHtml(business)}</strong> applied to join the panel.</p>
          ${emailDetailsTable([
            { label: 'Business', value: escapeHtml(business) },
            { label: 'Contact', value: contact ? escapeHtml(contact) : '' },
            { label: 'Email', value: escapeHtml(email) },
            { label: 'Phone', value: phone ? escapeHtml(phone) : '' },
            { label: 'Trades', value: Array.isArray(trades) && trades.length ? escapeHtml(trades.join(', ')) : '' },
          ])}
          ${emailButton('Review in Applications →', 'https://mysubbies-site.vercel.app/mysubbies-admin-portal.html')}
        `),
      });
      await writeNotification({
        recipient_role: 'admin', event_type: 'contractor-application-submitted',
        title: 'New contractor application', body: `${business}${contact ? ' (' + contact + ')' : ''} applied to join the panel.`,
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
