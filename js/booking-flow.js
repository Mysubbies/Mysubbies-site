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
