const { sendEmailWithResult, wrapEmail, escapeHtml, emailButton } = require('./email');

const CONTRACTOR_PORTAL_URL = 'https://app.mysubbies.com.au/mysubbies-contractor-portal.html';

async function insertNotification(supabase, row) {
  try {
    const { error } = await supabase.from('notifications').insert(row);
    if (error) console.error('contractor notification audit insert failed:', { eventType: row.event_type, recipientRole: row.recipient_role });
  } catch (error) {
    console.error('contractor notification audit insert failed:', { eventType: row.event_type, recipientRole: row.recipient_role });
  }
}

async function notifyAdmin(supabase, { eventType, title, body, applicationRef, jobId, metadata }) {
  await insertNotification(supabase, {
    recipient_role: 'admin', event_type: eventType, title, body,
    application_ref: applicationRef || null, link_job_id: jobId || null,
    delivery_channels: ['in_app'], delivery_status: { in_app: 'created' }, metadata: metadata || {},
  });
}

async function notifyContractor(supabase, options) {
  const { email, eventType, title, body, subject, html, applicationRef, jobId, metadata } = options;
  const wantsEmail = !!subject;
  const delivery = wantsEmail
    ? await sendEmailWithResult({ to: email, subject, html: html || wrapEmail(`<h2 style="margin-top:0;">${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>${emailButton('Open Contractor Portal →', CONTRACTOR_PORTAL_URL)}`) })
    : { ok: true };
  await insertNotification(supabase, {
    recipient_role: 'contractor', recipient_email: email, event_type: eventType,
    title, body, application_ref: applicationRef || null, link_job_id: jobId || null,
    delivery_channels: wantsEmail ? ['in_app', 'email'] : ['in_app'],
    delivery_status: wantsEmail ? { in_app: 'created', email: delivery.ok ? 'sent' : 'failed' } : { in_app: 'created' },
    metadata: metadata || {},
  });
  if (wantsEmail && !delivery.ok) {
    await notifyAdmin(supabase, { eventType: 'contractor-critical-email-failed', title: 'Critical contractor email failed',
      body: `${title} email was not delivered to ${email}.`, applicationRef, jobId,
      metadata: { failedEventType: eventType } });
  }
  return delivery;
}

module.exports = { CONTRACTOR_PORTAL_URL, notifyAdmin, notifyContractor };
