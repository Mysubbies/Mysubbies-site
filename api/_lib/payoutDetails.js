function digits(value) { return String(value || '').replace(/[^0-9]/g, ''); }

function validatePayoutDetails(input) {
  const accountName = String(input.accountName || '').trim();
  const bsb = digits(input.bsb);
  const accountNumber = digits(input.accountNumber);
  const bankName = String(input.bankName || '').trim();
  if (accountName.length < 2 || accountName.length > 100) return { error: 'Account name must be between 2 and 100 characters.' };
  if (bsb.length !== 6) return { error: 'BSB must contain exactly 6 digits.' };
  if (!/^\d{6,10}$/.test(accountNumber)) return { error: 'Account number must contain 6 to 10 digits.' };
  if (bankName.length > 100) return { error: 'Bank name must be 100 characters or fewer.' };
  if (input.confirmed !== true) return { error: 'Confirm that these bank details belong to you or your business.' };
  return { value: { accountName, bsb, accountNumber, bankName: bankName || null } };
}

function maskBsb(bsb) {
  const value = digits(bsb);
  return value.length === 6 ? `***-${value.slice(-3)}` : null;
}

function maskAccountNumber(accountNumber) {
  const value = digits(accountNumber);
  return value.length >= 6 ? `${'*'.repeat(Math.max(6, value.length - 4))}${value.slice(-4)}` : null;
}

function maskedPayoutDetails(row) {
  const complete = !!(row && row.payout_details_confirmed && row.payout_account_name && row.payout_bsb && row.payout_account_number);
  return {
    complete,
    accountName: complete ? row.payout_account_name : null,
    bankName: complete ? row.payout_bank_name : null,
    maskedBsb: complete ? maskBsb(row.payout_bsb) : null,
    maskedAccountNumber: complete ? maskAccountNumber(row.payout_account_number) : null,
    confirmed: complete,
    updatedAt: complete ? row.payout_details_updated_at : null,
  };
}

module.exports = { validatePayoutDetails, maskBsb, maskAccountNumber, maskedPayoutDetails };
