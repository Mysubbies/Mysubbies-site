// Inline checkout cart. Updating this region never recreates account/address inputs.
let bookingCartCatalogue = [];
let bookingCartPreferredCategory = '';
let bookingCartPricingPending = 0;
const bookingCartPriceRequests = new WeakMap();
function cartEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function bookingCartMarkup(items, options = {}) {
  const estimator = options.estimator === true;
  const total = items.reduce((sum, item) => sum + Number(item.base), 0);
  return `<section id="${estimator ? 'estBookingCart' : 'bookingCart'}" aria-label="Job summary">
    <div class="cart-section-heading"><h2>Your job</h2><span>${items.length} task${items.length === 1 ? '' : 's'}</span></div>
    ${items.length ? items.map((item, index) => `<article class="booking-cart-item">
      <div class="booking-item-heading"><h3>${cartEscape(item.taskName)}</h3><button type="button" class="booking-item-remove" aria-label="Remove ${cartEscape(item.taskName)}" onclick="${estimator ? 'removeFromCart' : 'removeBookingCartItem'}(${index})">×</button></div>
      <div class="booking-item-body"><div class="booking-item-controls">
        ${!item.aiEstimated && item.catLabel !== 'Courier Services' ? `<label class="booking-quantity">Quantity <input type="number" aria-label="Quantity for ${cartEscape(item.taskName)}" min="0.01" max="100000" step="any" value="${Number(item.qty)}" onchange="${estimator ? 'updateCartQuantity' : 'updateBookingCartQuantity'}(${index}, this.value)"><span>${cartEscape(String(item.unit || '').replace(/^per\s+/i, ''))}</span></label>` : `<span class="booking-unit">${cartEscape(item.qty)} ${cartEscape(item.unit)}</span>`}
      </div><strong class="booking-item-price">$${Number(item.base).toLocaleString()}</strong></div>
      ${item.notes ? `<details class="booking-inclusions"><summary>What’s included</summary><p>${cartEscape(item.notes)}</p></details>` : ''}
    </article>`).join('') : '<p class="booking-cart-empty">Your cart is empty. Add a task to continue. Your details are still saved on this page.</p>'}
    <div class="booking-totals"><div class="booking-total-row"><span>Job total</span><strong>$${total.toLocaleString()}</strong></div><div class="booking-due-row"><span>Due at booking</span><strong>$0</strong></div><p class="booking-fee-note"><span aria-hidden="true">✓</span> No booking fee</p></div>
    <div class="booking-cart-actions"><button type="button" class="booking-add-task" onclick="${estimator ? 'estAddAnotherService' : 'openBookingCartAdd'}()"><span aria-hidden="true">+</span> Add another task</button><button type="button" class="booking-request-quote" onclick="${estimator ? 'openComplexJobRequest' : 'requestQuoteForBookingCart'}()">Need a custom quote? <span>Submit your job →</span></button></div>
    ${estimator ? '' : '<p id="bookingCartPriceStatus" class="booking-price-status" role="status" aria-live="polite"></p><div id="bookingCartAdd" class="booking-cart-add"></div>'}
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
  if (confirm) confirm.disabled = quote.items.length === 0 || bookingCartPricingPending > 0;
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
      category.disabled || category.unavailable || category.label === 'Courier Services' ? [] : (category.tasks || []).filter(task => !task.disabled && !task.unavailable && !task.needsSiteVisit && Number.isFinite(task.rate) && task.rate > 0).map(task => ({ category, task })));
    if (!bookingCartCatalogue.length) throw new Error();
    if (!region.isConnected) return;
    bookingCartPreferredCategory = quote.items.at(-1)?.catLabel || '';
    const categories = [...new Set(bookingCartCatalogue.map(entry => entry.category.label))];
    region.innerHTML = `<div class="booking-task-picker"><label for="bookingTaskSearch">Find another task</label><input type="search" id="bookingTaskSearch" placeholder="Search tasks, e.g. lawn edging" oninput="renderBookingTaskResults(true)">
      <label for="bookingTaskCategory">Service</label><select id="bookingTaskCategory" onchange="renderBookingTaskResults()"><option value="">All services</option>${categories.map(category => `<option value="${cartEscape(category)}" ${category === bookingCartPreferredCategory ? 'selected' : ''}>${cartEscape(category)}</option>`).join('')}</select>
      <div id="bookingTaskResults" class="booking-task-results" aria-live="polite"></div>
      <input type="hidden" id="bookingCartTask" value=""><p id="bookingTaskChoice" class="booking-task-choice"></p>
      <div id="bookingTaskQuantity" hidden><label for="bookingCartQty">Quantity</label><input id="bookingCartQty" type="number" value="1" min="0.01" max="100000" step="any"></div>
      <div id="bookingCartAddError" role="alert"></div>
      <button type="button" class="btn btn-black" id="bookingAddTaskConfirm" onclick="addBookingCartItem()" disabled>Add task</button>
      <button type="button" class="btn btn-outline" onclick="document.getElementById('bookingCartAdd').replaceChildren()">Close</button></div>`;
    renderBookingTaskResults();
  } catch (_) { if (region.isConnected) region.innerHTML = '<p role="alert">Could not load tasks. Your cart and details are unchanged.</p><button type="button" class="btn btn-outline" onclick="openBookingCartAdd()">Try again</button>'; }
}
function addBookingCartItem() {
  if (bookingSubmitting || !quote) return;
  const selectedValue = document.getElementById('bookingCartTask').value;
  const choice = selectedValue === '' ? null : bookingCartCatalogue[Number(selectedValue)];
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

async function updateBookingCartQuantity(index, value) {
  if (bookingSubmitting || !quote?.items[index]) return;
  const item = quote.items[index];
  const qty = Number(value);
  if (item.catLabel === 'Courier Services' || item.aiEstimated || !Number.isFinite(qty) || qty <= 0 || qty > 100000) { saveBookingCart(); return; }
  const token = (bookingCartPriceRequests.get(item) || 0) + 1;
  bookingCartPriceRequests.set(item, token);
  bookingCartPricingPending++;
  setBookingPriceFeedback();
  try {
    const response = await fetch('/api/rate-card', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load current prices.');
    const data = await response.json();
    const category = (data.categories || []).find(c => c.label === item.catLabel && !c.disabled && !c.unavailable);
    const task = category && category.tasks.find(t => t.name === item.taskName && !t.disabled && !t.unavailable && Number.isFinite(t.rate) && t.rate > 0);
    if (!task || task.needsSiteVisit) throw new Error('This task requires review before its price can be updated.');
    // The customer may have removed a row while its price was loading.
    if (bookingSubmitting || !quote.items.includes(item) || bookingCartPriceRequests.get(item) !== token) return;
    const raw = Math.round(qty * task.rate);
    Object.assign(item, { qty, base: Math.max(raw, Number(task.minJobPrice) || 0), minApplied: raw < (Number(task.minJobPrice) || 0), notes: task.notes || '' });
    saveBookingCart();
  } catch (error) {
    const region = document.getElementById('bookingCartAdd');
    if (region) region.textContent = error.message + ' Your original quantity and price are unchanged.';
  } finally { bookingCartPricingPending--; setBookingPriceFeedback(); }
}

function requestQuoteForBookingCart() {
  if (bookingSubmitting) return;
  saveBookingDetails();
  try { sessionStorage.setItem('mysubbies_estimator_draft_v1', JSON.stringify({ cart:quote.items, site:quote.site, access:quote.access, urgency:quote.urgency, suburb:quote.suburb, photos:quote.photoDataUrls || [], savedAt:Date.now() })); } catch (_) {}
  window.location.href = '/?quote-request=1#estimate';
}

function setBookingPriceFeedback() {
  const status = document.getElementById('bookingCartPriceStatus');
  if (status) status.textContent = bookingCartPricingPending ? 'Updating price…' : '';
  const button = document.getElementById('confirmFreeBooking');
  if (button) button.disabled = bookingSubmitting || bookingCartPricingPending > 0 || !quote?.items.length;
}
function bookingTaskMatches(entry, query, category) {
  if (category && entry.category.label !== category) return false;
  const text = `${entry.category.label} ${entry.task.name} ${(entry.task.searchTags || []).join(' ')}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => text.includes(word));
}
function renderBookingTaskResults(fromSearch = false) {
  document.getElementById('bookingCartTask').value = '';
  document.getElementById('bookingTaskChoice').textContent = '';
  document.getElementById('bookingTaskQuantity').hidden = true;
  document.getElementById('bookingAddTaskConfirm').disabled = true;
  const input = document.getElementById('bookingTaskSearch');
  const category = document.getElementById('bookingTaskCategory').value;
  const query = input.value.trim();
  // Searching can cross service categories; the filter still offers an explicit choice.
  if (fromSearch && !query) document.getElementById('bookingTaskCategory').value = bookingCartPreferredCategory;
  if (fromSearch && query && category === bookingCartPreferredCategory) document.getElementById('bookingTaskCategory').value = '';
  const activeCategory = document.getElementById('bookingTaskCategory').value;
  const family = value => String(value).split(/\s+[—–]\s*/)[0].toLowerCase();
  const chosen = new Set((quote.items || []).map(item => family(item.taskName)));
  const matches = bookingCartCatalogue.map((entry,index) => ({ ...entry,index }))
    .filter(entry => bookingTaskMatches(entry, query, activeCategory))
    .filter(entry => query || !chosen.has(family(entry.task.name)));
  const results = document.getElementById('bookingTaskResults');
  results.innerHTML = matches.slice(0,8).map(entry => `<button type="button" class="booking-task-result" onclick="chooseBookingTask(${entry.index})"><span><strong>${cartEscape(entry.task.name)}</strong><small>${cartEscape(entry.category.label)}</small></span><span>$${entry.task.rate.toLocaleString()} / ${cartEscape(entry.task.unit || 'job')}</span></button>`).join('') || '<p>No matching listed task. Try another search or submit your job for a custom quote.</p>';
  if (matches.length > 8) results.insertAdjacentHTML('beforeend', '<p class="booking-search-hint">Keep typing to narrow the results.</p>');
}
function chooseBookingTask(index) {
  const entry = bookingCartCatalogue[index]; if (!entry) return;
  document.getElementById('bookingCartTask').value = String(index);
  document.getElementById('bookingTaskChoice').textContent = `${entry.task.name} · $${entry.task.rate.toLocaleString()} / ${entry.task.unit || 'job'}`;
  document.getElementById('bookingTaskQuantity').hidden = false;
  document.getElementById('bookingAddTaskConfirm').disabled = false;
  document.getElementById('bookingCartQty').focus();
}
