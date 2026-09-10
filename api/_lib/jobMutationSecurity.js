const PROTECTED_FIELDS = new Set([
  'id', 'category', 'customerEmail', 'customerName', 'customerPhone',
  'contractorEmail', 'contractor', 'items', 'basePrice', 'priceLow',
  'priceHigh', 'paymentSchedule', 'paidStages', 'depositPaymentIntentId',
  'depositPct', 'depositAmount', 'status', 'completedAt', 'disputed',
  'variations', 'beforePhotos', 'afterPhotos', 'completionEvidence',
  'milestones', 'paymentDetails', 'payout', 'platformCommission',
]);

const CUSTOMER_FIELDS = new Set([
  'address', 'suburb', 'site', 'access', 'urgency', 'customerRating',
  'intakeContactPreference', 'intakeParkingNotes', 'intakeAvailability', 'intakeCompletedAt',
  'customerReview', 'cancellationReason', 'cancellationRequestedAt',
  'cancellationRequestedBy',
]);
const CONTRACTOR_FIELDS = new Set([
  'cancellationReason', 'cancellationRequestedAt', 'cancellationRequestedBy',
]);

function safeMessages(previous, submitted, role) {
  const before = Array.isArray(previous) ? previous : [];
  const after = Array.isArray(submitted) ? submitted : before;
  if (after.length < before.length) return before;
  for (let i = 0; i < before.length; i++) {
    if (JSON.stringify(after[i]) !== JSON.stringify(before[i])) return before;
  }
  const additions = after.slice(before.length, before.length + 20).filter(message =>
    message && message.from === role && typeof message.text === 'string'
    && message.text.trim() && message.text.length <= 5000);
  return [...before, ...additions.map(message => ({
    id: String(message.id || '').slice(0, 100),
    from: role,
    authorName: String(message.authorName || '').slice(0, 200),
    text: message.text.trim(),
    createdAt: String(message.createdAt || new Date().toISOString()).slice(0, 50),
  }))];
}

function mergePermittedMutation(existing, submitted, role) {
  const result = { ...existing };
  const allowed = role === 'customer' ? CUSTOMER_FIELDS : role === 'contractor' ? CONTRACTOR_FIELDS : new Set();
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(submitted, key)) result[key] = submitted[key];
  }
  if (role === 'customer') {
    if (Object.prototype.hasOwnProperty.call(submitted, 'intakeAvailability')) result.intakeAvailability = String(submitted.intakeAvailability || '').trim().slice(0, 500);
    if (Object.prototype.hasOwnProperty.call(submitted, 'intakeParkingNotes')) result.intakeParkingNotes = String(submitted.intakeParkingNotes || '').trim().slice(0, 1000);
    if (Object.prototype.hasOwnProperty.call(submitted, 'intakeContactPreference')) result.intakeContactPreference = String(submitted.intakeContactPreference || '').trim().slice(0, 100);
    if (Object.prototype.hasOwnProperty.call(submitted, 'intakeCompletedAt')) result.intakeCompletedAt = new Date().toISOString();
  }
  result.messages = safeMessages(existing.messages, submitted.messages, role);
  if (role === 'contractor') result.internalMessages = safeMessages(existing.internalMessages, submitted.internalMessages, role);

  // A cancellation request is a permitted operational request, not a
  // payment/completion transition. Every other submitted status is ignored.
  if (submitted.status === 'cancellation_requested') {
    result.status = 'cancellation_requested';
    result.cancellationRequestedBy = role;
  }
  return result;
}

function restoreStructuredFields(record, row) {
  const price = Number(row.base_price_cents) / 100;
  const restored = {
    ...record,
    id: row.id,
    category: row.category,
    customerEmail: row.customer_email || null,
    contractorEmail: row.contractor_email || null,
    basePrice: price,
    priceLow: price,
    priceHigh: price,
    disputed: !!row.disputed,
  };
  if (['cancelled', 'completed', 'disputed'].includes(row.status)) restored.status = row.status;
  return restored;
}

function initialRecord(submitted, row, auth) {
  const safe = mergePermittedMutation({ items: Array.isArray(submitted.items) ? submitted.items : [] }, submitted, auth.role);
  safe.customerName = auth.role === 'customer' ? (auth.account.name || null) : null;
  safe.customerPhone = auth.role === 'customer' ? (auth.account.phone || null) : null;
  safe.paidStages = row.status === 'deposit_paid' ? { deposit: true } : {};
  safe.status = row.status === 'deposit_paid' ? 'feed' : row.status;
  return restoreStructuredFields(safe, row);
}

module.exports = { PROTECTED_FIELDS, safeMessages, mergePermittedMutation, restoreStructuredFields, initialRecord };
