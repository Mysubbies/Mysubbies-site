const test = require('node:test');
const assert = require('node:assert/strict');
const { authoritativeBookingPrice, BookingPriceError } = require('../api/_lib/bookingPrice');

function client(categories) {
  return { from() { return { select() { return { eq() { return { maybeSingle: async () => ({ data: { categories }, error: null }) }; } }; } }; } };
}

const card = [{ label: 'Fencing', tasks: [{ name: 'Timber fence', rate: 100, minJobPrice: 500 }] }];

test('server recomputes quantity, rate and minimum price from authoritative rate card', async () => {
  assert.equal(await authoritativeBookingPrice(client(card), 'Fencing', [{ catLabel: 'Fencing', taskName: 'Timber fence', qty: 2 }]), 50000);
  assert.equal(await authoritativeBookingPrice(client(card), 'Fencing', [{ catLabel: 'Fencing', taskName: 'Timber fence', qty: 8 }]), 80000);
});

test('service/category and invalid quantity manipulation fail closed', async () => {
  await assert.rejects(() => authoritativeBookingPrice(client(card), 'Plumbing', [{ catLabel: 'Fencing', taskName: 'Timber fence', qty: 8 }]), BookingPriceError);
  await assert.rejects(() => authoritativeBookingPrice(client(card), 'Fencing', [{ catLabel: 'Fencing', taskName: 'Timber fence', qty: -1 }]), BookingPriceError);
});
