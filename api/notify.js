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

// Region-based job matching (Sep 2026, pre-launch audit) -- mirrors
// jobMatchesContractorArea()/SUBURB_TO_REGION in
// mysubbies-contractor-portal.html exactly (same lookup table, same
// fail-open rule for an unmapped suburb) so a contractor never gets
// emailed about a job their own in-app Job Feed wouldn't even show them.
// See that file's comment for the full reasoning.
const CONTRACTOR_REGIONS = ['Northern Melbourne', 'Western Melbourne', 'Inner/CBD Melbourne', 'Southern Melbourne', 'Eastern Melbourne'];
const SUBURB_TO_REGION = {
  'coburg':'Northern Melbourne','preston':'Northern Melbourne','reservoir':'Northern Melbourne','thornbury':'Northern Melbourne','northcote':'Northern Melbourne','fairfield':'Northern Melbourne','alphington':'Northern Melbourne','ivanhoe':'Northern Melbourne','heidelberg':'Northern Melbourne','bundoora':'Northern Melbourne','mill park':'Northern Melbourne','epping':'Northern Melbourne','south morang':'Northern Melbourne','whittlesea':'Northern Melbourne','craigieburn':'Northern Melbourne','broadmeadows':'Northern Melbourne','fawkner':'Northern Melbourne','brunswick':'Northern Melbourne','brunswick east':'Northern Melbourne','brunswick west':'Northern Melbourne','pascoe vale':'Northern Melbourne','glenroy':'Northern Melbourne','tullamarine':'Northern Melbourne','greenvale':'Northern Melbourne','roxburgh park':'Northern Melbourne','campbellfield':'Northern Melbourne','thomastown':'Northern Melbourne','lalor':'Northern Melbourne','watsonia':'Northern Melbourne','greensborough':'Northern Melbourne','eltham':'Northern Melbourne','diamond creek':'Northern Melbourne','doreen':'Northern Melbourne','kingsbury':'Northern Melbourne','macleod':'Northern Melbourne','yallambie':'Northern Melbourne',
  'frankston':'Southern Melbourne','dandenong':'Southern Melbourne','cranbourne':'Southern Melbourne','mordialloc':'Southern Melbourne','chelsea':'Southern Melbourne','carrum':'Southern Melbourne','bentleigh':'Southern Melbourne','bentleigh east':'Southern Melbourne','cheltenham':'Southern Melbourne','moorabbin':'Southern Melbourne','brighton':'Southern Melbourne','sandringham':'Southern Melbourne','hampton':'Southern Melbourne','mentone':'Southern Melbourne','parkdale':'Southern Melbourne','aspendale':'Southern Melbourne','edithvale':'Southern Melbourne','seaford':'Southern Melbourne','langwarrin':'Southern Melbourne','skye':'Southern Melbourne','berwick':'Southern Melbourne','narre warren':'Southern Melbourne','pakenham':'Southern Melbourne','officer':'Southern Melbourne','hallam':'Southern Melbourne','clayton':'Southern Melbourne','springvale':'Southern Melbourne','noble park':'Southern Melbourne','keysborough':'Southern Melbourne','doveton':'Southern Melbourne','endeavour hills':'Southern Melbourne','hastings':'Southern Melbourne','mornington':'Southern Melbourne','mount eliza':'Southern Melbourne','somerville':'Southern Melbourne','rosebud':'Southern Melbourne','carnegie':'Southern Melbourne','murrumbeena':'Southern Melbourne','hughesdale':'Southern Melbourne','ormond':'Southern Melbourne','mckinnon':'Southern Melbourne','elwood':'Southern Melbourne',
  'box hill':'Eastern Melbourne','camberwell':'Eastern Melbourne','hawthorn':'Eastern Melbourne','kew':'Eastern Melbourne','balwyn':'Eastern Melbourne','doncaster':'Eastern Melbourne','templestowe':'Eastern Melbourne','ringwood':'Eastern Melbourne','croydon':'Eastern Melbourne','bayswater':'Eastern Melbourne','boronia':'Eastern Melbourne','ferntree gully':'Eastern Melbourne','knox':'Eastern Melbourne','wantirna':'Eastern Melbourne','vermont':'Eastern Melbourne','mitcham':'Eastern Melbourne','blackburn':'Eastern Melbourne','nunawading':'Eastern Melbourne','glen waverley':'Eastern Melbourne','mount waverley':'Eastern Melbourne','ashburton':'Eastern Melbourne','ashwood':'Eastern Melbourne','chadstone':'Eastern Melbourne','oakleigh':'Eastern Melbourne','malvern':'Eastern Melbourne','malvern east':'Eastern Melbourne','armadale':'Eastern Melbourne','toorak':'Eastern Melbourne','canterbury':'Eastern Melbourne','surrey hills':'Eastern Melbourne','mont albert':'Eastern Melbourne','burwood':'Eastern Melbourne','forest hill':'Eastern Melbourne','heathmont':'Eastern Melbourne','belgrave':'Eastern Melbourne','upwey':'Eastern Melbourne','lilydale':'Eastern Melbourne','mooroolbark':'Eastern Melbourne','chirnside park':'Eastern Melbourne','warrandyte':'Eastern Melbourne','rowville':'Eastern Melbourne','scoresby':'Eastern Melbourne','bayswater north':'Eastern Melbourne',
  'footscray':'Western Melbourne','yarraville':'Western Melbourne','seddon':'Western Melbourne','kingsville':'Western Melbourne','williamstown':'Western Melbourne','newport':'Western Melbourne','spotswood':'Western Melbourne','altona':'Western Melbourne','altona north':'Western Melbourne','laverton':'Western Melbourne','point cook':'Western Melbourne','werribee':'Western Melbourne','hoppers crossing':'Western Melbourne','tarneit':'Western Melbourne','truganina':'Western Melbourne','sunshine':'Western Melbourne','sunshine west':'Western Melbourne','braybrook':'Western Melbourne','deer park':'Western Melbourne','caroline springs':'Western Melbourne','melton':'Western Melbourne','bacchus marsh':'Western Melbourne','st albans':'Western Melbourne','keilor':'Western Melbourne','keilor east':'Western Melbourne','keilor downs':'Western Melbourne','sydenham':'Western Melbourne','taylors lakes':'Western Melbourne','delahey':'Western Melbourne','ardeer':'Western Melbourne','albion':'Western Melbourne','maidstone':'Western Melbourne','maribyrnong':'Western Melbourne','west footscray':'Western Melbourne','tottenham':'Western Melbourne',
  'melbourne':'Inner/CBD Melbourne','melbourne cbd':'Inner/CBD Melbourne','southbank':'Inner/CBD Melbourne','docklands':'Inner/CBD Melbourne','south yarra':'Inner/CBD Melbourne','prahran':'Inner/CBD Melbourne','windsor':'Inner/CBD Melbourne','st kilda':'Inner/CBD Melbourne','st kilda east':'Inner/CBD Melbourne','balaclava':'Inner/CBD Melbourne','richmond':'Inner/CBD Melbourne','cremorne':'Inner/CBD Melbourne','abbotsford':'Inner/CBD Melbourne','collingwood':'Inner/CBD Melbourne','fitzroy':'Inner/CBD Melbourne','fitzroy north':'Inner/CBD Melbourne','carlton':'Inner/CBD Melbourne','carlton north':'Inner/CBD Melbourne','parkville':'Inner/CBD Melbourne','north melbourne':'Inner/CBD Melbourne','west melbourne':'Inner/CBD Melbourne','east melbourne':'Inner/CBD Melbourne','flemington':'Inner/CBD Melbourne','kensington':'Inner/CBD Melbourne','south melbourne':'Inner/CBD Melbourne','port melbourne':'Inner/CBD Melbourne','albert park':'Inner/CBD Melbourne','middle park':'Inner/CBD Melbourne',
};
function suburbToRegion(suburb) {
  if (!suburb) return null;
  const key = String(suburb).toLowerCase().trim();
  if (SUBURB_TO_REGION[key]) return SUBURB_TO_REGION[key];
  for (const s in SUBURB_TO_REGION) {
    if (key.includes(s)) return SUBURB_TO_REGION[s];
  }
  return null;
}
function jobMatchesContractorArea(jobSuburb, application) {
  const regions = (application && application.regions) || [];
  if (!regions.length) return true;
  if (!jobSuburb) return true;
  const jobSuburbLower = String(jobSuburb).toLowerCase();
  const freeSuburbs = ((application && application.suburbs) || []).filter(s => !CONTRACTOR_REGIONS.includes(s));
  if (freeSuburbs.some(s => { const sl = String(s).toLowerCase().trim(); return sl && (jobSuburbLower.includes(sl) || sl.includes(jobSuburbLower)); })) return true;
  const jobRegion = suburbToRegion(jobSuburb);
  if (!jobRegion) return true;
  return regions.includes(jobRegion);
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
      // Same 82% figure shown everywhere else a contractor sees a job's
      // value (Job Feed's Payout column, My Jobs, earnings) -- never the
      // gross customer price, which includes Mysubbies' 18% commission
      // (updated Sept 2026, was 25%/75%).
      const payout = basePrice != null ? Math.round(Number(basePrice) * 0.82) : null;

      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('contractors')
        .select('full_application')
        .not('full_application', 'is', null)
        .limit(500);
      if (error) throw error;

      // Same trade-match AND region-match rules as feedJobs in
      // mysubbies-contractor-portal.html (status approved + trades array
      // includes this category + jobMatchesContractorArea) -- keep both in
      // sync if either ever changes.
      const matches = (data || [])
        .map(r => r.full_application)
        .filter(a => a && a.status === 'approved' && Array.isArray(a.trades) && a.trades.includes(category) && a.email && jobMatchesContractorArea(suburb, a));

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

    // customer-registered: { name, email, phone, suburb } -- fired from
    // mysubbies-booking.html right after a real customer account is
    // created (not the legacy plaintext-password self-heal login in
    // mysubbies-customer-portal.html, which silently upgrades an EXISTING
    // customer's auth rather than creating a new one). Same gap
    // contractor-application-submitted already closed on the contractor
    // side (Sep 2026 pre-launch audit) -- until now, admin had no way to
    // learn a new customer signed up except opening the admin portal.
    if (type === 'customer-registered') {
      const { name, email, phone, suburb } = req.body || {};
      if (!email) { res.status(400).json({ error: 'email is required.' }); return; }
      await sendEmail({
        to: ADMIN_NOTIFY_EMAIL,
        subject: `New customer registered — ${name || email}`,
        html: wrapEmail(`
          <h2 style="margin-top:0;">A new customer just signed up</h2>
          ${emailDetailsTable([
            { label: 'Name', value: name ? escapeHtml(name) : '' },
            { label: 'Email', value: escapeHtml(email) },
            { label: 'Phone', value: phone ? escapeHtml(phone) : '' },
            { label: 'Suburb', value: suburb ? escapeHtml(suburb) : '' },
          ])}
          ${emailButton('View in Customers →', 'https://mysubbies-site.vercel.app/mysubbies-admin-portal.html')}
        `),
      });
      await writeNotification({
        recipient_role: 'admin', event_type: 'customer-registered',
        title: 'New customer registered', body: `${name || email} signed up${suburb ? ' in ' + suburb : ''}.`,
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
