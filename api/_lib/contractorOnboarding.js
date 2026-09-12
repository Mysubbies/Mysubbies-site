const crypto = require('crypto');
const { escapeHtml, wrapEmail, emailButton, emailDetailsTable } = require('./email');

const AGREEMENT_VERSION = 'contractor-agreement-2026-09';
function appBaseUrl() {
  const explicit = String(process.env.APP_BASE_URL || process.env.PUBLIC_APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://app.mysubbies.com.au';
}
const PORTAL_URL = `${appBaseUrl()}/mysubbies-contractor-portal.html`;
const SIGNUP_URL = `${appBaseUrl()}/mysubbies-contractor-signup.html`;
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
  const contactName = app.contact || contractor.business_name || 'there';
  const businessName = contractor.business_name || app.business || 'your business';
  const activationUrl = `${PORTAL_URL}?setup=${encodeURIComponent(setupToken || '')}&email=${encodeURIComponent(contractor.email || app.email || '')}`;

  return {
    subject: 'Your MySubbies contractor profile is approved',
    html: wrapEmail(`<p>Hi ${escapeHtml(contactName)},</p>
      <h2 style="margin-top:0;">You're approved to join MySubbies</h2>
      <p>Your contractor profile for <strong>${escapeHtml(businessName)}</strong> has been approved.</p>
      <p>Welcome to the MySubbies Contractor Network. Your Contractor Portal is where you'll manage your profile, review suitable job opportunities and maintain your account details.</p>
      ${emailDetailsTable([
        { label: 'Categories', value: escapeHtml(categories.join(', ') || 'Contact support') },
        { label: 'Service areas', value: escapeHtml(areas.join(', ') || 'All Melbourne metro') },
      ])}
      ${emailButton('Activate contractor portal →', activationUrl)}
      <h3>Getting started</h3>
      <p><strong>1. Activate your account</strong><br>Create your password and log in using the secure activation button above.</p>
      <p><strong>2. Complete your profile</strong><br>Check your contact details, trade categories, service areas, availability and compliance information.</p>
      <p><strong>3. Add your bank details</strong><br>Enter your nominated bank account so MySubbies can process contractor payments.</p>
      <p><strong>4. Receive job opportunities</strong><br>Suitable work may be offered based on your approved categories and service areas.</p>
      <p><strong>5. Accept and manage jobs</strong><br>Review the scope, location and contractor payout before accepting, then keep the job status updated through the portal.</p>
      <h3>Important</h3>
      <p>Only accept work you are appropriately qualified, licensed and insured to perform. Keep all required licences and insurance current. MySubbies does not guarantee a minimum number or frequency of job opportunities.</p>
      <p>Need help? Reply to this email or contact <a href="mailto:accounts@mysubbies.com.au">accounts@mysubbies.com.au</a>.</p>
      <p>Welcome aboard.<br><br><strong>MySubbies Team</strong></p>`),
  };
}

function rejectedEmail(reason, moreInformation, contractor, updateToken) {
  const safeReason = escapeHtml(reason || 'Your application did not meet the current onboarding requirements.');
  return {
    subject: moreInformation ? 'More information required for your MySubbies application' : 'Update on your MySubbies contractor application',
    html: wrapEmail(`<h2 style="margin-top:0;">${moreInformation ? 'More information required' : 'Application update'}</h2>
      <p>${safeReason}</p>
      ${moreInformation ? `<p>Please correct or upload the requested information, then securely resubmit the same application to be reviewed again. You do not need to start again.</p>${emailButton('Update and resubmit →', `${SIGNUP_URL}?resubmit=${encodeURIComponent(updateToken || '')}&email=${encodeURIComponent((contractor && contractor.email) || '')}`)}` : '<p>If you believe information was missed, reply to this email and our team will review it.</p>'}`),
  };
}

module.exports = { AGREEMENT_VERSION, PORTAL_URL, validAbn, validateApplication, applicationToken, tokenHash, receivedEmail, approvedEmail, rejectedEmail };
