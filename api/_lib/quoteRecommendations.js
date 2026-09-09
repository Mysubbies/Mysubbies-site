const RELATIONSHIPS = {
  'Gardening & Lawn Mowing': ['Fencing', 'Decking', 'Property Maintenance'],
  'Grass Installation': ['Gardening & Lawn Mowing', 'Fencing', 'Decking'],
  Fencing: ['Decking', 'Gardening & Lawn Mowing', 'Painting'],
  Decking: ['Pergola', 'Fencing', 'Painting'],
  Pergola: ['Decking', 'Fencing', 'Gardening & Lawn Mowing'],
  Handyman: ['Property Maintenance', 'Painting', 'Cabinetry'],
  Cleaning: ['Property Maintenance', 'Gardening & Lawn Mowing', 'Handyman'],
  'Property Maintenance': ['Handyman', 'Cleaning', 'Gardening & Lawn Mowing'],
  Painting: ['Handyman', 'Property Maintenance', 'Cleaning'],
};

const CATEGORY_IMAGES = {
  Fencing: 'images/categories/fencing.jpg',
  Decking: 'images/categories/decking.jpg',
  Pergola: 'images/categories/pergola.jpg',
  'Gardening & Lawn Mowing': 'images/categories/gardening-lawn-mowing.jpg',
  'Grass Installation': 'images/categories/grass-installation.jpg',
  Handyman: 'images/categories/handyman.jpg',
  Cleaning: 'images/categories/cleaning.jpg',
  Painting: 'images/categories/painting.jpg',
  Cabinetry: 'images/categories/cabinetry.jpg',
  'Property Maintenance': 'images/categories/property-maintenance.jpg',
};

const FALLBACK_IMAGE = 'images/categories/property-maintenance.jpg';

const CATEGORY_ALIASES = {
  'Gardening & Lawn Mowing': ['garden', 'gardening', 'lawn', 'mowing', 'hedge', 'weeding'],
  'Grass Installation': ['turf', 'artificial grass', 'grass installation'],
  Fencing: ['fence', 'fencing', 'gate'],
  Decking: ['deck', 'decking'],
  Pergola: ['pergola', 'outdoor structure'],
  Handyman: ['handyman', 'home repair', 'furniture assembly', 'flat-pack', 'shelving'],
  Cleaning: ['clean', 'cleaning', 'gutter cleaning', 'pressure washing'],
  Painting: ['paint', 'painting', 'stain', 'staining'],
  'Property Maintenance': ['property maintenance', 'silicone replacement', 'flyscreen'],
};

function identifyQuotedCategories(lineItems, categories) {
  const ids = new Set((lineItems || []).map(item => item && item.rateCardItemId).filter(Boolean));
  const exact = (categories || []).filter(category =>
    (category.tasks || []).some(task => ids.has(task.itemId))).map(category => category.label);
  if (exact.length) return exact;

  const text = (lineItems || []).map(item => item && item.description).filter(Boolean).join(' ').toLowerCase();
  if (!text) return [];
  return (categories || []).filter(category => {
    const label = String(category.label || '').toLowerCase();
    const aliases = CATEGORY_ALIASES[category.label] || [];
    return label && (text.includes(label) || aliases.some(alias => text.includes(alias)) || (category.tasks || []).some(task =>
      String(task.name || '').length > 5 && text.includes(String(task.name).toLowerCase())));
  }).map(category => category.label);
}

function startingPrice(category) {
  const prices = (category.tasks || [])
    .filter(task => !task.unavailable && task.minJobPrice != null)
    .map(task => Number(task.minJobPrice))
    .filter(price => Number.isFinite(price) && price > 0);
  return prices.length ? Math.min(...prices) : null;
}

function categoryImage(category) {
  const taskImage = (category.tasks || []).map(task => task.photoUrl).find(Boolean);
  return taskImage || CATEGORY_IMAGES[category.label] || FALLBACK_IMAGE;
}

function getRecommendedServices(lineItems, categories, max = 3) {
  if (!Array.isArray(categories) || !categories.length) return [];
  const quoted = identifyQuotedCategories(lineItems, categories);
  if (!quoted.length) return [];
  const byLabel = new Map(categories.map(category => [category.label, category]));
  const excluded = new Set(quoted);
  const labels = [];
  for (const source of quoted) {
    for (const label of RELATIONSHIPS[source] || []) {
      if (!excluded.has(label) && !labels.includes(label) && byLabel.has(label)) labels.push(label);
    }
  }
  return labels.slice(0, Math.max(0, Math.min(3, max))).map(label => {
    const category = byLabel.get(label);
    return {
      category: label,
      displayName: label === 'Fencing' ? 'Fencing & gates' : label,
      image: categoryImage(category),
      startingPriceDollars: startingPrice(category),
      destination: { page: 'mysubbies-website.html#categories', category: label },
    };
  });
}

module.exports = { FALLBACK_IMAGE, identifyQuotedCategories, startingPrice, categoryImage, getRecommendedServices };
