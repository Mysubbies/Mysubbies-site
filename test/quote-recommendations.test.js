const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FALLBACK_IMAGE,
  categoryImage,
  getRecommendedServices,
} = require('../api/_lib/quoteRecommendations');

function category(label, itemId, minJobPrice, extra = {}) {
  return {
    label,
    tasks: [{ itemId, name: `${label} standard service`, minJobPrice, ...extra }],
  };
}

const catalogue = [
  category('Gardening & Lawn Mowing', 'GLM-001', 130),
  category('Fencing', 'FEN-001', 360),
  category('Decking', 'DEC-001', 1500),
  category('Property Maintenance', null, null, { unavailable: true }),
  category('Painting', 'PAI-001', 250),
];

test('known category returns related, unique recommendations excluding quoted service', () => {
  const recommendations = getRecommendedServices([{ rateCardItemId: 'GLM-001', description: 'Garden clean-up' }], catalogue);
  assert.deepEqual(recommendations.map(item => item.category), ['Fencing', 'Decking', 'Property Maintenance']);
  assert.equal(recommendations.some(item => item.category === 'Gardening & Lawn Mowing'), false);
  assert.equal(new Set(recommendations.map(item => item.category)).size, recommendations.length);
  assert.ok(recommendations.length <= 3);
});

test('custom quote descriptions resolve to an existing category relationship', () => {
  const recommendations = getRecommendedServices([{ description: 'Repair damaged timber fence and gate' }], catalogue);
  assert.deepEqual(recommendations.map(item => item.category), ['Decking', 'Gardening & Lawn Mowing', 'Painting']);
  assert.equal(recommendations.some(item => item.category === 'Fencing'), false);
});

test('starting rate is derived from available rate-card minJobPrice and never invented', () => {
  const withMultipleRates = [...catalogue.filter(item => item.label !== 'Fencing'), {
    label: 'Fencing',
    tasks: [
      { itemId: 'FEN-001', name: 'Fence one', minJobPrice: 450 },
      { itemId: 'FEN-002', name: 'Fence two', minJobPrice: 360 },
      { itemId: 'FEN-003', name: 'Unavailable', minJobPrice: 20, unavailable: true },
    ],
  }];
  const fencing = getRecommendedServices([{ rateCardItemId: 'GLM-001' }], withMultipleRates)
    .find(item => item.category === 'Fencing');
  assert.equal(fencing.startingPriceDollars, 360);
});

test('missing rate and image are handled without inventing data or breaking output', () => {
  const recommendations = getRecommendedServices([{ rateCardItemId: 'GLM-001' }], catalogue);
  const maintenance = recommendations.find(item => item.category === 'Property Maintenance');
  assert.equal(maintenance.startingPriceDollars, null);
  assert.equal(maintenance.image, 'images/categories/property-maintenance.jpg');
  assert.equal(categoryImage({ label: 'Unknown Service', tasks: [] }), FALLBACK_IMAGE);
});

test('unknown quote or unavailable catalogue safely produces no recommendations', () => {
  assert.deepEqual(getRecommendedServices([{ description: 'Custom specialist scope' }], catalogue), []);
  assert.deepEqual(getRecommendedServices([{ rateCardItemId: 'GLM-001' }], null), []);
});

test('recommendation output cannot modify quote totals and starts a separate catalogue journey', () => {
  const quote = { totalIncGstCents: 275000, gstCents: 25000, lineItems: [{ rateCardItemId: 'GLM-001' }] };
  const before = JSON.stringify(quote);
  const recommendations = getRecommendedServices(quote.lineItems, catalogue);
  assert.equal(JSON.stringify(quote), before);
  for (const recommendation of recommendations) {
    assert.deepEqual(recommendation.destination, {
      page: 'mysubbies-website.html#categories',
      category: recommendation.category,
    });
    assert.equal(Object.hasOwn(recommendation, 'quoteId'), false);
    assert.equal(Object.hasOwn(recommendation, 'quoteToken'), false);
  }
});
