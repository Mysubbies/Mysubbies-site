// Public contractor-application endpoint. New submissions are create-only:
// an anonymous caller can never overwrite an existing contractor by knowing
// their email or ABN. A one-time high-entropy token authorises the optional
// second-step document upload.
const { getSupabase } = require('./_lib/clients');
const { sendEmailWithResult } = require('./_lib/email');
const { validateApplication, applicationToken, tokenHash, receivedEmail } = require('./_lib/contractorOnboarding');
const { storeDocuments } = require('./_lib/contractorDocuments');
const { enforceSignupRateLimit, looksLikeBot } = require('./_lib/signupSecurity');

async function adminNotification(supabase, title, body, eventType = 'contractor-application-submitted') {
  const { error } = await supabase.from('notifications').insert({ recipient_role: 'admin', event_type: eventType, title, body });
  if (error) console.error('contractor onboarding admin notification failed:', error);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const body = req.body || {};
    const supabase = getSupabase();

    if (body.action === 'getResubmission') {
      const email = String(body.email || '').trim().toLowerCase();
      const { data: contractor } = await supabase.from('contractors')
        .select('id, email, status, full_application, application_update_token_hash, application_update_token_expires_at')
        .eq('email', email).maybeSingle();
      const valid = contractor && contractor.status === 'manual_review'
        && contractor.application_update_token_hash === tokenHash(body.updateToken)
        && new Date(contractor.application_update_token_expires_at) > new Date();
      if (!valid) { res.status(403).json({ error: 'This secure application link is invalid or expired.' }); return; }
      const app = contractor.full_application || {};
      res.status(200).json({ application: { ...app, insuranceDocs: app.insuranceDocs || [], certDocs: app.certDocs || [], idDocs: app.idDocs || [] } });
      return;
    }

    if (body.action === 'uploadDocuments') {
      const { applicationId, updateToken, insuranceDocs, certDocs, idDocs } = body;
      if (!applicationId || !updateToken) { res.status(400).json({ error: 'Application credentials are required.' }); return; }
      const { data: contractor, error } = await supabase.from('contractors').select('id, full_application, application_update_token_hash, application_update_token_expires_at').eq('full_application->>id', applicationId).maybeSingle();
      if (error) throw error;
      if (!contractor || contractor.application_update_token_hash !== tokenHash(updateToken)
        || new Date(contractor.application_update_token_expires_at) <= new Date()) { res.status(403).json({ error: 'Application update is not authorised.' }); return; }
      const [storedInsurance, storedCerts, storedIds] = await Promise.all([
        storeDocuments(supabase, contractor.id, 'insurance', insuranceDocs),
        storeDocuments(supabase, contractor.id, 'licence', certDocs),
        storeDocuments(supabase, contractor.id, 'identity', idDocs),
      ]);
      const fullApplication = { ...contractor.full_application, insuranceDocs: storedInsurance, certDocs: storedCerts, idDocs: storedIds };
      const { error: updateError } = await supabase.from('contractors').update({ full_application: fullApplication, updated_at: new Date().toISOString() }).eq('id', contractor.id);
      if (updateError) throw updateError;
      res.status(200).json({ updated: 1 });
      return;
    }

    // Accept the old array envelope while the static page rollout catches up,
    // but process exactly one application rather than allowing bulk anonymous writes.
    const application = body.application || (Array.isArray(body.applications) ? body.applications[0] : null);
    if (looksLikeBot(application || {})) { res.status(400).json({ error: 'Could not submit the application.' }); return; }
    const validationError = validateApplication(application);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    const email = String(application.email).trim().toLowerCase();
    const abn = String(application.abn).replace(/\D/g, '');
    const limited = await enforceSignupRateLimit(supabase, req);
    if (!limited.ok) { res.setHeader('Retry-After', String(limited.retryAfter)); res.status(429).json({ error: 'Too many applications. Please try again later.' }); return; }

    if (body.action === 'resubmit') {
      const { data: contractor } = await supabase.from('contractors')
        .select('id, email, abn, status, full_application, application_update_token_hash, application_update_token_expires_at')
        .eq('email', email).maybeSingle();
      const valid = contractor && contractor.status === 'manual_review' && contractor.abn === abn
        && contractor.application_update_token_hash === tokenHash(body.updateToken)
        && new Date(contractor.application_update_token_expires_at) > new Date();
      if (!valid) { res.status(403).json({ error: 'This secure application link is invalid or expired.' }); return; }
      const canonical = { ...contractor.full_application, ...application, email, abn, status: 'manual_review',
        resubmittedAt: new Date().toISOString() };
      const nextToken = applicationToken();
      const { error: updateError } = await supabase.from('contractors').update({
        business_name: canonical.business, address: canonical.address, phone: canonical.phone,
        categories: canonical.trades, full_application: canonical, application_review_notes: null,
        application_update_token_hash: tokenHash(nextToken),
        application_update_token_expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', contractor.id);
      if (updateError) throw updateError;
      await adminNotification(supabase, 'Contractor application resubmitted', `${canonical.business} supplied updated information and requires review.`, 'contractor-application-resubmitted');
      res.status(200).json({ updated: 1, applicationId: canonical.id, updateToken: nextToken });
      return;
    }
    const [{ data: emailMatch }, { data: abnMatch }] = await Promise.all([
      supabase.from('contractors').select('id').eq('email', email).maybeSingle(),
      supabase.from('contractors').select('id').eq('abn', abn).maybeSingle(),
    ]);
    if (emailMatch || abnMatch) { res.status(409).json({ error: 'An application with this email or ABN already exists. Contact support if you need to update it.' }); return; }

    const token = applicationToken();
    const { website: _honeypot, ...submittedApplication } = application;
    const canonical = { ...submittedApplication, email, abn, status: 'manual_review', agreementAccepted: true };
    const { data, error } = await supabase.from('contractors').insert({
      email, business_name: canonical.business, address: canonical.address, abn,
      acn: canonical.acn || null, business_structure: canonical.businessStructure || null,
      phone: canonical.phone, categories: canonical.trades, full_application: canonical,
      status: 'manual_review', agreement_accepted: true,
      agreement_accepted_at: canonical.agreementAcceptedAt,
      agreement_version: canonical.agreementVersion,
      application_update_token_hash: tokenHash(token),
      application_update_token_expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    }).select('id').single();
    if (error) throw error;

    await adminNotification(supabase, 'New contractor application', `${canonical.business} (${canonical.contact}) applied and requires review.`);
    await adminNotification(supabase, 'Contractor documents require attention',
      `${canonical.business} has submitted the initial application; verify required licence, insurance and identity documents before approval.`,
      'contractor-documents-missing');
    const message = receivedEmail(canonical);
    const delivery = await sendEmailWithResult({ to: email, ...message });
    if (!delivery.ok) {
      await adminNotification(supabase, 'Contractor onboarding email failed', `Application received for ${canonical.business}, but the confirmation email was not delivered.`, 'contractor-onboarding-email-failed');
    }
    res.status(201).json({ created: 1, id: data.id, applicationId: canonical.id, updateToken: token, emailDelivery: delivery.ok ? 'sent' : 'failed' });
  } catch (err) {
    console.error('sync-applications error:', err);
    res.status(500).json({ error: 'Could not submit the application.' });
  }
};
