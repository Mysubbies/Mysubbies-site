// MySubbies Property & Facilities Management MVP.
// One serverless surface keeps the Hobby-plan function footprint small.
// All commercial data access is identity-bound server-side or protected by the
// existing MFA-backed admin session cookie.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin, verifyAdminAuth } = require('./_lib/adminAuth');
const { authenticatedUser, requirePropertyMember } = require('./_lib/propertyManagementAuth');
const { requireApprovedContractor } = require('./_lib/userAuth');
const { storeAttachments, signFiles } = require('./_lib/propertyWorkOrderFiles');
const { loadCategories, estimateLine } = require('./_lib/serviceCatalog');
const { notifyAdmin, notifyContractor } = require('./_lib/contractorNotifications');

function text(value, max) {
  const clean = String(value || '').trim();
  return max ? clean.slice(0, max) : clean;
}
function validEmail(value) {
  const v = text(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
}
function cents(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 1000000000 ? n : null;
}
function safeDate(value) {
  const v = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function priority(value) {
  return ['low','normal','urgent','emergency'].includes(value) ? value : 'normal';
}
function recurrence(value) {
  const v = text(value, 100);
  return v && /^(weekly|fortnightly|monthly|quarterly|biannual|annual)$/i.test(v) ? v.toLowerCase() : null;
}
async function event(supabase, workOrderId, actorType, actorId, eventType, detail) {
  const { error } = await supabase.from('pm_work_order_events').insert({
    work_order_id: workOrderId, actor_type: actorType, actor_id: actorId || null,
    event_type: eventType, detail: detail || {},
  });
  if (error) console.error('pm event insert failed:', { workOrderId, eventType });
}
async function memberWorkOrder(supabase, organisationId, workOrderId) {
  const { data, error } = await supabase.from('pm_work_orders').select('*')
    .eq('id', workOrderId).eq('organisation_id', organisationId).maybeSingle();
  if (error) throw error;
  return data;
}
async function propertyForOrg(supabase, organisationId, propertyId) {
  const { data, error } = await supabase.from('pm_properties').select('*')
    .eq('id', propertyId).eq('organisation_id', organisationId).eq('active', true).maybeSingle();
  if (error) throw error;
  return data;
}
async function signedFilesForOrders(supabase, ids) {
  if (!ids.length) return {};
  const { data, error } = await supabase.from('pm_work_order_files').select('*').in('work_order_id', ids).order('created_at', { ascending: true });
  if (error) throw error;
  const grouped = {};
  for (const row of (data || [])) {
    if (!grouped[row.work_order_id]) grouped[row.work_order_id] = [];
    grouped[row.work_order_id].push(row);
  }
  for (const id of Object.keys(grouped)) grouped[id] = await signFiles(supabase, grouped[id]);
  return grouped;
}
async function linkedJobMap(supabase, jobIds) {
  if (!jobIds.length) return {};
  const { data, error } = await supabase.from('jobs')
    .select('id, job_number, category, suburb, status, stage, contractor_email, full_record, updated_at')
    .in('id', jobIds);
  if (error) throw error;
  return Object.fromEntries((data || []).map(j => [j.id, j]));
}
function safeMemberOrder(order, property, job, files, events) {
  const fr = (job && job.full_record) || {};
  return {
    id: order.id,
    propertyId: order.property_id,
    property: property ? { id: property.id, name: property.name, address: property.address, suburb: property.suburb, state: property.state, postcode: property.postcode } : null,
    serviceMode: order.service_mode,
    category: order.category,
    taskSummary: order.task_summary,
    description: order.description,
    priority: order.priority,
    requestedCompletionDate: order.requested_completion_date,
    recurring: order.recurring,
    recurrenceRule: order.recurrence_rule,
    approvalRequired: order.approval_required,
    approvalStatus: order.approval_status,
    status: order.status,
    quotedPriceCents: order.quoted_price_cents,
    quoteReference: order.quote_reference,
    contractorStatus: fr.operationalStage || order.contractor_status || (job ? job.stage : null),
    contractorEta: order.contractor_eta,
    completionNotes: order.completion_notes,
    completedAt: order.completed_at,
    invoiceReference: order.invoice_reference,
    invoiceStatus: order.invoice_status,
    invoiceAmountCents: order.invoice_amount_cents,
    jobNumber: job ? job.job_number : null,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    files: files || [],
    events: events || [],
  };
}
async function bootstrap(supabase, req, res) {
  const auth = await requirePropertyMember(supabase, req);
  if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }

  const [{ data: properties, error: propertiesError }, { data: orders, error: ordersError }] = await Promise.all([
    supabase.from('pm_properties').select('*').eq('organisation_id', auth.organisation.id).eq('active', true).order('address'),
    supabase.from('pm_work_orders').select('*').eq('organisation_id', auth.organisation.id).order('created_at', { ascending: false }).limit(1000),
  ]);
  if (propertiesError) throw propertiesError;
  if (ordersError) throw ordersError;

  const orderRows = orders || [];
  const orderIds = orderRows.map(o => o.id);
  const jobIds = orderRows.map(o => o.job_id).filter(Boolean);
  const [fileMap, jobMap, eventResult] = await Promise.all([
    signedFilesForOrders(supabase, orderIds),
    linkedJobMap(supabase, jobIds),
    orderIds.length
      ? supabase.from('pm_work_order_events').select('work_order_id, actor_type, event_type, detail, created_at').in('work_order_id', orderIds).order('created_at', { ascending: false }).limit(5000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (eventResult.error) throw eventResult.error;
  const eventMap = {};
  for (const e of (eventResult.data || [])) {
    if (!eventMap[e.work_order_id]) eventMap[e.work_order_id] = [];
    eventMap[e.work_order_id].push({ actorType: e.actor_type, eventType: e.event_type, detail: e.detail || {}, createdAt: e.created_at });
  }
  const propertyMap = Object.fromEntries((properties || []).map(p => [p.id, p]));
  res.status(200).json({
    organisation: {
      id: auth.organisation.id, name: auth.organisation.name, type: auth.organisation.organisation_type,
      approvalRequired: auth.organisation.approval_required, approvalLimitCents: auth.organisation.approval_limit_cents,
    },
    member: {
      id: auth.member.id, name: auth.member.name, email: auth.member.email, role: auth.member.role,
      canApprove: !!auth.member.can_approve || ['org_admin','approver'].includes(auth.member.role),
    },
    properties: (properties || []).map(p => ({
      id: p.id, name: p.name, address: p.address, suburb: p.suburb, state: p.state, postcode: p.postcode, accessNotes: p.access_notes,
    })),
    workOrders: orderRows.map(o => safeMemberOrder(o, propertyMap[o.property_id], o.job_id ? jobMap[o.job_id] : null, fileMap[o.id], eventMap[o.id])),
  });
}
async function activateInvite(supabase, req, res) {
  const auth = await authenticatedUser(supabase, req);
  if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
  const email = validEmail(auth.user.email);
  if (!email) { res.status(400).json({ error: 'Your authenticated account does not have a valid email.' }); return; }
  const { data: member, error } = await supabase.from('pm_members').select('*')
    .eq('email', email).eq('status', 'invited').maybeSingle();
  if (error) throw error;
  if (!member) {
    const { data: existing, error: existingError } = await supabase.from('pm_members').select('id, status, auth_user_id').eq('email', email).maybeSingle();
    if (existingError) throw existingError;
    if (existing && existing.auth_user_id === auth.user.id && existing.status === 'active') {
      res.status(200).json({ activated: true, alreadyActive: true }); return;
    }
    res.status(403).json({ error: 'No property-management invitation was found for this email.' }); return;
  }
  const { error: updateError } = await supabase.from('pm_members').update({
    auth_user_id: auth.user.id, status: 'active', activated_at: new Date().toISOString(),
  }).eq('id', member.id).eq('status', 'invited');
  if (updateError) throw updateError;
  res.status(200).json({ activated: true });
}
async function createProperty(supabase, auth, body, res) {
  if (auth.member.role !== 'org_admin') { res.status(403).json({ error: 'Organisation admin access is required.' }); return; }
  const address = text(body.address, 300);
  if (!address) { res.status(400).json({ error: 'Property address is required.' }); return; }
  const row = {
    organisation_id: auth.organisation.id,
    name: text(body.name, 120) || null,
    address,
    suburb: text(body.suburb, 100) || null,
    state: text(body.state, 10) || 'VIC',
    postcode: text(body.postcode, 10) || null,
    place_id: text(body.placeId, 200) || null,
    latitude: Number.isFinite(Number(body.latitude)) ? Number(body.latitude) : null,
    longitude: Number.isFinite(Number(body.longitude)) ? Number(body.longitude) : null,
    access_notes: text(body.accessNotes, 1500) || null,
  };
  const { data, error } = await supabase.from('pm_properties').insert(row).select('*').single();
  if (error) throw error;
  res.status(201).json({ property: data });
}
async function createWorkOrder(supabase, auth, body, res) {
  const property = await propertyForOrg(supabase, auth.organisation.id, body.propertyId);
  if (!property) { res.status(404).json({ error: 'Property not found.' }); return; }

  let serviceMode = body.serviceMode === 'project_quote' ? 'project_quote' : 'instant_price';
  let quotedPriceCents = null;
  let category = text(body.category, 120) || null;
  let taskSummary = text(body.taskSummary, 300);
  let pricedLine = null;
  if (serviceMode === 'instant_price') {
    const { categories } = await loadCategories(supabase);
    const estimate = estimateLine(categories, { category, taskName: body.taskName, qty: body.qty });
    if (!estimate.ok) {
      serviceMode = 'project_quote';
    } else {
      quotedPriceCents = estimate.totalCents;
      category = estimate.category;
      taskSummary = taskSummary || (estimate.taskName + ' — ' + estimate.qty + ' ' + estimate.unit);
      pricedLine = estimate;
    }
  }
  if (!taskSummary) taskSummary = text(body.taskName, 200) || 'Maintenance request';
  const approvalRequired = !!auth.organisation.approval_required;
  const approvalStatus = approvalRequired ? 'pending' : 'not_required';
  const status = serviceMode === 'project_quote' ? 'quote_required' : (approvalRequired ? 'awaiting_approval' : 'ready_to_release');
  const recur = !!body.recurring;
  const recurrenceRule = recur ? recurrence(body.recurrenceRule) : null;
  if (recur && !recurrenceRule) { res.status(400).json({ error: 'Choose a supported recurrence interval.' }); return; }

  const row = {
    organisation_id: auth.organisation.id,
    property_id: property.id,
    requested_by_member_id: auth.member.id,
    service_mode: serviceMode,
    category,
    task_summary: taskSummary,
    description: text(body.description, 5000) || null,
    priority: priority(body.priority),
    requested_completion_date: safeDate(body.requestedCompletionDate),
    recurring: recur,
    recurrence_rule: recurrenceRule,
    approval_required: approvalRequired,
    approval_status: approvalStatus,
    status,
    quoted_price_cents: quotedPriceCents,
  };
  const { data: order, error } = await supabase.from('pm_work_orders').insert(row).select('*').single();
  if (error) throw error;
  const attachments = await storeAttachments(supabase, auth.organisation.id, order.id, auth.member.id, body.attachments, 'request_photo');
  await event(supabase, order.id, 'member', auth.member.id, 'work_order_created', {
    serviceMode, priority: row.priority, quotedPriceCents, recurring: recur, recurrenceRule,
  });
  await notifyAdmin(supabase, {
    eventType: 'property-work-order-created',
    title: 'New property maintenance work order',
    body: auth.organisation.name + ' submitted ' + taskSummary + ' at ' + property.address + '.',
    metadata: { workOrderId: order.id, organisationId: auth.organisation.id, priority: row.priority, serviceMode },
  }).catch(() => {});
  res.status(201).json({
    workOrder: safeMemberOrder(order, property, null, await signFiles(supabase, attachments), []),
    pricing: pricedLine,
  });
}
async function approveWorkOrder(supabase, auth, body, res) {
  if (!(auth.member.can_approve || ['org_admin','approver'].includes(auth.member.role))) {
    res.status(403).json({ error: 'Approval permission is required.' }); return;
  }
  const order = await memberWorkOrder(supabase, auth.organisation.id, body.workOrderId);
  if (!order) { res.status(404).json({ error: 'Work order not found.' }); return; }
  if (!['pending'].includes(order.approval_status)) { res.status(409).json({ error: 'This work order is no longer awaiting approval.' }); return; }
  const decision = body.decision === 'rejected' ? 'rejected' : 'approved';
  const now = new Date().toISOString();
  const nextStatus = decision === 'approved'
    ? (order.quoted_price_cents != null ? 'ready_to_release' : 'quote_required')
    : 'cancelled';
  const { error } = await supabase.from('pm_work_orders').update({
    approval_status: decision,
    approved_by_member_id: decision === 'approved' ? auth.member.id : null,
    approved_at: decision === 'approved' ? now : null,
    status: nextStatus,
    updated_at: now,
  }).eq('id', order.id).eq('organisation_id', auth.organisation.id);
  if (error) throw error;
  await event(supabase, order.id, 'member', auth.member.id, 'approval_' + decision, { note: text(body.note, 1000) || null });
  res.status(200).json({ updated: true, approvalStatus: decision, status: nextStatus });
}
async function adminSummary(supabase, req, res) {
  if (!requireAdmin(req, res)) return;
  const [orgsResult, membersResult, propertiesResult, ordersResult] = await Promise.all([
    supabase.from('pm_organisations').select('*').order('created_at', { ascending: false }).limit(1000),
    supabase.from('pm_members').select('id, organisation_id, email, name, phone, role, can_approve, status, created_at, activated_at').order('created_at', { ascending: false }).limit(3000),
    supabase.from('pm_properties').select('*').order('created_at', { ascending: false }).limit(5000),
    supabase.from('pm_work_orders').select('*').order('created_at', { ascending: false }).limit(5000),
  ]);
  for (const r of [orgsResult,membersResult,propertiesResult,ordersResult]) if (r.error) throw r.error;
  const orders = ordersResult.data || [];
  const jobs = await linkedJobMap(supabase, orders.map(o => o.job_id).filter(Boolean));
  res.status(200).json({
    organisations: orgsResult.data || [],
    members: membersResult.data || [],
    properties: propertiesResult.data || [],
    workOrders: orders.map(o => ({
      ...o,
      linkedJob: o.job_id && jobs[o.job_id] ? {
        id: jobs[o.job_id].id, jobNumber: jobs[o.job_id].job_number, stage: jobs[o.job_id].stage,
        status: jobs[o.job_id].status, operationalStage: (jobs[o.job_id].full_record || {}).operationalStage || null,
        contractorAssigned: !!jobs[o.job_id].contractor_email,
        updatedAt: jobs[o.job_id].updated_at,
      } : null,
    })),
  });
}
async function adminCreateOrganisation(supabase, body, res) {
  const name = text(body.name, 180);
  const email = validEmail(body.adminEmail);
  if (!name || !email) { res.status(400).json({ error: 'Organisation name and a valid admin email are required.' }); return; }
  const organisationType = ['property_manager','strata','real_estate','commercial','facilities','other'].includes(body.organisationType)
    ? body.organisationType : 'property_manager';
  const { data: org, error: orgError } = await supabase.from('pm_organisations').insert({
    name,
    organisation_type: organisationType,
    billing_email: validEmail(body.billingEmail) || email,
    approval_required: body.approvalRequired !== false,
    approval_limit_cents: cents(body.approvalLimitCents),
  }).select('*').single();
  if (orgError) throw orgError;
  const { data: member, error: memberError } = await supabase.from('pm_members').insert({
    organisation_id: org.id,
    email,
    name: text(body.adminName, 120) || null,
    phone: text(body.adminPhone, 50) || null,
    role: 'org_admin',
    can_approve: true,
    status: 'invited',
  }).select('*').single();
  if (memberError) throw memberError;
  res.status(201).json({ organisation: org, invitedMember: { id: member.id, email: member.email, status: member.status } });
}
async function adminAddMember(supabase, body, res) {
  const organisationId = text(body.organisationId, 50);
  const email = validEmail(body.email);
  const role = ['org_admin','approver','requester','viewer'].includes(body.role) ? body.role : 'requester';
  if (!organisationId || !email) { res.status(400).json({ error: 'organisationId and a valid email are required.' }); return; }
  const { data: org, error: orgError } = await supabase.from('pm_organisations').select('id').eq('id', organisationId).maybeSingle();
  if (orgError) throw orgError;
  if (!org) { res.status(404).json({ error: 'Organisation not found.' }); return; }
  const { data, error } = await supabase.from('pm_members').insert({
    organisation_id: organisationId,
    email,
    name: text(body.name, 120) || null,
    phone: text(body.phone, 50) || null,
    role,
    can_approve: role === 'org_admin' || role === 'approver' || body.canApprove === true,
    status: 'invited',
  }).select('id, organisation_id, email, name, phone, role, can_approve, status, created_at').single();
  if (error) throw error;
  res.status(201).json({ member: data });
}

async function adminAddProperty(supabase, body, res) {
  const organisationId = text(body.organisationId, 50);
  const address = text(body.address, 300);
  if (!organisationId || !address) { res.status(400).json({ error: 'organisationId and address are required.' }); return; }
  const { data: org, error: orgError } = await supabase.from('pm_organisations').select('id').eq('id', organisationId).maybeSingle();
  if (orgError) throw orgError;
  if (!org) { res.status(404).json({ error: 'Organisation not found.' }); return; }
  const { data, error } = await supabase.from('pm_properties').insert({
    organisation_id: org.id,
    name: text(body.name, 120) || null,
    address,
    suburb: text(body.suburb, 100) || null,
    state: text(body.state, 10) || 'VIC',
    postcode: text(body.postcode, 10) || null,
    access_notes: text(body.accessNotes, 1500) || null,
  }).select('*').single();
  if (error) throw error;
  res.status(201).json({ property: data });
}
async function adminSetQuote(supabase, body, res) {
  const amount = cents(body.quotedPriceCents);
  if (!body.workOrderId || amount == null || amount <= 0) { res.status(400).json({ error: 'workOrderId and a positive quotedPriceCents are required.' }); return; }
  const { data: order, error: findError } = await supabase.from('pm_work_orders').select('*').eq('id', body.workOrderId).maybeSingle();
  if (findError) throw findError;
  if (!order) { res.status(404).json({ error: 'Work order not found.' }); return; }
  const approvalStatus = order.approval_required ? 'pending' : 'not_required';
  const nextStatus = order.approval_required ? 'awaiting_approval' : 'ready_to_release';
  const { error } = await supabase.from('pm_work_orders').update({
    quoted_price_cents: amount,
    quote_reference: text(body.quoteReference, 100) || null,
    approval_status: approvalStatus,
    status: nextStatus,
    updated_at: new Date().toISOString(),
  }).eq('id', order.id);
  if (error) throw error;
  await event(supabase, order.id, 'admin', 'admin', 'quote_set', { quotedPriceCents: amount, quoteReference: text(body.quoteReference, 100) || null });
  res.status(200).json({ updated: true, status: nextStatus, approvalStatus });
}
async function adminRelease(supabase, body, res) {
  const { data: order, error: orderError } = await supabase.from('pm_work_orders').select('*').eq('id', body.workOrderId).maybeSingle();
  if (orderError) throw orderError;
  if (!order) { res.status(404).json({ error: 'Work order not found.' }); return; }
  if (order.job_id) { res.status(409).json({ error: 'This work order has already been released.' }); return; }
  if (!order.quoted_price_cents || order.quoted_price_cents <= 0) { res.status(409).json({ error: 'Set a price before releasing the work order.' }); return; }\n  if (!order.category) { res.status(409).json({ error: 'Choose a contractor service category before releasing the work order.' }); return; }
  if (order.approval_required && order.approval_status !== 'approved') { res.status(409).json({ error: 'Required client approval has not been recorded.' }); return; }

  const { data: property, error: propertyError } = await supabase.from('pm_properties').select('*').eq('id', order.property_id).single();
  if (propertyError) throw propertyError;
  const { data: org, error: orgError } = await supabase.from('pm_organisations').select('id, name').eq('id', order.organisation_id).single();
  if (orgError) throw orgError;

  const jobId = 'pm_' + order.id.replace(/-/g, '');
  const now = new Date().toISOString();
  const basePrice = order.quoted_price_cents / 100;
  const fullRecord = {
    id: jobId,
    source: 'property_management',
    category: order.category,
    icon: '🏢',
    suburb: property.suburb || null,
    address: property.address,
    access: property.access_notes || null,
    urgency: order.priority,
    basePrice,
    items: [{ taskName: order.task_summary, qty: 1, unit: 'job', base: basePrice }],
    customerName: org.name,
    status: 'feed',
    operationalStage: null,
    requestedCompletionDate: order.requested_completion_date || null,
    propertyManagement: { workOrderId: order.id, organisationName: org.name, propertyName: property.name || null },
    createdAt: now,
    messages: [],
  };
  const { data: job, error: jobError } = await supabase.from('jobs').insert({
    id: jobId,
    category: fullRecord.category,
    suburb: property.suburb || null,
    address: property.address,
    base_price_cents: order.quoted_price_cents,
    deposit_pct: 0,
    deposit_amount_cents: 0,
    status: 'pending_deposit',
    stage: 'booked',
    source: 'property_management',
    full_record: fullRecord,
    updated_at: now,
  }).select('id, job_number').single();
  if (jobError) throw jobError;

  const { data: contractors, error: contractorError } = await supabase.from('contractors')
    .select('id, email, business_name, status, categories').in('status', ['approved','preferred']).limit(1000);
  if (contractorError) throw contractorError;
  const matches = (contractors || []).filter(c => Array.isArray(c.categories) && c.categories.includes(fullRecord.category));
  if (matches.length) {
    const payoutCents = Math.max(0, Math.round(order.quoted_price_cents * 0.82));
    const { error: offerError } = await supabase.from('job_offers').upsert(matches.map(c => ({
      job_id: jobId, contractor_id: c.id, contractor_payout_cents: payoutCents, status: 'pending',
    })), { onConflict: 'job_id,contractor_id' });
    if (offerError) throw offerError;
    await Promise.all(matches.map(c => notifyContractor(supabase, {
      email: c.email,
      eventType: 'new-property-job-available',
      title: 'New property maintenance job available',
      body: order.task_summary + (property.suburb ? ' in ' + property.suburb : '') + '. Review the job feed for timing and payout.',
      subject: 'New ' + fullRecord.category + ' job available' + (property.suburb ? ' in ' + property.suburb : ''),
      jobId,
      metadata: { category: fullRecord.category, suburb: property.suburb || null, urgency: order.priority, source: 'property_management' },
    }).catch(() => ({ ok: false }))));
  }

  const { error: updateError } = await supabase.from('pm_work_orders').update({
    job_id: jobId, status: 'released', contractor_status: 'offered', updated_at: now,
  }).eq('id', order.id);
  if (updateError) throw updateError;
  await event(supabase, order.id, 'admin', 'admin', 'released_to_contractors', { jobId, jobNumber: job.job_number, contractorOfferCount: matches.length });
  res.status(200).json({ released: true, jobId, jobNumber: job.job_number, contractorOfferCount: matches.length });
}
async function adminUpdate(supabase, body, res) {
  const { data: order, error: findError } = await supabase.from('pm_work_orders').select('*').eq('id', body.workOrderId).maybeSingle();
  if (findError) throw findError;
  if (!order) { res.status(404).json({ error: 'Work order not found.' }); return; }
  const patch = { updated_at: new Date().toISOString() };
  if (['released','assigned','in_progress','completed','cancelled'].includes(body.status)) patch.status = body.status;
  if (body.contractorStatus !== undefined) patch.contractor_status = text(body.contractorStatus, 120) || null;
  if (body.completionNotes !== undefined) patch.completion_notes = text(body.completionNotes, 5000) || null;
  if (body.status === 'completed') { patch.completed_at = new Date().toISOString(); }
  if (body.invoiceReference !== undefined) patch.invoice_reference = text(body.invoiceReference, 120) || null;
  if (['not_issued','issued','paid','void'].includes(body.invoiceStatus)) patch.invoice_status = body.invoiceStatus;
  if (body.invoiceAmountCents !== undefined) patch.invoice_amount_cents = cents(body.invoiceAmountCents);
  const { error } = await supabase.from('pm_work_orders').update(patch).eq('id', order.id);
  if (error) throw error;
  await event(supabase, order.id, 'admin', 'admin', 'admin_update', {
    status: patch.status || null, contractorStatus: patch.contractor_status || null,
    invoiceStatus: patch.invoice_status || null, invoiceReference: patch.invoice_reference || null,
  });
  res.status(200).json({ updated: true });
}
async function contractorCompletion(supabase, req, body, res) {
  const auth = await requireApprovedContractor(supabase, req);
  if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
  const { data: order, error: orderError } = await supabase.from('pm_work_orders').select('*').eq('id', body.workOrderId).maybeSingle();
  if (orderError) throw orderError;
  if (!order || !order.job_id) { res.status(404).json({ error: 'Property work order not found.' }); return; }
  const { data: job, error: jobError } = await supabase.from('jobs').select('id, contractor_email').eq('id', order.job_id).maybeSingle();
  if (jobError) throw jobError;
  if (!job || String(job.contractor_email || '').toLowerCase() !== String(auth.account.email).toLowerCase()) {
    res.status(403).json({ error: 'Only the assigned contractor can add completion evidence.' }); return;
  }
  const attachments = await storeAttachments(supabase, order.organisation_id, order.id, null, body.attachments, 'completion_photo');
  const notes = text(body.completionNotes, 5000) || null;
  const { error: updateError } = await supabase.from('pm_work_orders').update({
    contractor_status: 'completed',
    completion_notes: notes || order.completion_notes,
    status: 'completed',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', order.id);
  if (updateError) throw updateError;
  await event(supabase, order.id, 'contractor', auth.account.id, 'completion_evidence_added', { fileCount: attachments.length, hasNotes: !!notes });
  res.status(200).json({ uploaded: attachments.length });
}

module.exports = async (req, res) => {
  try {
    const supabase = getSupabase();
    const action = text((req.query && req.query.action) || (req.body && req.body.action), 80);

    if (req.method === 'GET' && action === 'bootstrap') { await bootstrap(supabase, req, res); return; }
    if (req.method === 'GET' && action === 'admin-summary') { await adminSummary(supabase, req, res); return; }

    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return; }

    if (action === 'activate-invite') { await activateInvite(supabase, req, res); return; }
    if (action === 'contractor-completion') { await contractorCompletion(supabase, req, req.body || {}, res); return; }

    if (action.startsWith('admin-')) {
      if (!verifyAdminAuth(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
      if (action === 'admin-create-organisation') { await adminCreateOrganisation(supabase, req.body || {}, res); return; }
      if (action === 'admin-add-member') { await adminAddMember(supabase, req.body || {}, res); return; }\n      if (action === 'admin-add-property') { await adminAddProperty(supabase, req.body || {}, res); return; }
      if (action === 'admin-set-quote') { await adminSetQuote(supabase, req.body || {}, res); return; }
      if (action === 'admin-release-work-order') { await adminRelease(supabase, req.body || {}, res); return; }
      if (action === 'admin-update-work-order') { await adminUpdate(supabase, req.body || {}, res); return; }
      res.status(400).json({ error: 'Unknown admin action.' }); return;
    }

    const auth = await requirePropertyMember(supabase, req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    if (action === 'create-property') { await createProperty(supabase, auth, req.body || {}, res); return; }
    if (action === 'create-work-order') { await createWorkOrder(supabase, auth, req.body || {}, res); return; }
    if (action === 'approve-work-order') { await approveWorkOrder(supabase, auth, req.body || {}, res); return; }

    res.status(400).json({ error: 'Unknown property-management action.' });
  } catch (err) {
    console.error('property-management error:', err);
    const message = err && err.message ? err.message : 'Could not complete the request.';
    res.status(500).json({ error: /attachment|document|recurrence/i.test(message) ? message : 'Could not complete the property-management request.' });
  }
};
