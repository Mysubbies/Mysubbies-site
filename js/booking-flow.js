function estimatorRequiresReview() {
  const questions = TARGETED_QUESTIONS[selectedCat ? selectedCat.label : ''] || [];
  return cart.some(item => item.needsSiteVisit || item.aiEstimated) || questions.some(q => q.risky.includes(riskAnswers[q.id]));
}
// Presentation and draft handling for the three-screen booking flow.
// All standard prices continue to come from the existing rate-card calculator.
const ESTIMATOR_DRAFT_KEY = 'mysubbies_estimator_draft_v1';
let complexJobSending = false;
let complexJobQuery = '';
function saveEstimatorDraft() {
  try {
    sessionStorage.setItem(ESTIMATOR_DRAFT_KEY, JSON.stringify({
      cart, site: selectedSite, access: selectedAccess, urgency: selectedUrgency,
      suburb: document.getElementById('estSuburb').value,
      photos: uploadedPhotos, savedAt: Date.now()
    }));
  } catch (_) { /* Current page remains usable when session storage is full. */ }
}
function renderComplexJobOffer(query) {
  complexJobQuery = query || '';
  const line = document.getElementById('estTierMatchLine');
  line.className = 'est-match-line none';
  line.innerHTML = '<strong>Some jobs need a closer look</strong><p>Complex or unlisted jobs may require review before we can provide a price.</p><button type="button" class="btn btn-outline" onclick="openComplexJobRequest(complexJobQuery)">Submit for a quote</button>';
}
function openComplexJobRequest(description) {
  const estimator = document.getElementById('estimate');
  let panel = document.getElementById('complexJobRequest');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'complexJobRequest';
    panel.innerHTML = `<h3>Some jobs need a closer look</h3>
      <p>Complex or unlisted jobs may require review before we can provide a price. Submit your job details and photos, and we’ll send you a quote as soon as possible.</p>
      <p><strong>No booking fee. You approve the quote before work proceeds.</strong></p>
      <form id="complexJobForm">
        <label>Tell us about the job<textarea id="cqDescription" required maxlength="4000" rows="4"></textarea></label>
        <label>Your name<input id="cqName" autocomplete="name" required maxlength="120"></label>
        <label>Email<input id="cqEmail" type="email" autocomplete="email" required maxlength="254"></label>
        <label>Phone<input id="cqPhone" type="tel" autocomplete="tel" required maxlength="40"></label>
        <label>Suburb<input id="cqSuburb" autocomplete="address-level2" required maxlength="120"></label>
        <div id="cqPhotos"></div>
        <p>By submitting, you agree to our <a href="/mysubbies-terms.html" target="_blank">Terms &amp; Conditions</a> and <a href="/mysubbies-privacy-policy.html" target="_blank">Privacy Policy</a>.</p>
        <p id="cqError" role="alert"></p>
        <button type="submit" class="btn btn-black" id="cqSubmit">Submit for a quote</button>
      </form>
      <button type="button" class="btn btn-outline" id="cqBack" onclick="closeComplexJobRequest()">← Back to instant pricing</button>`;
    estimator.appendChild(panel);
    document.getElementById('complexJobForm').addEventListener('submit', submitComplexJobRequest);
    try {
      const email = localStorage.getItem('mysubbies_customer_email');
      const account = JSON.parse(localStorage.getItem('mysubbies_customers') || '{}')[email] || {};
      document.getElementById('cqName').value = account.name || '';
      document.getElementById('cqEmail').value = email || '';
      document.getElementById('cqPhone').value = account.phone || '';
      document.getElementById('cqSuburb').value = account.suburb || document.getElementById('estSuburb').value || '';
    } catch (_) {}
  }
  if (description && !document.getElementById('cqDescription').value) document.getElementById('cqDescription').value = description;
  if (!document.getElementById('cqDescription').value) document.getElementById('cqDescription').value = document.getElementById('estCategoryInput').value;
  // Move the same upload controls so selected photos survive both paths.
  document.getElementById('cqPhotos').appendChild(document.getElementById('estOptionalDetails'));
  document.getElementById('estOptionalDetails').open = true;
  document.getElementById('estQuestionsWrap').hidden = true;
  document.getElementById('estSiteFieldsWrap').hidden = true;
  estimator.querySelector('.estimator-label').textContent = 'Request a quote';
  estimator.classList.add('quote-request-mode');
  panel.hidden = false;
  estimator.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeComplexJobRequest() {
  if (complexJobSending) return;
  const panel = document.getElementById('complexJobRequest');
  document.querySelector('#estimate .est-step[data-step="1"]').insertBefore(document.getElementById('estOptionalDetails'), document.getElementById('estStep1Error'));
  document.getElementById('estQuestionsWrap').hidden = false;
  document.getElementById('estSiteFieldsWrap').hidden = false;
  document.querySelector('#estimate .estimator-label').textContent = 'Get an estimated price instantly';
  document.getElementById('estimate').classList.remove('quote-request-mode');
  if (panel) panel.hidden = true;
  showEstStep(1);
}
async function submitComplexJobRequest(event) {
  event.preventDefault();
  if (complexJobSending) return;
  const form = document.getElementById('complexJobForm');
  if (!form.reportValidity()) return;
  const field = id => document.getElementById(id).value.trim();
  const error = document.getElementById('cqError');
  error.textContent = '';
  if (typeof photoUploadsPending !== 'undefined' && photoUploadsPending) { error.textContent = 'Please wait for your photos to finish uploading.'; return; }
  const description = field('cqDescription');
  if (!description || !field('cqName') || !field('cqPhone') || !field('cqSuburb')) { error.textContent = 'Please complete the job and contact details.'; return; }
  const payload = {
    entity: 'inquiries', action: 'create', role: 'customer', purpose: 'quote_request',
    name: field('cqName'), email: field('cqEmail'),
    text: ['Quote request — complex or unlisted job', 'Description: ' + description,
      'Phone: ' + field('cqPhone'), 'Suburb: ' + field('cqSuburb'),
      'Listed tasks (if any): ' + cart.map(i => `${i.taskName}: ${i.qty} ${i.unit}`).join('; '),
      'Price pending MySubbies review. Customer approval required before work proceeds.'].join('\n'),
    attachments: uploadedPhotos.map((dataUrl, i) => ({ name: `job-photo-${i + 1}.${dataUrl.startsWith('data:image/png;') ? 'png' : dataUrl.startsWith('data:image/webp;') ? 'webp' : 'jpg'}`, dataUrl }))
  };
  if (new Blob([JSON.stringify(payload)]).size > 3500000) { error.textContent = 'These photos are too large to send together. Remove a photo and try again; your details are saved here.'; return; }
  complexJobSending = true;
  document.getElementById('cqSubmit').disabled = true;
  document.getElementById('cqBack').disabled = true;
  try {
    const response = await fetch('/api/support', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok || !result.id) throw new Error(result.error || 'Could not submit your request. Please try again.');
    form.hidden = true;
    document.getElementById('cqBack').hidden = true;
    const done = document.createElement('div');
    done.setAttribute('role', 'status');
    const heading = document.createElement('h3'); heading.textContent = 'Quote request received';
    const message = document.createElement('p'); message.textContent = 'We’ll review your job and send you a quote as soon as possible. No booking fee. You approve the quote before work proceeds.';
    const reference = document.createElement('p'); reference.textContent = 'Request reference: ' + result.id;
    done.append(heading, message, reference);
    document.getElementById('complexJobRequest').appendChild(done);
    // A quote request never creates a priced booking or sends work to contractors.
  } catch (err) {
    error.textContent = err.message;
    complexJobSending = false;
    document.getElementById('cqSubmit').disabled = false;
    document.getElementById('cqBack').disabled = false;
  }
}
(function initBookingFlow() {
  const estimator = document.getElementById('estimate');
  const request = document.createElement('button');
  request.type = 'button'; request.className = 'btn btn-outline btn-full';
  request.textContent = 'Can’t find your task? Submit for a quote';
  request.style.marginTop = '12px'; request.onclick = () => openComplexJobRequest();
  document.querySelector('#estimate .est-step[data-step="1"] .est-step-nav').after(request);
  // Inputs and quantity edits retain the cart and context when navigating back.
  let timer;
  estimator.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(saveEstimatorDraft, 350); });
  estimator.addEventListener('change', saveEstimatorDraft);
  window.addEventListener('pagehide', saveEstimatorDraft);
  // A checkout handoff keeps its existing priced tasks and photos.
  if (new URLSearchParams(location.search).get('quote-request') === '1') {
    setTimeout(() => openComplexJobRequest(), 0);
  }
  try {
    const draft = JSON.parse(sessionStorage.getItem(ESTIMATOR_DRAFT_KEY) || 'null');
    if (!draft || Date.now() - draft.savedAt > 86400000 || cart.length) return;
    // Re-price saved standard tasks against today's catalogue. Never restore an AI price.
    cart = (draft.cart || []).flatMap(item => {
      const category = CATEGORIES.find(c => c.label === item.catLabel && !c.disabled);
      const task = category && category.tasks.find(t => t.name === item.taskName && !t.disabled && !t.unavailable && Number.isFinite(Number(t.rate)));
      if (!task || item.aiEstimated || !(Number(item.qty) > 0)) return [];
      if (category.label === 'Courier Services') return [item];
      const raw = Math.round(Number(item.qty) * Number(task.rate));
      return [{ ...item, base: Math.max(raw, Number(task.minJobPrice) || 0), notes: task.notes || '', needsSiteVisit: !!task.needsSiteVisit }];
    });
    selectedSite = draft.site; selectedAccess = draft.access; selectedUrgency = draft.urgency;
    document.getElementById('estSuburb').value = draft.suburb || '';
    document.getElementById('estSiteText').value = draft.site || '';
    uploadedPhotos = Array.isArray(draft.photos) ? draft.photos.filter(x => typeof x === 'string' && x.startsWith('data:image/')).slice(0, 5) : [];
    renderPhotoGrid(); renderCart();
    if (cart.length) showEstStep(2);
  } catch (_) { /* A missing or malformed draft must not block a new booking. */ }
})();

// Keep the chosen job distinct from optional extras. These controls only
// change selection/presentation; the existing calculator still prices it.
function selectionTaskFamily(name) {
  return String(name || '').split(/\s+[—–]\s*/)[0].trim().toLowerCase();
}
function removeSelectedJob(taskName, changing = false) {
  selectedTierSet.delete(taskName);
  qtyValues.delete(taskName);
  pendingItems = [];
  selectedTier = Array.from(selectedTierSet.values()).at(-1) || null;
  renderQtyRows(); renderSelectedPills();
  const raw = document.getElementById('estPrimaryQty').value.trim();
  renderPrimaryOptionCards(estPrimaryGroup && raw ? parseQuantity(raw, estPrimaryGroup.unit) : null);
  syncSelectedJobPresentation();
  if (changing) {
    document.getElementById('estOptionalTasks').open = true;
    document.getElementById('estPrimaryCompareWrap').scrollIntoView({ behavior:'smooth', block:'center' });
  }
}
function addOptionalSelectedJob(taskName) {
  const task = selectedCat?.tasks.find(t => t.name === taskName && !t.disabled && !t.unavailable);
  if (!task) return;
  estAddMatchedTask(task);
  if (estPrimaryGroup?.tasks.some(t => t.name === task.name)) {
    const raw = document.getElementById('estPrimaryQty').value.trim();
    if (raw) qtyValues.set(task.name, raw);
  }
  renderQtyRows(); renderSelectedPills();
  syncSelectedJobPresentation();
}
function syncSelectedJobPresentation() {
  const summary = document.getElementById('estSelectedJobs');
  const extras = document.getElementById('estOptionalTasks');
  if (!summary || !extras) return;
  const selected = Array.from(selectedTierSet.values());
  const names = new Set(selected.map(t => t.name));
  const families = new Set(selected.map(t => selectionTaskFamily(t.name)));
  const primarySelected = !!estPrimaryGroup?.tasks.some(t => names.has(t.name));
  document.getElementById('estPrimaryOptions').hidden = selected.length > 0;
  document.getElementById('estSelectedPills').hidden = true;
  document.getElementById('estItemPreview').hidden = true;
  summary.hidden = selected.length === 0;
  summary.replaceChildren();
  for (const task of selected) {
    const card = document.createElement('article'); card.className = 'selected-job-card';
    const title = document.createElement('strong'); title.textContent = task.name;
    const unit = pricingUnitForTask(selectedCat, task);
    const raw = qtyValues.get(task.name);
    const qty = raw ? parseQuantity(raw, unit) : null;
    const price = document.createElement('strong');
    const pending = pendingItems.find(i => i.taskName === task.name);
    if (task.needsSiteVisit) price.textContent = 'Requires review';
    else if (selectedCat.label === 'Courier Services') price.textContent = pending ? '$' + pending.base.toLocaleString() : 'Complete delivery details';
    else if (Number.isFinite(Number(task.rate)) && qty > 0) price.textContent = '$' + Math.max(Math.round(qty * Number(task.rate)), Number(task.minJobPrice) || 0).toLocaleString();
    else price.textContent = task.needsSiteVisit ? 'Requires review' : 'Enter size / quantity';
    const top = document.createElement('div'); top.className = 'selected-job-heading'; top.append(title, price); card.appendChild(top);
    const amount = document.createElement('div'); amount.className = 'selected-job-meta';
    amount.textContent = qty > 0 ? `${qty.toLocaleString()} ${unit}${unit === 'visit' && qty === 1 ? ' · per visit' : ''}` : 'Complete the measurements below';
    card.appendChild(amount);
    if (qty > 0 && Number(task.minJobPrice) > Math.round(qty * Number(task.rate))) {
      const minimum = document.createElement('div'); minimum.className = 'selected-job-meta'; minimum.textContent = 'Minimum job price applies.'; card.appendChild(minimum);
    }
    if (task.notes) {
      const details = document.createElement('details'); const label = document.createElement('summary'); label.textContent = 'What’s included';
      const notes = document.createElement('p'); notes.textContent = task.notes; details.append(label, notes); card.appendChild(details);
    }
    const actions = document.createElement('div'); actions.className = 'selected-job-actions';
    for (const [label, changing] of [['Change', true], ['Remove', false]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.setAttribute('aria-label', label + ' ' + task.name);
      button.onclick = () => removeSelectedJob(task.name, changing); actions.appendChild(button);
    }
    card.appendChild(actions); summary.appendChild(card);
  }
  // The existing secondary picker remains the source of selectable extras.
  // Selected jobs and alternative sizes are hidden until Change is tapped.
  let visibleExtras = 0;
  document.querySelectorAll('#estTierChips .chip-est').forEach(button => {
    const name = button.dataset.taskName;
    const hide = names.has(name) || (selected.length > 0 && families.has(selectionTaskFamily(name)));
    button.hidden = hide;
    if (!hide) {
      visibleExtras++;
      if (!button.disabled && !button.querySelector('.optional-add-label')) {
        const label = document.createElement('span'); label.className = 'optional-add-label'; label.textContent = '+ Add ';
        button.prepend(label);
      }
    }
  });
  // Edging shares mowing's per-visit comparison group, but is an optional
  // extra rather than a competing lawn size. Keep it available on request.
  const additional = document.getElementById('estPrimaryExtras'); additional.replaceChildren();
  if (selected.length) {
    for (const task of estPrimaryGroup?.tasks || []) {
      if (names.has(task.name) || families.has(selectionTaskFamily(task.name)) || task.disabled || task.unavailable) continue;
      if (primarySelected && selectedCat.label !== 'Gardening & Lawn Mowing') continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'chip-est';
      button.textContent = `+ Add ${task.name} · $${Number(task.rate).toLocaleString()} / ${task.unit}`;
      button.onclick = () => addOptionalSelectedJob(task.name); additional.appendChild(button); visibleExtras++;
    }
  }
  const firstSelection = extras.dataset.selectionCount === '0' && selected.length > 0;
  if (firstSelection) extras.open = false;
  if (!selected.length) extras.open = true;
  extras.dataset.selectionCount = String(selected.length);
  extras.querySelector('summary').textContent = selected.length ? '+ Add another task (optional)' : (estPrimaryGroup ? 'Other task options' : 'Choose a task');
  extras.hidden = !visibleExtras && !document.getElementById('estRemovalPrompt').textContent.trim() && !selected.length;
  document.getElementById('estTierWrapLabel').textContent = 'Optional extras';
}
(function initSelectedJobPresentation() {
  const step = document.querySelector('#estimate .est-step[data-step="1"]');
  const summary = document.createElement('section'); summary.id = 'estSelectedJobs'; summary.hidden = true;
  step.insertBefore(summary, document.getElementById('estPrimaryCompareWrap'));
  const extras = document.createElement('details'); extras.id = 'estOptionalTasks'; extras.dataset.selectionCount = '0';
  const label = document.createElement('summary'); label.textContent = '+ Add another task (optional)'; extras.appendChild(label);
  step.insertBefore(extras, document.getElementById('estTierWrap'));
  extras.appendChild(document.getElementById('estTierWrap'));
  const primaryExtras = document.createElement('div'); primaryExtras.id = 'estPrimaryExtras'; extras.appendChild(primaryExtras);
  extras.appendChild(document.getElementById('estRemovalPrompt'));
  const style = document.createElement('style');
  style.textContent = `
    #estimate [hidden] { display:none !important; }
    #estSelectedJobs { margin:16px 0; }
    .selected-job-card { border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:10px; background:white; }
    .selected-job-heading { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
    .selected-job-meta { font-size:13px; color:var(--stone); margin:8px 0; }
    .selected-job-actions { display:flex; gap:20px; margin-top:12px; }
    .selected-job-actions button { background:none; border:0; text-decoration:underline; padding:6px 0; font:inherit; cursor:pointer; }
    .selected-job-card details { font-size:13px; margin:10px 0; }
    #estOptionalTasks { margin:16px 0; padding:14px; border:1px solid var(--line); border-radius:12px; }
    #estOptionalTasks > summary { font-weight:700; cursor:pointer; }
    #estOptionalTasks[open] > summary { margin-bottom:14px; }
    .optional-add-label { font-weight:700; margin-right:4px; }
  `;
  document.head.appendChild(style);
  // Hook the existing render boundaries so pricing, gallery handoffs and
  // quantity changes all refresh the same single selected-job card.
  for (const name of ['selectCat','renderQtyRows','renderSelectedPills','renderPrimaryOptionCards','renderItemsPreview','confirmAddItemsToCart']) {
    const original = window[name];
    window[name] = function(...args) { const result = original.apply(this, args); syncSelectedJobPresentation(); return result; };
  }
  step.addEventListener('input', () => queueMicrotask(syncSelectedJobPresentation));
  syncSelectedJobPresentation();
})();
