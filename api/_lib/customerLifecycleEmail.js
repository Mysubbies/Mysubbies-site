const { wrapEmail, escapeHtml, emailDetailsTable, emailButton } = require('./email');

const PORTAL = 'https://app.mysubbies.com.au/mysubbies-customer-portal.html';

function customerLifecycleEmail(type, data = {}) {
  const name = escapeHtml(data.customerName || 'there');
  const service = escapeHtml(data.service || 'your booking');
  const address = data.address ? escapeHtml(data.address) : '';
  const details = () => emailDetailsTable([
    { label: 'Service', value: service }, { label: 'Property', value: address },
    { label: 'Date', value: data.bookingDate ? escapeHtml(data.bookingDate) : '' },
  ]);
  const cta = label => emailButton(label, PORTAL);
  const templates = {
    welcome: ['Welcome to MySubbies', `<h2>Welcome, ${name}</h2><p>Your account is ready. You can get an estimated price now or return whenever you are ready to book.</p>${cta('Go to my account →')}`],
    booking_received: [`Booking received — ${service}`, `<h2>Booking received</h2><p>Thanks, ${name}. MySubbies is arranging the appropriate local professional. We may contact you for availability or more job information; contractor details appear only after confirmation.</p>${details()}${cta('View my booking →')}`],
    payment_received: [`Payment received — ${service}`, `<h2>Payment received</h2><p>Thanks, ${name}. Your ${escapeHtml(data.paymentLabel || 'payment')} of <strong>${escapeHtml(data.amount || '')}</strong> was received.</p>${details()}${cta('View payments →')}`],
    information_required: [`More information needed — ${service}`, `<h2>We need a little more information</h2><p>Hi ${name}, please open your booking and provide the requested job information so we can keep arranging your service.</p>${details()}${cta('Update my booking →')}`],
    contractor_confirmed: [`Professional confirmed — ${service}`, `<h2>Your professional is confirmed</h2><p>Hi ${name}, ${escapeHtml(data.contractorName || 'your local professional')} is now confirmed for your booking.</p>${details()}${cta('View confirmed booking →')}`],
    rescheduled: [`Booking rescheduled — ${service}`, `<h2>Your booking has been rescheduled</h2><p>Hi ${name}, please review the updated timing below. Contact MySubbies from your booking if it does not work for you.</p>${details()}${cta('Review new schedule →')}`],
    cancelled: [`Booking cancelled — ${service}`, `<h2>Your booking has been cancelled</h2><p>Hi ${name}, this booking is now cancelled. Any applicable refund is shown separately in your payment history.</p>${details()}${cta('View booking →')}`],
    completed: [`Job completed — ${service}`, `<h2>Your job is complete</h2><p>Hi ${name}, your job has been marked complete. You can review the job record and payment history in your account.</p>${details()}${cta('View completed job →')}`],
    quote_ready: [`Your MySubbies estimate — ${service}`, `<h2>Your estimate is ready</h2><p>Hi ${name}, review the scope, estimated price and validity details before accepting.</p>${details()}${cta('Review estimate →')}`],
    account_recovery: ['Your MySubbies account recovery request', `<h2>Account recovery</h2><p>Hi ${name}, we received a request for help accessing your account. If this was not you, no action is required. MySubbies support will never ask for your password or payment details.</p>${cta('Return to MySubbies →')}`],
  };
  if (!templates[type]) throw new Error('Unknown customer lifecycle email type.');
  return { subject: templates[type][0], html: wrapEmail(templates[type][1]) };
}

module.exports = { PORTAL, customerLifecycleEmail };
