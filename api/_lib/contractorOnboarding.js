const crypto = require('crypto');
const { escapeHtml, wrapEmail, emailButton, emailDetailsTable } = require('./email');

const AGREEMENT_VERSION = 'contractor-agreement-2026-09';
const PORTAL_URL = 'https://app.mysubbies.com.au/mysubbies-contractor-portal.html';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function digits(value) { return String(value || '').replace(/\D/g, ''); }
function validAbn(value) {
  const abn = digits(value);
  if (abn.length !== 11) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  return weights.reduce((sum, weight, index) => sum + (Number(abn[index]) - (index === 0 ? 1 : 0)) * weight, 0) % 89 === 0;
}

function validateApplication(application) {
  if (!application || typeof application !== 'object') return 'application is required.';
  const required = ['business', 'address', 'contact', 'phone', 'email', 'abn'];
  const missing = required.filter(key => !String(application[key] || '').trim());
  if (missing.length) return `Missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`;
  if (!EMAIL_RE.test(String(application.email).trim())) return 'Enter a valid email address.';
  if (!/^04\d{8}$/.test(digits(application.phone))) return 'Enter a valid Australian mobile number.';
  if (!validAbn(application.abn)) return 'Enter a valid ABN.';
  if (!Array.isArray(application.trades) || !application.trades.length) return 'Select at least one trade category.';
  if ((!Array.isArray(application.regions) || !application.regions.length)
    && (!Array.isArray(application.suburbs) || !application.suburbs.length)) return 'Select at least one service area.';
  if (!Array.isArray(application.availability) || !application.availability.length) return 'Select at least one availability option.';
  if (!['yes', 'no', 'not_applicable'].includes(application.licenceHeld)) return 'Licence status is required.';
  if (typeof application.insuranceHeld !== 'boolean') return 'Insurance status is required.';
  if (application.agreementAccepted !== true || application.agreementVersion !== AGREEMENT_VERSION || !application.agreementAcceptedAt) {
    return 'You must accept the current Contractor Terms & Conditions.';
  }
  return null;
}

function applicationToken() { return crypto.randomBytes(32).toString('base64url'); }
function tokenHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }

function receivedEmail(application) {
  return {
    subject: 'Thanks for joining the MySubbies Contractor Network',
    html: wrapEmail(`<h2 style="margin-top:0;">Application received</h2>
      <p>Thanks, ${escapeHtml(application.contact)}. We have received the application for <strong>${escapeHtml(application.business)}</strong>.</p>
      <p>Our team will review your business details, service categories, service areas and compliance documents. We will email you with the outcome or ask for anything missing.</p>
      <p>Joining the network does not guarantee any minimum volume of job offers. If approved, you provide services as an independent contractor, not as an employee of MySubbies.</p>`),
  };
}

function approvedEmail(contractor, setupToken) {
  const app = contractor.full_application || {};
  const categories = contractor.categories || app.trades || [];
  const areas = app.regions || app.suburbs || [];
  return {
    subject: 'Your MySubbies contractor profile is approved',
    html: wrapEmail(`<h2 style="margin-top:0;">Your profile is approved</h2>
      <p>Welcome to the MySubbies Contractor Network. Use your application email at the portal and choose <strong>Activate your account</strong> to create your password.</p>
      ${emailDetailsTable([{ label: 'Categories', value: escapeHtml(categories.join(', ') || 'Contact support') }, { label: 'Service areas', value: escapeHtml(areas.join(', ') || 'All Melbourne metro') }])}
      ${emailButton('Activate contractor portal →', `${PORTAL_URL}?setup=${encodeURIComponent(setupToken || '')}&email=${encodeURIComponent(contractor.email || app.email || '')}`)}
      <h3>How job offers work</h3><p>Eligible offers appear in your Job Feed. Review the scope, suburb and payout, then accept or decline. Only accept work you can complete safely and on time. A job is yours only after the portal confirms acceptance.</p>
      <p>MySubbies does not guarantee any minimum volume or frequency of job opportunities.</p>
      <h3>On every job</h3><p>Contact the customer promptly, agree and honour the scheduled arrival window, confirm access and timing, and keep them updated when you are on the way, when you arrive, when work starts and when it is complete. Capture the required before and after photos in the job record.</p>
      <h3>Issues and payment</h3><p>Stop and contact MySubbies support through the portal if scope, safety, access, customer concerns or a dispute prevents completion. Do not perform unapproved variations. Payment follows the milestones shown in the portal after the required completion evidence and approvals.</p>
      <p>Before your first payment, please confirm your payout bank details in the Contractor Portal. You do not need a Stripe account and missing bank details do not stop you receiving or accepting suitable job opportunities.</p>
      <p>Keep every licence and insurance document current. Expired compliance documents may suspend portal access and job eligibility until reviewed.</p>
      <p>Need help? Contact <a href="mailto:support@mysubbies.com.au">support@mysubbies.com.au</a> or use the private MySubbies message thread in the portal.</p>`),
  };
}

function rejectedEmail(reason, moreInformation, contractor, updateToken) {
  const safeReason = escapeHtml(reason || 'Your application did not meet the current onboarding requirements.');
  return {
    subject: moreInformation ? 'More information required for your MySubbies application' : 'Update on your MySubbies contractor application',
    html: wrapEmail(`<h2 style="margin-top:0;">${moreInformation ? 'More information required' : 'Application update'}</h2>
      <p>${safeReason}</p>
      ${moreInformation ? `<p>Please correct or upload the requested information, then securely resubmit the same application to be reviewed again. You do not need to start again.</p>${emailButton('Update and resubmit →', `https://app.mysubbies.com.au/mysubbies-contractor-signup.html?resubmit=${encodeURIComponent(updateToken || '')}&email=${encodeURIComponent((contractor && contractor.email) || '')}`)}` : '<p>If you believe information was missed, reply to this email and our team will review it.</p>'}`),
  };
}

module.exports = { AGREEMENT_VERSION, PORTAL_URL, validAbn, validateApplication, applicationToken, tokenHash, receivedEmail, approvedEmail, rejectedEmail };
