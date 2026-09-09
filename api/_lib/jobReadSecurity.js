// Unassigned offers are visible before a contractor has a relationship with
// the customer. Keep this allow-list intentionally short. In particular,
// item.notes can contain courier pickup/delivery addresses and is excluded.
function toSafeUnassignedOffer(record, jobNumber) {
  return {
    id: record.id,
    jobNumber,
    category: record.category,
    icon: record.icon || null,
    suburb: record.suburb || null,
    urgency: record.urgency || null,
    basePrice: record.basePrice == null ? null : record.basePrice,
    items: Array.isArray(record.items) ? record.items.map(item => ({
      taskName: item.taskName || null,
      qty: item.qty == null ? null : item.qty,
      unit: item.unit || null,
    })) : [],
    status: 'feed',
    createdAt: record.createdAt || null,
  };
}

module.exports = { toSafeUnassignedOffer };
