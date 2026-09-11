class BookingPriceError extends Error {}

async function authoritativeBookingPrice(supabase, category, items) {
  if (!Array.isArray(items) || !items.length) throw new BookingPriceError('Booking items are required.');
  const { data, error } = await supabase.from('platform_rate_card').select('categories').eq('id', true).maybeSingle();
  if (error) throw error;
  if (!data || !Array.isArray(data.categories)) throw new BookingPriceError('The rate card is not configured.');
  let totalCents = 0;
  for (const submitted of items) {
    const cat = data.categories.find(c => c && !c.deleted && c.label === submitted.catLabel);
    if (!cat || cat.label !== category) throw new BookingPriceError('The selected service is unavailable.');
    const task = (cat.tasks || []).find(t => t && t.name === submitted.taskName && !t.disabled && !t.unavailable);
    const qty = Number(submitted.qty);
    if (!task || !Number.isFinite(qty) || qty <= 0 || qty > 100000) throw new BookingPriceError('A booking item is invalid or unavailable.');
    const dollars = Math.max(Math.round(qty * Number(task.rate)), Number(task.minJobPrice) || 0);
    if (!Number.isFinite(dollars) || dollars <= 0) throw new BookingPriceError('A booking item has no valid price.');
    totalCents += Math.round(dollars * 100);
  }
  return totalCents;
}

module.exports = { BookingPriceError, authoritativeBookingPrice };
