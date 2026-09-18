function normalizeText(v) { return String(v || '').trim().toLowerCase(); }

function publicCatalog(categories) {
  return (Array.isArray(categories) ? categories : []).filter(c => !c.deleted).map(c => ({
    category: c.label,
    icon: c.icon || null,
    tasks: (Array.isArray(c.tasks) ? c.tasks : []).filter(t => !t.disabled).map(t => ({
      id: t.itemId || null,
      name: t.name,
      unit: t.unit || 'job',
      priceAvailable: Number.isFinite(Number(t.rate)) && !t.unavailable,
      rate: Number.isFinite(Number(t.rate)) && !t.unavailable ? Number(t.rate) : null,
      minJobPrice: Number.isFinite(Number(t.minJobPrice)) ? Number(t.minJobPrice) : null,
      notes: t.notes || null,
      typicalRange: t.typicalRange || null,
      estimatedTime: t.estTime || null,
      serviceMode: Number.isFinite(Number(t.rate)) && !t.unavailable ? 'instant_price' : 'project_quote',
    })),
  })).filter(c => c.tasks.length);
}

function findTask(categories, categoryName, taskName) {
  const cat = (categories || []).find(c => normalizeText(c.label) === normalizeText(categoryName) && !c.deleted);
  if (!cat) return null;
  const task = (cat.tasks || []).find(t => !t.disabled && normalizeText(t.name) === normalizeText(taskName));
  return task ? { cat, task } : null;
}

function estimateLine(categories, line) {
  const found = findTask(categories, line.category, line.taskName);
  if (!found) return { ok: false, reason: 'Service not found.' };
  const t = found.task;
  if (t.unavailable || !Number.isFinite(Number(t.rate))) {
    return { ok: false, reason: 'This service needs a project quote.', serviceMode: 'project_quote' };
  }
  const qty = Number(line.qty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) return { ok: false, reason: 'Quantity must be greater than zero.' };
  const raw = Number(t.rate) * qty;
  const total = Math.max(raw, Number.isFinite(Number(t.minJobPrice)) ? Number(t.minJobPrice) : 0);
  return {
    ok: true,
    category: found.cat.label,
    taskName: t.name,
    unit: t.unit || 'job',
    qty,
    rate: Number(t.rate),
    minJobPrice: Number.isFinite(Number(t.minJobPrice)) ? Number(t.minJobPrice) : null,
    total,
    totalCents: Math.round(total * 100),
    serviceMode: 'instant_price',
  };
}

async function loadCategories(supabase) {
  const { data, error } = await supabase.from('platform_rate_card').select('categories, updated_at').eq('id', true).maybeSingle();
  if (error) throw error;
  return { categories: data && Array.isArray(data.categories) ? data.categories : [], updatedAt: data ? data.updated_at : null };
}

module.exports = { publicCatalog, findTask, estimateLine, loadCategories };
