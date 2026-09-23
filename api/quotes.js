// GET  /api/quotes?action=list[&customerId=][&status=]        (admin)
// GET  /api/quotes?action=get&id=<quoteId>                    (admin -- full quote + versions + events)
// GET  /api/quotes?action=list_staff                          (admin)
// GET  /api/quotes?token=<raw token>                          (public, rate-limited, read-only)
//
// POST { action:'create_draft', customerId | newCustomer:{name,email,phone},
//        assignedStaffId?, jobId?, lineItems, scopeText, inclusionsText,
//        exclusionsText, validityDays, propertySnapshot }               (admin)
// POST { action:'update_draft', quoteId, ...same fields }                (admin -- draft only)
// POST { action:'issue', quoteId }                                      (admin)
// POST { action:'revise', quoteId }                                     (admin -- from 'sent' only)
// POST { action:'withdraw', quoteId }                                   (admin -- from 'sent' only)
// POST { action:'push_to_portal', quoteId }                             (admin -- accepted quote only, idempotent)
// POST { action:'create_staff', name, email }                           (admin)
// POST { action:'update_staff', id, name, email, active }               (admin)
//
// POST { action:'accept', token, name, email, consent:true }            (public)
// POST { action:'decline', token, reason }                              (public)
// POST { action:'ask_question', token, name, email, question }          (public)
//
// Branded quoting CRM, Stage 1 (Sep 2026) -- see
// supabase/schema_v19_quotes_crm.sql for the full schema this backs and
// the audit notes on why each table looks the way it does. Money is always
// recomputed server-side via api/_lib/quoteMath.js -- a client-submitted
// lineTotalCents/subtotal/gst is never trusted. A bare GET never mutates
// anything (protects against email-preview bots/crawlers); accept/decline
// are separate authenticated POSTs, gated on the token AND on the
// version's own status (only an 'issued' version can be accepted/
// declined -- a draft, superseded, already-accepted/declined, expired or
// withdrawn version always rejects, so an old link can't be used to accept
// obsolete terms even if it still resolves).
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
const { computeQuoteTotals } = require('./_lib/quoteMath');
const { notifyAdmin } = require('./_lib/adminNotify');
const { sendEmailWithResult, escapeHtml } = require('./_lib/email');
const { generateQuotePdf } = require('./_lib/quotePdf');
const { convertAcceptedQuoteToJob, QuoteConversionError } = require('./_lib/quoteToJob');
const { paymentTermsFromVersion, quoteVersionContent } = require('./_lib/quotePersistence');
const { getRecommendedServices, identifyQuotedCategories } = require('./_lib/quoteRecommendations');
const { quoteBaseUrl } = require('./_lib/quoteUrl');
const { renderQuoteEmail } = require('./_lib/quoteEmail');
const { milestoneOptions, validateInvoiceAmount, gstBreakdown } = require('./_lib/quoteInvoice');
const { renderInvoiceEmail } = require('./_lib/invoiceEmail');

const TOKEN_BYTES = 32;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 20;
const TERMS_URL = 'https://app.mysubbies.com.au/mysubbies-terms.html';

async function loadRecommendations(supabase, version) {
  try {
    const { data: rateCard, error } = await supabase.from('platform_rate_card').select('categories').eq('id', true).maybeSingle();
    if (error || !rateCard || !Array.isArray(rateCard.categories)) return { recommendations: [], sourceCategory: null };
    return {
      recommendations: getRecommendedServices(version.line_items, rateCard.categories),
      sourceCategory: identifyQuotedCategories(version.line_items, rateCard.categories)[0] || null,
    };
  } catch (recommendationError) {
    console.error('quote recommendations unavailable:', { code: recommendationError.code || 'unknown' });
    return { recommendations: [], sourceCategory: null };
  }
}

// Standard terms text, keyed by terms_version, returned to BOTH the admin
// builder and the customer quote page so there is one server-side source
// of truth (never duplicated/hand-typed in two HTML files, unlike most
// other content in this codebase, because drift in legal text is a real
// risk). Deliberately references the real, solicitor-reviewed platform
// Terms page rather than inventing new contractual language here.
const STANDARD_QUOTE_TERMS = {
  v1: 'This quote is valid until the expiry date shown above and may be withdrawn or revised after that date. Accepting this quote confirms you agree to the scope, pricing and payment terms described above. This document does not replace the MySubbies Platform Terms, which continue to apply in full -- see mysubbies-terms.html on the MySubbies website. Work is carried out by a vetted MySubbies contractor; any site-specific conditions discovered after acceptance may require a separate variation, which will always be agreed with you before proceeding.',
};
function getTermsText(version) {
  return STANDARD_QUOTE_TERMS[version] || STANDARD_QUOTE_TERMS.v1;
}

function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}
function invoiceBaseUrl() {
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://app.mysubbies.com.au';
  return `${base}/mysubbies-invoice.html`;
}

function bankConfig() {
  const accountName = String(process.env.INVOICE_BANK_ACCOUNT_NAME || '').trim();
  const bsb = String(process.env.INVOICE_BANK_BSB || '').replace(/\s/g, '');
  const accountNumber = String(process.env.INVOICE_BANK_ACCOUNT_NUMBER || '').replace(/\s/g, '');
  if (!accountName || !/^\d{3}-?\d{3}$/.test(bsb) || !/^\d{5,10}$/.test(accountNumber)) return null;
  return { accountName, bsb: bsb.replace(/^(\d{3})(\d{3})$/, '$1-$2'), accountNumber };
}

function serializePayment(row) {
  return {
    id: row.id, amountCents: Number(row.amount_cents), receivedAt: row.received_at,
    method: row.payment_method, reference: row.payment_reference || null,
    notes: row.notes || null, recordedBy: row.recorded_by, createdAt: row.created_at,
  };
}

function serializeInvoice(row, { publicView = false, payments = [] } = {}) {
  const serializedPayments = (payments || []).map(serializePayment);
  const paidCents = serializedPayments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const output = {
    id: row.id, invoiceNumber: row.invoice_number, quoteId: row.quote_id,
    status: row.status, milestoneKey: row.milestone_key, milestoneLabel: row.milestone_label,
    milestonePercentage: row.milestone_percentage == null ? null : Number(row.milestone_percentage),
    customer: row.customer_snapshot || {}, property: row.property_snapshot || null,
    description: row.description, subtotalExGstCents: row.subtotal_ex_gst_cents,
    gstCents: row.gst_cents, totalIncGstCents: row.total_inc_gst_cents,
    bankAccountName: row.bank_account_name, bankBsb: row.bank_bsb,
    bankAccountNumber: row.bank_account_number, issuedAt: row.issued_at,
    dueAt: row.due_at, sentAt: row.sent_at, paidAt: row.paid_at,
    paidCents, balanceCents: Math.max(0, Number(row.total_inc_gst_cents) - paidCents),
    payments: publicView
      ? serializedPayments.map(payment => ({ id: payment.id, amountCents: payment.amountCents, receivedAt: payment.receivedAt, method: payment.method, reference: payment.reference }))
      : serializedPayments,
  };
  if (!publicView) output.createdAt = row.created_at;
  return output;
}

async function resolveInvoiceToken(req, res, supabase) {
  const raw = String((req.query || {}).invoiceToken || '');
  if (!raw) { res.status(400).json({ error: 'A valid invoice link is required.' }); return null; }
  const tokenHash = hashToken(raw);
  const { data: tokenRow } = await supabase.from('document_access_tokens').select('*')
    .eq('token_hash', tokenHash).eq('document_type', 'invoice').maybeSingle();
  if (!tokenRow || tokenRow.revoked_at || new Date(tokenRow.expires_at) <= new Date()) {
    res.status(404).json({ error: 'This invoice link is not valid.' }); return null;
  }
  const { data: invoice } = await supabase.from('invoices').select('*').eq('id', tokenRow.document_id).maybeSingle();
  if (!invoice || invoice.status === 'void') { res.status(404).json({ error: 'This invoice is not available.' }); return null; }
  const { data: entity } = await supabase.from('issuing_entities').select('*').eq('id', invoice.issuing_entity_id).maybeSingle();
  const { data: quote } = await supabase.from('quotes').select('quote_number').eq('id', invoice.quote_id).maybeSingle();
  await supabase.from('document_access_tokens').update({ last_accessed_at: new Date().toISOString() }).eq('id', tokenRow.id);
  const { data: payments } = await supabase.from('invoice_payments').select('*').eq('invoice_id', invoice.id).order('received_at');
  return { invoice, entity, quote, payments: payments || [] };
}

async function handleCreateInvoice(req, res, supabase) {
  const { quoteId, milestoneKey, milestoneLabel, milestonePercentage, amountCents, dueDate } = req.body || {};
  if (!quoteId || !milestoneKey || !milestoneLabel || !dueDate) { res.status(400).json({ error: 'Quote, milestone, label and due date are required.' }); return; }
  const bank = bankConfig();
  if (!bank) { res.status(409).json({ error: 'Invoice bank details are not configured. Add INVOICE_BANK_ACCOUNT_NAME, INVOICE_BANK_BSB and INVOICE_BANK_ACCOUNT_NUMBER in Vercel.' }); return; }
  const dueAt = new Date(`${dueDate}T23:59:59.999Z`);
  if (Number.isNaN(dueAt.getTime())) { res.status(400).json({ error: 'A valid due date is required.' }); return; }
  const { data: quote } = await supabase.from('quotes').select('*').eq('id', quoteId).maybeSingle();
  if (!quote || quote.current_status !== 'accepted') { res.status(409).json({ error: 'Invoices can only be created from an accepted quote.' }); return; }
  const { data: version } = await supabase.from('quote_versions').select('*').eq('id', quote.current_version_id).maybeSingle();
  if (!version || version.status !== 'accepted') { res.status(409).json({ error: 'The accepted quote version could not be found.' }); return; }
  const { data: existing } = await supabase.from('invoices').select('id,status,total_inc_gst_cents,milestone_key').eq('quote_id', quote.id).neq('status', 'void');
  if ((existing || []).some(row => row.milestone_key === milestoneKey)) { res.status(409).json({ error: 'An invoice already exists for this milestone.' }); return; }
  const previous = (existing || []).reduce((sum, row) => sum + Number(row.total_inc_gst_cents || 0), 0);
  const amountError = validateInvoiceAmount({ amountCents: Number(amountCents), quoteTotalCents: version.total_inc_gst_cents, previouslyInvoicedCents: previous });
  if (amountError) { res.status(400).json({ error: amountError }); return; }
  const { data: entity } = await supabase.from('issuing_entities').select('*').eq('id', version.issuing_entity_id).maybeSingle();
  if (!entity || entity.legal_name !== 'Mysubbies Holdings Pty Ltd') { res.status(409).json({ error: 'Mysubbies Holdings Pty Ltd is not configured as the issuing entity.' }); return; }
  const totals = gstBreakdown(Number(amountCents));
  const { data: invoice, error } = await supabase.from('invoices').insert({
    quote_id: quote.id, quote_version_id: version.id, issuing_entity_id: entity.id,
    status: 'issued', milestone_key: String(milestoneKey).slice(0, 80), milestone_label: String(milestoneLabel).trim().slice(0, 120),
    milestone_percentage: milestonePercentage == null ? null : Number(milestonePercentage),
    customer_snapshot: version.customer_snapshot || {}, property_snapshot: version.property_snapshot || null,
    description: `${String(milestoneLabel).trim()} — accepted Quote #${quote.quote_number}`,
    subtotal_ex_gst_cents: totals.subtotalExGstCents, gst_cents: totals.gstCents, total_inc_gst_cents: totals.totalIncGstCents,
    bank_account_name: bank.accountName, bank_bsb: bank.bsb, bank_account_number: bank.accountNumber,
    due_at: dueAt.toISOString(),
  }).select().single();
  if (error) throw error;
  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'invoice_created', actorRole: 'admin', payload: { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number } });
  res.status(200).json({ invoice: serializeInvoice(invoice) });
}

async function handleSendInvoice(req, res, supabase) {
  const { invoiceId } = req.body || {};
  const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
  if (!invoice || invoice.status === 'void') { res.status(404).json({ error: 'Invoice not found.' }); return; }
  const email = invoice.customer_snapshot && invoice.customer_snapshot.email;
  if (!email) { res.status(400).json({ error: 'This invoice has no customer email.' }); return; }
  const { data: quote } = await supabase.from('quotes').select('*').eq('id', invoice.quote_id).maybeSingle();
  const now = new Date();
  await supabase.from('document_access_tokens').update({ revoked_at: now.toISOString() }).eq('document_type', 'invoice').eq('document_id', invoice.id).is('revoked_at', null);
  const rawToken = generateToken();
  const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const { error: tokenError } = await supabase.from('document_access_tokens').insert({ document_type: 'invoice', document_id: invoice.id, token_hash: hashToken(rawToken), expires_at: expiresAt });
  if (tokenError) throw tokenError;
  const url = `${invoiceBaseUrl()}?token=${encodeURIComponent(rawToken)}`;
  const result = await sendEmailWithResult({ to: email, bcc: 'accounts@mysubbies.com.au', subject: `Tax invoice INV-${invoice.invoice_number} — MySubbies`, html: renderInvoiceEmail({ invoice, quote, secureInvoiceUrl: url }) });
  if (!result.ok) { res.status(502).json({ error: result.error, url }); return; }
  const invoiceUpdate = { sent_at: now.toISOString(), updated_at: now.toISOString() };
  if (invoice.status === 'issued') invoiceUpdate.status = 'sent';
  const { data: updated } = await supabase.from('invoices').update(invoiceUpdate).eq('id', invoice.id).select().single();
  await logQuoteEvent(supabase, { quoteId: invoice.quote_id, quoteVersionId: invoice.quote_version_id, eventType: 'invoice_sent', actorRole: 'admin', payload: { invoiceId: invoice.id, invoiceNumber: invoice.invoice_number } });
  res.status(200).json({ ok: true, url, invoice: serializeInvoice(updated) });
}

async function handleRecordInvoicePayment(req, res, supabase) {
  const { invoiceId, amountCents, receivedAt, method, reference, notes } = req.body || {};
  const cleanAmount = Number(amountCents);
  const allowedMethods = ['bank_transfer', 'card', 'cash', 'finance', 'other'];
  const receivedDate = new Date(receivedAt);
  if (!invoiceId || !Number.isInteger(cleanAmount) || cleanAmount <= 0 || Number.isNaN(receivedDate.getTime()) || !allowedMethods.includes(method)) {
    res.status(400).json({ error: 'Invoice, positive payment amount, received date and payment method are required.' }); return;
  }
  const { data: paymentId, error } = await supabase.rpc('record_invoice_payment', {
    p_invoice_id: invoiceId,
    p_amount_cents: cleanAmount,
    p_received_at: receivedDate.toISOString(),
    p_payment_method: method,
    p_payment_reference: String(reference || '').trim().slice(0, 120) || null,
    p_notes: String(notes || '').trim().slice(0, 1000) || null,
    p_recorded_by: 'admin',
  });
  if (error) {
    const overpayment = /exceeds invoice balance/i.test(error.message || '');
    res.status(overpayment ? 409 : 400).json({ error: overpayment ? 'This payment exceeds the outstanding invoice balance.' : 'Could not record this payment.' }); return;
  }
  const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
  const { data: payments } = await supabase.from('invoice_payments').select('*').eq('invoice_id', invoiceId).order('received_at');
  await logQuoteEvent(supabase, { quoteId: invoice.quote_id, quoteVersionId: invoice.quote_version_id, eventType: 'invoice_payment_recorded', actorRole: 'admin', payload: { invoiceId, paymentId, amountCents: cleanAmount, method } });
  res.status(200).json({ ok: true, paymentId, invoice: serializeInvoice(invoice, { payments: payments || [] }) });
}
function getRequestIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || null;
}

async function logQuoteEvent(supabase, { quoteId, quoteVersionId, eventType, actorRole, actorId, payload }) {
  try {
    await supabase.from('quote_events').insert({
      quote_id: quoteId, quote_version_id: quoteVersionId || null, event_type: eventType,
      actor_role: actorRole, actor_id: actorId || null, payload: payload || {},
    });
  } catch (e) { console.error('quote_events insert error:', e); }
}

// Lazily flips an overdue 'issued' version (and its parent quote) to
// 'expired' the first time anyone touches it -- no cron needed for Stage 1.
async function expireIfOverdue(supabase, version, quote) {
  if (!version || version.status !== 'issued' || !version.expires_at) return { version, quote };
  if (new Date(version.expires_at) > new Date()) return { version, quote };
  const nowIso = new Date().toISOString();
  await supabase.from('quote_versions').update({ status: 'expired', updated_at: nowIso }).eq('id', version.id);
  await supabase.from('quotes').update({ current_status: 'expired', updated_at: nowIso }).eq('id', quote.id);
  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'expired', actorRole: 'system' });
  return { version: { ...version, status: 'expired' }, quote: { ...quote, current_status: 'expired' } };
}

// Shared token resolution for every public (non-admin) action -- rate
// limits by IP BEFORE the real lookup, logs every attempt (success or
// fail), and never lets a request pivot to a different document by
// guessing an id (the token hash is the only lookup key).
async function resolveToken(req, res, supabase) {
  const raw = (req.method === 'GET' ? (req.query || {}).token : (req.body || {}).token) || '';
  if (!raw) { res.status(400).json({ error: 'A valid link is required.' }); return null; }
  const ip = getRequestIp(req);

  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { count } = await supabase
    .from('document_access_attempts').select('id', { count: 'exact', head: true })
    .eq('ip', ip).gte('created_at', since);
  if ((count || 0) >= RATE_LIMIT_MAX_ATTEMPTS) {
    res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    return null;
  }

  const tokenHash = hashToken(raw);
  const { data: tokenRow } = await supabase
    .from('document_access_tokens').select('*')
    .eq('token_hash', tokenHash).eq('document_type', 'quote_version').maybeSingle();

  if (!tokenRow) {
    await supabase.from('document_access_attempts').insert({ ip, success: false });
    res.status(404).json({ error: 'This link is not valid.' }); return null;
  }
  if (tokenRow.revoked_at) {
    await supabase.from('document_access_attempts').insert({ ip, success: false });
    res.status(410).json({ error: 'This link has been revoked.' }); return null;
  }

  const { data: version } = await supabase.from('quote_versions').select('*').eq('id', tokenRow.document_id).maybeSingle();
  if (!version) {
    await supabase.from('document_access_attempts').insert({ ip, success: false });
    res.status(404).json({ error: 'This document could not be found.' }); return null;
  }
  const { data: quote } = await supabase.from('quotes').select('*').eq('id', version.quote_id).maybeSingle();
  if (!quote) { res.status(404).json({ error: 'This document could not be found.' }); return null; }
  const settled = await expireIfOverdue(supabase, version, quote);

  // Acceptance/decline settles the quote before its deadline. Keep that
  // document available as the customer's record after the original review
  // deadline instead of misreporting an accepted/declined quote as expired.
  const settledStatus = settled.version.status === 'accepted' || settled.version.status === 'declined';
  const valid = settledStatus || new Date(tokenRow.expires_at) > new Date();
  await supabase.from('document_access_attempts').insert({ ip, success: valid });
  if (!valid) { res.status(410).json({ error: 'This link has expired.' }); return null; }

  // This is audit metadata only: no consumed/revoked flag is set, so every
  // valid GET, refresh, browser and device can resolve the same token.
  await supabase.from('document_access_tokens').update({ last_accessed_at: new Date().toISOString() }).eq('id', tokenRow.id);

  return { version: settled.version, quote: settled.quote, ip };
}

// Customer-facing shape -- never leaks internal fields (assigned staff,
// created_by, raw customer/quote ids) into the public document response.
function serializePublic(quote, version, issuingEntity) {
  return {
    quoteNumber: quote.quote_number,
    status: quote.current_status,
    versionNumber: version.version_number,
    versionStatus: version.status,
    issuingEntity: issuingEntity ? {
      legalName: issuingEntity.legal_name, abn: issuingEntity.abn, tradingName: issuingEntity.trading_name,
      addressLine: issuingEntity.address_line, suburb: issuingEntity.suburb, state: issuingEntity.state,
      email: issuingEntity.email, phone: issuingEntity.phone,
    } : null,
    customer: version.customer_snapshot || {},
    property: version.property_snapshot || null,
    lineItems: version.line_items || [],
    subtotalExGstCents: version.subtotal_ex_gst_cents,
    gstCents: version.gst_cents,
    totalIncGstCents: version.total_inc_gst_cents,
    scopeText: version.scope_text,
    inclusionsText: version.inclusions_text,
    exclusionsText: version.exclusions_text,
    paymentTermsText: paymentTermsFromVersion(version),
    termsVersion: version.terms_version,
    termsText: getTermsText(version.terms_version),
    termsUrl: TERMS_URL,
    attachments: version.attachments || [],
    issuedAt: version.issued_at,
    expiresAt: version.expires_at,
    acceptedAt: version.accepted_at,
    declinedAt: version.declined_at,
  };
}

function serializeVersionAdmin(v) {
  return {
    id: v.id, versionNumber: v.version_number, status: v.status, issuingEntityId: v.issuing_entity_id,
    customerSnapshot: v.customer_snapshot, propertySnapshot: v.property_snapshot, lineItems: v.line_items,
    subtotalExGstCents: v.subtotal_ex_gst_cents, gstCents: v.gst_cents, totalIncGstCents: v.total_inc_gst_cents,
    scopeText: v.scope_text, inclusionsText: v.inclusions_text, exclusionsText: v.exclusions_text,
    paymentTermsText: paymentTermsFromVersion(v),
    termsVersion: v.terms_version, termsText: getTermsText(v.terms_version), termsUrl: TERMS_URL, attachments: v.attachments, validityDays: v.validity_days,
    issuedAt: v.issued_at, expiresAt: v.expires_at, supersededByVersionId: v.superseded_by_version_id,
    acceptedAt: v.accepted_at, acceptedByName: v.accepted_by_name, acceptedByEmail: v.accepted_by_email,
    declinedAt: v.declined_at, declinedReason: v.declined_reason, createdAt: v.created_at,
  };
}

function serializeQuoteAdmin(q, version, customer) {
  return {
    id: q.id, quoteNumber: q.quote_number, currentStatus: q.current_status,
    customerId: q.customer_id, customer: customer ? { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone } : null,
    jobId: q.job_id, assignedStaffId: q.assigned_staff_id, createdBy: q.created_by,
    createdAt: q.created_at, updatedAt: q.updated_at,
    currentVersion: version ? serializeVersionAdmin(version) : null,
  };
}

async function findOrCreateCustomer(supabase, { customerId, newCustomer }) {
  if (customerId) {
    const { data, error } = await supabase.from('customers').select('*').eq('id', customerId).maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('Customer not found.'), { statusCode: 404 });
    return data;
  }
  if (!newCustomer || !newCustomer.email) {
    throw Object.assign(new Error('customerId or newCustomer.email is required.'), { statusCode: 400 });
  }
  const email = String(newCustomer.email).trim().toLowerCase();
  // Prevent duplicate contacts by real email match only -- never
  // auto-merge different people just because they share a name/address.
  const { data: existing, error: findErr } = await supabase.from('customers').select('*').eq('email', email).maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing;
  // Staff can create a customer contact for quoting with no login/password
  // -- auth_user_id stays null until the customer later self-registers or
  // the existing invitation/self-heal login flow links this row up.
  const { data: created, error: createErr } = await supabase.from('customers')
    .insert({ email, name: newCustomer.name || null, phone: newCustomer.phone || null }).select().single();
  if (createErr) throw createErr;
  return created;
}

async function handleCreateDraft(req, res, supabase) {
  const body = req.body || {};
  let customer;
  try {
    customer = await findOrCreateCustomer(supabase, { customerId: body.customerId, newCustomer: body.newCustomer });
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message || 'Could not resolve customer.' });
    return;
  }
  const totals = computeQuoteTotals(body.lineItems);

  const { data: quote, error: quoteErr } = await supabase.from('quotes').insert({
    customer_id: customer.id, job_id: body.jobId || null, assigned_staff_id: body.assignedStaffId || null,
  }).select().single();
  if (quoteErr) throw quoteErr;

  const { data: version, error: versionErr } = await supabase.from('quote_versions').insert({
    quote_id: quote.id, version_number: 1, status: 'draft',
    customer_snapshot: { name: customer.name, email: customer.email, phone: customer.phone },
    ...quoteVersionContent(body, totals),
    terms_version: 'v1', validity_days: body.validityDays || 30,
  }).select().single();
  if (versionErr) throw versionErr;

  await supabase.from('quotes').update({ current_version_id: version.id }).eq('id', quote.id);
  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'draft_created', actorRole: 'admin' });

  res.status(200).json({ quote: serializeQuoteAdmin({ ...quote, current_version_id: version.id }, version, customer) });
}

async function handleUpdateDraft(req, res, supabase) {
  const body = req.body || {};
  if (!body.quoteId) { res.status(400).json({ error: 'quoteId is required.' }); return; }
  const { data: quote, error: qErr } = await supabase.from('quotes').select('*').eq('id', body.quoteId).maybeSingle();
  if (qErr) throw qErr;
  if (!quote) { res.status(404).json({ error: 'Quote not found.' }); return; }
  const { data: version, error: vErr } = await supabase.from('quote_versions').select('*').eq('id', quote.current_version_id).maybeSingle();
  if (vErr) throw vErr;
  if (version && version.status !== 'draft') {
    res.status(409).json({ error: "Only a draft version can be edited -- use 'revise' to create a new version." });
    return;
  }
  const totals = computeQuoteTotals(body.lineItems);
  const { data: updated, error: updErr } = await supabase.from('quote_versions').update({
    ...quoteVersionContent(body, totals, version),
    updated_at: new Date().toISOString(),
  }).eq('id', version.id).select().single();
  if (updErr) throw updErr;
  if (body.assignedStaffId !== undefined) {
    await supabase.from('quotes').update({ assigned_staff_id: body.assignedStaffId, updated_at: new Date().toISOString() }).eq('id', quote.id);
  }
  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'draft_updated', actorRole: 'admin' });
  res.status(200).json({ quote: serializeQuoteAdmin(quote, updated, null) });
}

async function handleIssue(req, res, supabase) {
  const { quoteId } = req.body || {};
  if (!quoteId) { res.status(400).json({ error: 'quoteId is required.' }); return; }
  const { data: quote, error: qErr } = await supabase.from('quotes').select('*').eq('id', quoteId).maybeSingle();
  if (qErr) throw qErr;
  if (!quote) { res.status(404).json({ error: 'Quote not found.' }); return; }
  const { data: version, error: vErr } = await supabase.from('quote_versions').select('*').eq('id', quote.current_version_id).maybeSingle();
  if (vErr) throw vErr;
  if (!version || version.status !== 'draft') { res.status(409).json({ error: 'Only a draft version can be issued.' }); return; }
  if (!version.line_items || version.line_items.length === 0) { res.status(400).json({ error: 'Add at least one line item before issuing.' }); return; }

  const { data: entity, error: entErr } = await supabase.from('issuing_entities').select('*').eq('is_active', true).limit(1).maybeSingle();
  if (entErr) throw entErr;
  if (!entity) { res.status(400).json({ error: 'No issuing entity is configured -- cannot issue this document yet.' }); return; }

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (version.validity_days || 30) * 24 * 60 * 60 * 1000).toISOString();
  const { data: updated, error: updErr } = await supabase.from('quote_versions').update({
    status: 'issued', issuing_entity_id: entity.id, issued_at: nowIso, expires_at: expiresAt, updated_at: nowIso,
  }).eq('id', version.id).select().single();
  if (updErr) throw updErr;
  await supabase.from('quotes').update({ current_status: 'sent', updated_at: nowIso }).eq('id', quote.id);

  const rawToken = generateToken();
  await supabase.from('document_access_tokens').insert({
    document_type: 'quote_version', document_id: version.id, token_hash: hashToken(rawToken), expires_at: expiresAt,
  });
  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'issued', actorRole: 'admin' });

  res.status(200).json({
    quote: serializeQuoteAdmin({ ...quote, current_status: 'sent' }, updated, null),
    token: rawToken, url: `${quoteBaseUrl()}?token=${encodeURIComponent(rawToken)}`,
  });
}

async function handleRevise(req, res, supabase) {
  const { quoteId } = req.body || {};
  if (!quoteId) { res.status(400).json({ error: 'quoteId is required.' }); return; }
  const { data: quote, error: qErr } = await supabase.from('quotes').select('*').eq('id', quoteId).maybeSingle();
  if (qErr) throw qErr;
  if (!quote) { res.status(404).json({ error: 'Quote not found.' }); return; }
  if (quote.current_status !== 'sent') { res.status(409).json({ error: 'Only a sent quote can be revised.' }); return; }
  const { data: current, error: cErr } = await supabase.from('quote_versions').select('*').eq('id', quote.current_version_id).maybeSingle();
  if (cErr) throw cErr;
  if (!current) { res.status(404).json({ error: 'Current version not found.' }); return; }

  const { data: newVersion, error: nvErr } = await supabase.from('quote_versions').insert({
    quote_id: quote.id, version_number: current.version_number + 1, status: 'draft',
    customer_snapshot: current.customer_snapshot, property_snapshot: current.property_snapshot,
    line_items: current.line_items, subtotal_ex_gst_cents: current.subtotal_ex_gst_cents,
    gst_cents: current.gst_cents, total_inc_gst_cents: current.total_inc_gst_cents,
    scope_text: current.scope_text, inclusions_text: current.inclusions_text, exclusions_text: current.exclusions_text,
    payment_schedule_note: current.payment_schedule_note || null, terms_version: current.terms_version,
    validity_days: current.validity_days,
  }).select().single();
  if (nvErr) throw nvErr;

  await supabase.from('quote_versions').update({ status: 'superseded', superseded_by_version_id: newVersion.id, updated_at: new Date().toISOString() }).eq('id', current.id);
  await supabase.from('quotes').update({ current_version_id: newVersion.id, current_status: 'draft', updated_at: new Date().toISOString() }).eq('id', quote.id);
  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: newVersion.id, eventType: 'revised', actorRole: 'admin', payload: { previousVersionId: current.id } });

  res.status(200).json({ quote: serializeQuoteAdmin({ ...quote, current_status: 'draft', current_version_id: newVersion.id }, newVersion, null) });
}

async function handleWithdraw(req, res, supabase) {
  const { quoteId } = req.body || {};
  if (!quoteId) { res.status(400).json({ error: 'quoteId is required.' }); return; }
  const { data: quote, error: qErr } = await supabase.from('quotes').select('*').eq('id', quoteId).maybeSingle();
  if (qErr) throw qErr;
  if (!quote) { res.status(404).json({ error: 'Quote not found.' }); return; }
  if (quote.current_status !== 'sent') { res.status(409).json({ error: 'Only a sent quote can be withdrawn.' }); return; }
  const nowIso = new Date().toISOString();
  await supabase.from('quote_versions').update({ status: 'withdrawn', updated_at: nowIso }).eq('id', quote.current_version_id);
  await supabase.from('quotes').update({ current_status: 'withdrawn', updated_at: nowIso }).eq('id', quote.id);
  await supabase.from('document_access_tokens').update({ revoked_at: nowIso })
    .eq('document_type', 'quote_version').eq('document_id', quote.current_version_id).is('revoked_at', null);
  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: quote.current_version_id, eventType: 'withdrawn', actorRole: 'admin' });
  res.status(200).json({ ok: true });
}

async function handleCancelQuote(req, res, supabase) {
  const { quoteId } = req.body || {};
  if (!quoteId) { res.status(400).json({ error: 'quoteId is required.' }); return; }
  const { data: quote, error: qErr } = await supabase.from('quotes').select('*').eq('id', quoteId).maybeSingle();
  if (qErr) throw qErr;
  if (!quote) { res.status(404).json({ error: 'Quote not found.' }); return; }
  if (!['draft', 'sent'].includes(quote.current_status)) {
    res.status(409).json({ error: 'Only draft or sent quotes can be cancelled. Archive completed or accepted quotes instead.' });
    return;
  }
  const nowIso = new Date().toISOString();
  await supabase.from('quote_versions').update({ status: 'withdrawn', updated_at: nowIso }).eq('id', quote.current_version_id);
  await supabase.from('quotes').update({ current_status: 'withdrawn', updated_at: nowIso }).eq('id', quote.id);
  await supabase.from('document_access_tokens').update({ revoked_at: nowIso })
    .eq('document_type', 'quote_version').eq('document_id', quote.current_version_id).is('revoked_at', null);
  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: quote.current_version_id, eventType: 'cancelled', actorRole: 'admin' });
  res.status(200).json({ ok: true });
}

async function handleQuoteArchive(req, res, supabase, archived) {
  const { quoteId } = req.body || {};
  if (!quoteId) { res.status(400).json({ error: 'quoteId is required.' }); return; }
  const { data: quote, error: qErr } = await supabase.from('quotes').select('id,current_version_id').eq('id', quoteId).maybeSingle();
  if (qErr) throw qErr;
  if (!quote) { res.status(404).json({ error: 'Quote not found.' }); return; }
  await logQuoteEvent(supabase, {
    quoteId: quote.id,
    quoteVersionId: quote.current_version_id,
    eventType: archived ? 'archived' : 'unarchived',
    actorRole: 'admin',
  });
  res.status(200).json({ ok: true, archived });
}

async function handleRemoveDraftQuote(req, res, supabase) {
  const { quoteId } = req.body || {};
  if (!quoteId) { res.status(400).json({ error: 'quoteId is required.' }); return; }
  const { data: quote, error: qErr } = await supabase.from('quotes').select('*').eq('id', quoteId).maybeSingle();
  if (qErr) throw qErr;
  if (!quote) { res.status(404).json({ error: 'Quote not found.' }); return; }
  if (quote.current_status !== 'draft' || quote.job_id) {
    res.status(409).json({ error: 'Only an unissued draft quote can be removed.' }); return;
  }
  const { data: version, error: vErr } = await supabase.from('quote_versions').select('id,status').eq('id', quote.current_version_id).maybeSingle();
  if (vErr) throw vErr;
  if (!version || version.status !== 'draft') {
    res.status(409).json({ error: 'Only an unissued draft quote can be removed.' }); return;
  }
  const { data: invoices, error: invoiceErr } = await supabase.from('invoices').select('id').eq('quote_id', quote.id).limit(1);
  if (invoiceErr) throw invoiceErr;
  if ((invoices || []).length) {
    res.status(409).json({ error: 'A quote linked to an invoice cannot be removed.' }); return;
  }
  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version && version.id, eventType: 'draft_removed', actorRole: 'admin' });
  res.status(200).json({ ok: true });
}

// Email the quote directly (Sep 2026, founder feedback: generating a link
// to copy/forward manually was an extra, unnecessary step). Always issues
// a FRESH token when (re)sending -- revokes whatever was active first, so
// there is only ever one live link per version. This also means a resend
// naturally works with no special-case code: this same action can be
// called again later (e.g. "the customer says they never got it") and it
// just generates and sends a new link. The raw token is never recoverable
// once this response finishes (only its hash is persisted), so re-sending
// the "same" link is never actually possible anyway -- a fresh one every
// time is simplest, not just secure.
async function handleSendQuoteEmail(req, res, supabase) {
  const { quoteId, recipientEmail } = req.body || {};
  if (!quoteId) { res.status(400).json({ error: 'quoteId is required.' }); return; }
  const { data: quote, error: qErr } = await supabase.from('quotes').select('*').eq('id', quoteId).maybeSingle();
  if (qErr) throw qErr;
  if (!quote) { res.status(404).json({ error: 'Quote not found.' }); return; }
  const { data: version, error: vErr } = await supabase.from('quote_versions').select('*').eq('id', quote.current_version_id).maybeSingle();
  if (vErr) throw vErr;
  if (!version || version.status !== 'issued') { res.status(409).json({ error: 'This quote must be issued before it can be emailed.' }); return; }
  const requestedEmail = String(recipientEmail || '').trim().toLowerCase();
  if (requestedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestedEmail)) {
    res.status(400).json({ error: 'Enter a valid customer email address.' }); return;
  }
  const customerEmail = requestedEmail || (version.customer_snapshot && version.customer_snapshot.email) || null;
  if (!customerEmail) { res.status(400).json({ error: 'This quote has no customer email on file.' }); return; }

  const nowIso = new Date().toISOString();
  const { error: revokeError } = await supabase.from('document_access_tokens').update({ revoked_at: nowIso })
    .eq('document_type', 'quote_version').eq('document_id', version.id).is('revoked_at', null);
  if (revokeError) {
    console.error('quote email token revoke failed:', { code: revokeError.code || 'unknown' });
    res.status(500).json({ error: 'Could not prepare the secure quote link. No email was sent.' });
    return;
  }
  const rawToken = generateToken();
  const { error: tokenError } = await supabase.from('document_access_tokens').insert({
    document_type: 'quote_version', document_id: version.id, token_hash: hashToken(rawToken), expires_at: version.expires_at,
  });
  if (tokenError) {
    console.error('quote email token creation failed:', { code: tokenError.code || 'unknown' });
    res.status(500).json({ error: 'Could not prepare the secure quote link. No email was sent.' });
    return;
  }
  const url = `${quoteBaseUrl()}?token=${encodeURIComponent(rawToken)}`;

  const { recommendations, sourceCategory } = await loadRecommendations(supabase, version);
  let pdf;
  try {
    pdf = await generateQuotePdf({ quote, version: { ...version, terms_text: getTermsText(version.terms_version) } });
  } catch (pdfError) {
    console.error('quote PDF generation failed:', { message: pdfError && pdfError.message ? pdfError.message : 'unknown' });
    res.status(500).json({ error: 'Could not create the quote PDF. No email was sent.', url });
    return;
  }
  const emailResult = await sendEmailWithResult({
    to: customerEmail,
    // One Resend delivery with an internal BCC gives Accounts the exact
    // customer email and secure link without exposing the internal address
    // or accidentally sending the customer a duplicate message.
    bcc: 'accounts@mysubbies.com.au',
    subject: `Your Mysubbies quote is ready (Quote #${quote.quote_number})`,
    html: renderQuoteEmail({ quote, version, secureQuoteUrl: url, recommendations, sourceCategory }),
    attachments: [{ filename: `mysubbies-quote-${quote.quote_number}-v${version.version_number}.pdf`, content: pdf.toString('base64') }],
  });

  // Unlike every other notification in this codebase (deliberately fire-
  // and-forget so a broken email never blocks a booking/payment), this
  // action's whole point is telling the customer their quote exists -- a
  // silent failure here is worse than a blocked click, so a real send
  // failure is surfaced back to the admin instead of swallowed. The token
  // is already generated and valid either way, so the link is still
  // returned for manual sharing even when the email itself failed.
  if (!emailResult.ok) {
    await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'email_failed', actorRole: 'system', payload: { to: customerEmail, error: emailResult.error } });
    res.status(502).json({ error: emailResult.error || 'Could not send the email.', url });
    return;
  }

  await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'emailed', actorRole: 'admin', payload: { to: customerEmail } });
  res.status(200).json({ ok: true, url, sentTo: customerEmail });
}

// AI-assisted drafting (Sep 2026) -- admin types a few short notes per
// field, this expands them into full professional text using the same
// Anthropic integration already proven in api/classify-job.js. Never
// auto-saves or auto-issues: the returned text always lands back in the
// builder's own editable textareas for the admin to review/edit before
// Save Draft, same human-in-the-loop posture as every other AI feature in
// this codebase (Fix Something always shows its guess for confirmation,
// never books blind). Explicitly told not to invent scope, prices,
// timeframes or warranty claims beyond what the line items/admin notes
// already establish.
async function handleAiDraftText(req, res) {
  const anthropic = getAnthropicClient();
  if (!anthropic) { res.status(400).json({ error: 'AI drafting is not turned on for this account yet (ANTHROPIC_API_KEY not set in Vercel).' }); return; }
  const { lineItems, scopeBrief, inclusionsBrief, exclusionsBrief } = req.body || {};
  const itemsList = (Array.isArray(lineItems) ? lineItems : [])
    .filter(li => li && li.description)
    .map(li => `- ${li.description} (${li.qty || 1}${li.unit ? ' ' + li.unit : ''} @ $${((li.unitPriceCents || 0) / 100).toFixed(2)})`)
    .join('\n') || '(no line items yet)';

  const prompt = `You are drafting professional, plain-English sections for a home-services trade quote issued by Mysubbies, an Australian (Melbourne) trades marketplace.

Line items on this quote:
${itemsList}

The admin has given these short notes to expand into full, professional, customer-ready text. Expand short/bullet notes into clear complete sentences, but do NOT invent new work, materials, prices, timeframes, warranties or guarantees beyond what is stated here or directly implied by the line items above.

Scope notes: "${scopeBrief || '(none given -- write a short scope paragraph based only on the line items above)'}"
Inclusions notes: "${inclusionsBrief || '(none given -- infer only safe, generic inclusions directly implied by the line items, e.g. removal of packaging from an itemised material -- do not invent extras; leave blank if nothing is safely inferable)'}"
Exclusions notes: "${exclusionsBrief || '(none given -- leave blank unless something is clearly implied as out of scope)'}"

Respond with ONLY a JSON object (no other text) in this exact shape:
{ "scopeText": "...", "inclusionsText": "...", "exclusionsText": "..." }
Keep each under 120 words, professional and factual, no marketing language, no invented pricing/warranty/timeframe claims. Return an empty string for any section with nothing genuine to say.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = message.content.find(b => b.type === 'text')?.text || '{}';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  res.status(200).json({
    scopeText: typeof parsed.scopeText === 'string' ? parsed.scopeText : '',
    inclusionsText: typeof parsed.inclusionsText === 'string' ? parsed.inclusionsText : '',
    exclusionsText: typeof parsed.exclusionsText === 'string' ? parsed.exclusionsText : '',
  });
}

module.exports = async (req, res) => {
  const supabase = getSupabase();

  try {
    if (req.method === 'GET') {
      const { action, token, invoiceToken } = req.query || {};

      if (invoiceToken) {
        res.setHeader('Cache-Control', 'private, no-store');
        const resolvedInvoice = await resolveInvoiceToken(req, res, supabase);
        if (!resolvedInvoice) return;
        const { invoice, entity, quote, payments } = resolvedInvoice;
        res.status(200).json({
          invoice: serializeInvoice(invoice, { publicView: true, payments }), quoteNumber: quote && quote.quote_number,
          issuingEntity: entity ? { legalName: entity.legal_name, abn: entity.abn, tradingName: entity.trading_name, addressLine: entity.address_line, suburb: entity.suburb, state: entity.state, postcode: entity.postcode, email: entity.email, phone: entity.phone } : null,
        });
        return;
      }

      if (token) {
        // Private financial document -- must never be cached by a shared
        // cache/CDN or served to a second viewer from that cache.
        res.setHeader('Cache-Control', 'private, no-store');
        const resolved = await resolveToken(req, res, supabase);
        if (!resolved) return;
        const { version, quote } = resolved;
        const entity = version.issuing_entity_id
          ? (await supabase.from('issuing_entities').select('*').eq('id', version.issuing_entity_id).maybeSingle()).data
          : null;
        // Cross-sell is optional enrichment only. A missing/outdated rate card
        // must never prevent the secure quote itself from rendering.
        const { recommendations } = await loadRecommendations(supabase, version);
        await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'viewed', actorRole: 'customer' });
        res.status(200).json({ ...serializePublic(quote, version, entity), recommendations });
        return;
      }

      if (action === 'list_staff') {
        if (!requireAdmin(req, res)) return;
        const { data, error } = await supabase.from('staff_members').select('*').order('name');
        if (error) throw error;
        res.status(200).json({ staff: (data || []).map(s => ({ id: s.id, name: s.name, email: s.email, active: s.active })) });
        return;
      }

      if (action === 'list_invoices') {
        if (!requireAdmin(req, res)) return;
        const { data: invoiceRows, error: invoiceError } = await supabase.from('invoices').select('*').order('created_at', { ascending: false }).limit(300);
        if (invoiceError) throw invoiceError;
        const invoiceIds = (invoiceRows || []).map(row => row.id);
        const quoteIds = [...new Set((invoiceRows || []).map(row => row.quote_id).filter(Boolean))];
        const [{ data: payments, error: paymentError }, { data: quotes, error: quoteError }] = await Promise.all([
          invoiceIds.length ? supabase.from('invoice_payments').select('*').in('invoice_id', invoiceIds).order('received_at') : Promise.resolve({ data: [] }),
          quoteIds.length ? supabase.from('quotes').select('id,quote_number').in('id', quoteIds) : Promise.resolve({ data: [] }),
        ]);
        if (paymentError) throw paymentError;
        if (quoteError) throw quoteError;
        const paymentsByInvoice = new Map();
        for (const payment of payments || []) {
          if (!paymentsByInvoice.has(payment.invoice_id)) paymentsByInvoice.set(payment.invoice_id, []);
          paymentsByInvoice.get(payment.invoice_id).push(payment);
        }
        const quoteNumberById = new Map((quotes || []).map(quote => [quote.id, quote.quote_number]));
        res.status(200).json({
          invoices: (invoiceRows || []).map(row => ({
            ...serializeInvoice(row, { payments: paymentsByInvoice.get(row.id) || [] }),
            quoteNumber: quoteNumberById.get(row.quote_id) || null,
          })),
        });
        return;
      }

      if (action === 'get') {
        if (!requireAdmin(req, res)) return;
        const { id } = req.query || {};
        if (!id) { res.status(400).json({ error: 'id is required.' }); return; }
        const { data: quote, error: qErr } = await supabase.from('quotes').select('*').eq('id', id).maybeSingle();
        if (qErr) throw qErr;
        if (!quote) { res.status(404).json({ error: 'Quote not found.' }); return; }
        const { data: versions, error: vErr } = await supabase.from('quote_versions').select('*').eq('quote_id', id).order('version_number');
        if (vErr) throw vErr;
        const { data: events, error: eErr } = await supabase.from('quote_events').select('*').eq('quote_id', id).order('created_at');
        if (eErr) throw eErr;
        const { data: customer } = await supabase.from('customers').select('*').eq('id', quote.customer_id).maybeSingle();
        const current = (versions || []).find(v => v.id === quote.current_version_id) || null;
        const { data: invoices } = await supabase.from('invoices').select('*').eq('quote_id', id).order('created_at');
        const invoiceIds = (invoices || []).map(row => row.id);
        const { data: invoicePayments } = invoiceIds.length
          ? await supabase.from('invoice_payments').select('*').in('invoice_id', invoiceIds).order('received_at')
          : { data: [] };
        const paymentsByInvoice = new Map();
        (invoicePayments || []).forEach(payment => {
          if (!paymentsByInvoice.has(payment.invoice_id)) paymentsByInvoice.set(payment.invoice_id, []);
          paymentsByInvoice.get(payment.invoice_id).push(payment);
        });
        if ((events || []).some(ev => ev.event_type === 'draft_removed')) {
          res.status(404).json({ error: 'This draft quote has been removed.' }); return;
        }
        const latestArchiveEvent = (events || []).slice().reverse().find(ev => ['archived', 'unarchived'].includes(ev.event_type));
        const wasCancelled = (events || []).some(ev => ev.event_type === 'cancelled');
        res.status(200).json({
          quote: {
            ...serializeQuoteAdmin(quote, current, customer),
            currentStatus: wasCancelled ? 'cancelled' : quote.current_status,
            archived: latestArchiveEvent ? latestArchiveEvent.event_type === 'archived' : false,
          },
          versions: (versions || []).map(serializeVersionAdmin),
          events: (events || []).map(ev => ({ id: ev.id, eventType: ev.event_type, actorRole: ev.actor_role, actorId: ev.actor_id, payload: ev.payload, createdAt: ev.created_at })),
          invoices: (invoices || []).map(row => serializeInvoice(row, { payments: paymentsByInvoice.get(row.id) || [] })),
          invoiceMilestoneOptions: current ? milestoneOptions(paymentTermsFromVersion(current), current.total_inc_gst_cents) : [],
        });
        return;
      }

      // default: list
      if (!requireAdmin(req, res)) return;
      const { customerId, status, archived } = req.query || {};
      let q = supabase.from('quotes').select('*').order('created_at', { ascending: false }).limit(200);
      if (customerId) q = q.eq('customer_id', customerId);
      if (status) q = q.eq('current_status', status);
      const { data: quoteRows, error } = await q;
      if (error) throw error;
      const versionIds = (quoteRows || []).map(r => r.current_version_id).filter(Boolean);
      const customerIds = [...new Set((quoteRows || []).map(r => r.customer_id))];
      const [{ data: versions }, { data: customers }] = await Promise.all([
        versionIds.length ? supabase.from('quote_versions').select('*').in('id', versionIds) : Promise.resolve({ data: [] }),
        customerIds.length ? supabase.from('customers').select('*').in('id', customerIds) : Promise.resolve({ data: [] }),
      ]);
      const versionById = new Map((versions || []).map(v => [v.id, v]));
      const customerById = new Map((customers || []).map(c => [c.id, c]));
      const quoteIds = (quoteRows || []).map(row => row.id);
      const [{ data: recentEvents }, { data: openQuestions }] = quoteIds.length ? await Promise.all([
        supabase.from('quote_events').select('quote_id, event_type, created_at').in('quote_id', quoteIds).order('created_at', { ascending: false }),
        supabase.from('inquiries').select('quote_id').in('quote_id', quoteIds).eq('status', 'open'),
      ]) : [{ data: [] }, { data: [] }];
      const activityByQuote = new Map();
      const archiveStateByQuote = new Map();
      const cancelledQuoteIds = new Set();
      const removedDraftIds = new Set();
      for (const event of recentEvents || []) {
        const activity = activityByQuote.get(event.quote_id) || { questionCount: 0, lastActivityAt: null };
        if (!activity.lastActivityAt) activity.lastActivityAt = event.created_at;
        activityByQuote.set(event.quote_id, activity);
        if (event.event_type === 'cancelled') cancelledQuoteIds.add(event.quote_id);
        if (event.event_type === 'draft_removed') removedDraftIds.add(event.quote_id);
        if (!archiveStateByQuote.has(event.quote_id) && ['archived', 'unarchived'].includes(event.event_type)) {
          archiveStateByQuote.set(event.quote_id, event.event_type === 'archived');
        }
      }
      for (const inquiry of openQuestions || []) {
        const activity = activityByQuote.get(inquiry.quote_id) || { questionCount: 0, lastActivityAt: null };
        activity.questionCount++;
        activityByQuote.set(inquiry.quote_id, activity);
      }
      const showArchived = archived === 'true';
      const visibleQuotes = (quoteRows || []).filter(row => !removedDraftIds.has(row.id) && (archiveStateByQuote.get(row.id) === true) === showArchived);
      res.status(200).json({
        quotes: visibleQuotes.map(q2 => ({
          ...serializeQuoteAdmin(q2, versionById.get(q2.current_version_id) || null, customerById.get(q2.customer_id) || null),
          currentStatus: cancelledQuoteIds.has(q2.id) ? 'cancelled' : q2.current_status,
          archived: archiveStateByQuote.get(q2.id) === true,
          ...(activityByQuote.get(q2.id) || { questionCount: 0, lastActivityAt: q2.updated_at }),
        })),
      });
      return;
    }

    if (req.method === 'POST') {
      const { action } = req.body || {};

      // Public, token-gated actions.
      if (action === 'accept' || action === 'decline' || action === 'ask_question') {
        const resolved = await resolveToken(req, res, supabase);
        if (!resolved) return;
        const { version, quote, ip } = resolved;
        const body = req.body || {};

        if (action === 'ask_question') {
          const { name, email, question } = body;
          if (!email || !question) { res.status(400).json({ error: 'email and question are required.' }); return; }
          const { data: inquiry, error: iErr } = await supabase.from('inquiries').insert({
            role: 'customer', name: name || null, email,
            messages: [{ from: 'customer', text: question, attachments: [], createdAt: new Date().toISOString() }],
            quote_id: quote.id,
          }).select().single();
          if (iErr) throw iErr;
          await notifyAdmin({
            eventType: 'quote-question', title: `Question about Quote #${quote.quote_number}`,
            body: `${name ? name + ' (' + email + ')' : email} asked: "${String(question).slice(0, 300)}"`,
          });
          await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'question_asked', actorRole: 'customer', payload: { inquiryId: inquiry.id } });
          res.status(200).json({ ok: true });
          return;
        }

        if (version.status !== 'issued') {
          res.status(409).json({ error: 'This quote can no longer be accepted or declined -- it may have been revised, withdrawn or already actioned.' });
          return;
        }

        const nowIso = new Date().toISOString();
        if (action === 'accept') {
          const { name, email, consent } = body;
          if (!name || !email || consent !== true) { res.status(400).json({ error: 'Name, email and consent are required to accept.' }); return; }
          await supabase.from('quote_versions').update({
            status: 'accepted', accepted_at: nowIso, accepted_by_name: name, accepted_by_email: email,
            accepted_ip: ip, accepted_user_agent: req.headers['user-agent'] || null, updated_at: nowIso,
          }).eq('id', version.id);
          await supabase.from('quotes').update({ current_status: 'accepted', updated_at: nowIso }).eq('id', quote.id);
          await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'accepted', actorRole: 'customer', payload: { name, email } });
        } else {
          const { reason } = body;
          await supabase.from('quote_versions').update({ status: 'declined', declined_at: nowIso, declined_reason: reason || null, updated_at: nowIso }).eq('id', version.id);
          await supabase.from('quotes').update({ current_status: 'declined', updated_at: nowIso }).eq('id', quote.id);
          await logQuoteEvent(supabase, { quoteId: quote.id, quoteVersionId: version.id, eventType: 'declined', actorRole: 'customer', payload: { reason: reason || null } });
        }
        res.status(200).json({ ok: true, status: action === 'accept' ? 'accepted' : 'declined' });
        return;
      }

      // Everything else is admin-only.
      if (!requireAdmin(req, res)) return;

      if (action === 'create_draft') { await handleCreateDraft(req, res, supabase); return; }
      if (action === 'update_draft') { await handleUpdateDraft(req, res, supabase); return; }
      if (action === 'issue') { await handleIssue(req, res, supabase); return; }
      if (action === 'revise') { await handleRevise(req, res, supabase); return; }
      if (action === 'withdraw') { await handleWithdraw(req, res, supabase); return; }
      if (action === 'cancel_quote') { await handleCancelQuote(req, res, supabase); return; }
      if (action === 'archive_quote') { await handleQuoteArchive(req, res, supabase, true); return; }
      if (action === 'unarchive_quote') { await handleQuoteArchive(req, res, supabase, false); return; }
      if (action === 'remove_draft_quote') { await handleRemoveDraftQuote(req, res, supabase); return; }
      if (action === 'send_quote_email') { await handleSendQuoteEmail(req, res, supabase); return; }
      if (action === 'create_invoice') { await handleCreateInvoice(req, res, supabase); return; }
      if (action === 'send_invoice') { await handleSendInvoice(req, res, supabase); return; }
      if (action === 'record_invoice_payment') { await handleRecordInvoicePayment(req, res, supabase); return; }
      if (action === 'push_to_portal') {
        try {
          const converted = await convertAcceptedQuoteToJob(supabase, (req.body || {}).quoteId);
          await logQuoteEvent(supabase, { quoteId: converted.quote.id, quoteVersionId: converted.quote.current_version_id,
            eventType: converted.alreadyConverted ? 'portal_push_retried' : 'pushed_to_portal', actorRole: 'admin',
            payload: { jobId: converted.job && converted.job.id } });
          res.status(200).json({ ok: true, jobId: converted.job && converted.job.id, alreadyConverted: converted.alreadyConverted });
        } catch (conversionError) {
          if (conversionError instanceof QuoteConversionError) {
            res.status(conversionError.statusCode).json({ error: conversionError.message }); return;
          }
          throw conversionError;
        }
        return;
      }
      if (action === 'ai_draft_text') { await handleAiDraftText(req, res); return; }

      if (action === 'create_staff') {
        const { name, email } = req.body || {};
        if (!name) { res.status(400).json({ error: 'name is required.' }); return; }
        const { data, error } = await supabase.from('staff_members').insert({ name, email: email || null }).select().single();
        if (error) throw error;
        res.status(200).json({ staff: { id: data.id, name: data.name, email: data.email, active: data.active } });
        return;
      }
      if (action === 'update_staff') {
        const { id, name, email, active } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id is required.' }); return; }
        const update = {};
        if (name !== undefined) update.name = name;
        if (email !== undefined) update.email = email;
        if (active !== undefined) update.active = active;
        const { data, error } = await supabase.from('staff_members').update(update).eq('id', id).select().single();
        if (error) throw error;
        res.status(200).json({ staff: { id: data.id, name: data.name, email: data.email, active: data.active } });
        return;
      }

      res.status(400).json({ error: 'Unknown action.' });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('quotes error:', err);
    res.status(500).json({ error: 'Could not process this request.' });
  }
};
