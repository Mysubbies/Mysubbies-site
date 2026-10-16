// Inline checkout cart. Updating this region never recreates account/address inputs.
let bookingCartCatalogue = [];
function cartEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function bookingCartMarkup(items) {
  return `<section id="bookingCart"><h2 style="font-size:17px;">Your cart</h2>
    ${items.length ? items.map((item, index) => `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);">
      <div style="flex:1;">${cartEscape(item.taskName)}<div style="font-size:12px;color:var(--stone);">${cartEscape(item.catLabel)} · ${cartEscape(item.qty)} ${cartEscape(item.unit)}</div></div>
      <strong>$${Number(item.base).toLocaleString()}</strong>
      <button type="button" aria-label="Remove ${cartEscape(item.taskName)}" onclick="removeBookingCartItem(${index})" style="min-width:44px;min-height:44px;border:0;background:transparent;font-size:24px;cursor:pointer;">×</button>
    </div>`).join('') : '<p>Your cart is empty. Add a task to continue. Your details are still saved on this page.</p>'}
    <p><strong>Job total: $${items.reduce((sum, i) => sum + Number(i.base), 0).toLocaleString()}</strong> · $0 due at booking</p>
    <button type="button" class="btn btn-outline" onclick="openBookingCartAdd()">+ Add another job / task</button>
    <div id="bookingCartAdd" style="margin-top:12px;"></div>
  </section>`;
}
function saveBookingCart() {
  quote.needsSiteVisit = quote.items.some(item => item.needsSiteVisit);
  quote.base = quote.low = quote.high = quote.items.reduce((sum, i) => sum + Number(i.base), 0);
  const categories = [...new Set(quote.items.map(i => i.catLabel))];
  quote.category = categories.join(' + ');
  quote.icon = quote.items[0]?.catIcon || '';
  try { localStorage.setItem('mysubbies_pending_quote', JSON.stringify(quote)); } catch (_) { /* Keep current in-page details if storage is full. */ }
  const cart = document.getElementById('bookingCart');
  if (cart) cart.outerHTML = bookingCartMarkup(quote.items);
  const summaryPrice = document.querySelector('.qprice');
  if (summaryPrice) summaryPrice.textContent = '$' + quote.low.toLocaleString();
  const category = document.querySelector('.qcat');
  if (category) category.textContent = quote.category || 'Your cart';
  const count = document.querySelector('.qsub');
  if (count) count.textContent = `${quote.items.length} items${quote.suburb ? ' · ' + quote.suburb : ''}`;
  const confirm = document.getElementById('confirmFreeBooking');
  if (confirm) confirm.disabled = quote.items.length === 0;
}
function removeBookingCartItem(index) {
  if (bookingSubmitting || !quote || !Number.isInteger(index) || !quote.items[index]) return;
  quote.items.splice(index, 1);
  saveBookingCart();
}
async function openBookingCartAdd() {
  if (bookingSubmitting) return;
  const region = document.getElementById('bookingCartAdd');
  if (!region) return;
  region.textContent = 'Loading available tasks…';
  try {
    const response = await fetch('/api/rate-card', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const data = await response.json();
    bookingCartCatalogue = (data.categories || []).flatMap(category =>
      category.disabled || category.unavailable ? [] : (category.tasks || []).filter(task => !task.disabled && !task.unavailable && Number.isFinite(task.rate) && task.rate > 0).map(task => ({ category, task })));
    if (!bookingCartCatalogue.length) throw new Error();
    if (!region.isConnected) return;
    region.innerHTML = `<label>Choose a task<select id="bookingCartTask" style="display:block;width:100%;padding:10px;margin:8px 0;">${bookingCartCatalogue.map(({category,task},index) => `<option value="${index}">${cartEscape(category.label)} — ${cartEscape(task.name)} ($${task.rate.toLocaleString()} / ${cartEscape(task.unit)})</option>`).join('')}</select></label>
      <label>Quantity <input id="bookingCartQty" type="number" value="1" min="0.01" max="100000" step="any" style="padding:10px;width:100px;"></label>
      <div id="bookingCartAddError" role="alert"></div>
      <button type="button" class="btn btn-black" onclick="addBookingCartItem()">Add to cart</button>
      <button type="button" class="btn btn-outline" onclick="document.getElementById('bookingCartAdd').replaceChildren()">Close</button>`;
  } catch (_) { if (region.isConnected) region.innerHTML = '<p role="alert">Could not load tasks. Your cart and details are unchanged.</p><button type="button" class="btn btn-outline" onclick="openBookingCartAdd()">Try again</button>'; }
}
function addBookingCartItem() {
  if (bookingSubmitting || !quote) return;
  const choice = bookingCartCatalogue[Number(document.getElementById('bookingCartTask').value)];
  const qty = Number(document.getElementById('bookingCartQty').value);
  if (!choice || !Number.isFinite(qty) || qty <= 0 || qty > 100000) {
    document.getElementById('bookingCartAddError').textContent = 'Enter a quantity greater than zero, up to 100,000.'; return;
  }
  const { category, task } = choice;
  const rawBase = Math.round(qty * task.rate);
  const base = Math.max(rawBase, Number(task.minJobPrice) || 0);
  quote.items.push({catLabel:category.label,catIcon:category.icon,taskName:task.name,unit:task.unit,qty,base,
    minApplied:base > rawBase,minJobPrice:task.minJobPrice,needsSiteVisit:!!task.needsSiteVisit,notes:task.notes || ''});
  quote.needsSiteVisit = quote.items.some(item => item.needsSiteVisit);
  saveBookingCart();
}
