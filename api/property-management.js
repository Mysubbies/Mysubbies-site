// MySubbies Property & Facilities Management MVP.
// One serverless surface keeps the Hobby-plan function footprint small.
// All commercial data access is identity-bound server-side or protected by the
// existing MFA-backed admin session cookie.
const { getPropertySupabase, getSupabase } = require('./_lib/clients');
const { requireAdmin, verifyAdminAuth } = require('./_lib/adminAuth');
const { authenticatedUser, requirePropertyMember } = require('./_lib/propertyManagementAuth');
const { requireApprovedContractor } = require('./_lib/userAuth');
const { storeAttachments, signFiles } = require('./_lib/propertyWorkOrderFiles');
const { loadCategories, estimateLine } = require('./_lib/serviceCatalog');
const { notifyAdmin, notifyContractor } = require('./_lib/contractorNotifications');
const { sendEmailWithResult, wrapEmail, escapeHtml, emailButton } = require('./_lib/email');

const LEGAL_REVIEW_THRESHOLD_CENTS = 990000;

function propertyPortalUrl() {
  const explicit = String(process.env.APP_BASE_URL || process.env.PUBLIC_APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit + '/mysubbies-property-portal.html';
  if (process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_URL) return 'https://' + process.env.VERCEL_URL + '/mysubbies-property-portal.html';
  return 'https://app.mysubbies.com.au/mysubbies-property-portal.html';
}

async function sendPropertyInvite(email, organisationName, role) {
  return sendEmailWithResult({
    to: email,
    subject: 'Your MySubbies Property & Facilities Portal invitation',
    html: wrapEmail(
      '<h2 style="margin-top:0;">You\'re invited to MySubbies</h2>' +
      '<p><strong>' + escapeHtml(organisationName) + '</strong> has been set up in the MySubbies Property & Facilities Portal.</p>' +
      '<p>Your access role is <strong>' + escapeHtml(String(role || 'requester').replace(/_/g, ' ')) + '</strong>. Use this exact email address when you activate your account.</p>' +
      emailButton('Activate your portal access →', propertyPortalUrl()) +
      '<p style="font-size:12px;color:#6B7280;margin-top:18px;">The portal lets your team raise work orders, manage approvals, track jobs, review completion photos and access invoices.</p>'
    ),
  });
}

async function sendWorkOrderEmail({ to, subject, heading, body, ctaText, ctaUrl }) {
  if (!to) return { ok: false, error: 'Recipient email is missing.' };
  return sendEmailWithResult({
    to,
    subject,
    html: wrapEmail(
      '<h2 style="margin-top:0;">' + escapeHtml(heading) + '</h2>' +
      '<p>' + escapeHtml(body) + '</p>' +
      (ctaText && ctaUrl ? emailButton(ctaText, ctaUrl) : '')
    ),
  });
}

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
  const operational = fr.operationalStage || null;
  let displayStatus = order.status;
  if (operational === 'completed') displayStatus = 'completed';
  else if (['on_the_way','started'].includes(operational)) displayStatus = 'in_progress';
  else if (operational === 'scheduled' || fr.status === 'assigned') displayStatus = 'assigned';
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
    status: displayStatus,
    quotedPriceCents: order.quoted_price_cents,
    quoteReference: order.quote_reference,
    contractorStatus: operational || (fr.status === 'assigned' ? 'assigned' : null) || order.contractor_status || (job ? job.stage : null),
    contractorEta: order.contractor_eta,
    beforePhotos: Array.isArray(fr.beforePhotos) ? fr.beforePhotos.slice(0, 20) : [],
    completionPhotos: Array.isArray(fr.afterPhotos) ? fr.afterPhotos.slice(0, 20) : [],
    completionNotes: order.completion_notes,
    completedAt: order.completed_at,
    legalReviewStatus: order.legal_review_status || 'not_required',
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
  const requestedId = text(body.workOrderId, 80);
  const workOrderId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId) ? requestedId : null;
  const row = {
    ...(workOrderId ? { id: workOrderId } : {}),
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
    const { categories } = await loadCategories(getSupabase());
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
    legal_review_status: quotedPriceCents != null && quotedPriceCents > LEGAL_REVIEW_THRESHOLD_CENTS ? 'pending' : 'not_required',
  };
  const { data: order, error } = await supabase.from('pm_work_orders').insert(row).select('*').single();
  if (error) {
    if (error.code === '23505' && workOrderId) {
      const { data: existing, error: existingError } = await supabase.from('pm_work_orders')
        .select('*').eq('id', workOrderId).eq('organisation_id', auth.organisation.id).maybeSingle();
      if (existingError) throw existingError;
      if (existing) {
        res.status(200).json({
          workOrder: safeMemberOrder(existing, property, null, [], []),
          pricing: pricedLine,
          duplicatePrevented: true,
        });
        return;
      }
    }
    throw error;
  }
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
  await sendWorkOrderEmail({
    to: auth.member.email,
    subject: 'Your MySubbies work order has been received',
    heading: 'Work order received',
    body: taskSummary + ' at ' + property.address + ' has been received. You can track approvals, quotes and job progress in the Property & Facilities Portal.',
    ctaText: 'Open Property Portal →',
    ctaUrl: propertyPortalUrl(),
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
  const [orgsResult, membersResult, propertiesResult, ordersResult, contractorsResult] = await Promise.all([
    supabase.from('pm_organisations').select('*').order('created_at', { ascending: false }).limit(1000),
    supabase.from('pm_members').select('id, organisation_id, email, name, phone, role, can_approve, status, created_at, activated_at').order('created_at', { ascending: false }).limit(3000),
    supabase.from('pm_properties').select('*').order('created_at', { ascending: false }).limit(5000),
    supabase.from('pm_work_orders').select('*').order('created_at', { ascending: false }).limit(5000),
    supabase.from('contractors').select('id, email, business_name, status, categories').in('status', ['approved','preferred']).order('business_name').limit(1000),
  ]);
  for (const r of [orgsResult,membersResult,propertiesResult,ordersResult,contractorsResult]) if (r.error) throw r.error;
  const orders = ordersResult.data || [];
  const [jobs, fileMap] = await Promise.all([
    linkedJobMap(supabase, orders.map(o => o.job_id).filter(Boolean)),
    signedFilesForOrders(supabase, orders.map(o => o.id)),
  ]);
  res.status(200).json({
    organisations: orgsResult.data || [],
    members: membersResult.data || [],
    properties: propertiesResult.data || [],
    contractors: (contractorsResult.data || []).map(c => ({
      id: c.id, businessName: c.business_name || c.email, email: c.email,
      status: c.status, categories: Array.isArray(c.categories) ? c.categories : [],
    })),
    workOrders: orders.map(o => ({
      ...o,
      linkedJob: o.job_id && jobs[o.job_id] ? {
        id: jobs[o.job_id].id, jobNumber: jobs[o.job_id].job_number, stage: jobs[o.job_id].stage,
        status: jobs[o.job_id].status, operationalStage: (jobs[o.job_id].full_record || {}).operationalStage || null,
        contractorAssigned: !!jobs[o.job_id].contractor_email,
        updatedAt: jobs[o.job_id].updated_at,
      } : null,
      files: fileMap[o.id] || [],
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
  const invite = await sendPropertyInvite(member.email, org.name, member.role).catch(() => ({ ok: false }));
  res.status(201).json({ organisation: org, invitedMember: { id: member.id, email: member.email, status: member.status }, inviteEmailSent: !!invite.ok });
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
  const { data: orgNameRow } = await supabase.from('pm_organisations').select('name').eq('id', organisationId).maybeSingle();
  const invite = await sendPropertyInvite(data.email, orgNameRow ? orgNameRow.name : 'Your organisation', data.role).catch(() => ({ ok: false }));
  res.status(201).json({ member: data, inviteEmailSent: !!invite.ok });
}

async function adminResendInvite(supabase, body, res) {
  const memberId = text(body.memberId, 50);
  if (!memberId) { res.status(400).json({ error: 'memberId is required.' }); return; }
  const { data: member, error: memberError } = await supabase.from('pm_members')
    .select('id, organisation_id, email, role, status').eq('id', memberId).maybeSingle();
  if (memberError) throw memberError;
  if (!member) { res.status(404).json({ error: 'Contact not found.' }); return; }
  if (member.status === 'active') { res.status(409).json({ error: 'This contact has already activated their portal account.' }); return; }
  const { data: org, error: orgError } = await supabase.from('pm_organisations')
    .select('name').eq('id', member.organisation_id).maybeSingle();
  if (orgError) throw orgError;
  const invite = await sendPropertyInvite(member.email, org ? org.name : 'Your organisation', member.role);
  if (!invite.ok) {
    res.status(502).json({ error: invite.error || 'Invitation email could not be sent.' });
    return;
  }
  res.status(200).json({ sent: true });
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
    category: text(body.category, 120) || order.category || null,
    quote_reference: text(body.quoteReference, 100) || null,
    legal_review_status: amount > LEGAL_REVIEW_THRESHOLD_CENTS ? 'pending' : 'not_required',
    approval_status: approvalStatus,
    status: nextStatus,
    updated_at: new Date().toISOString(),
  }).eq('id', order.id);
  if (error) throw error;
  await event(supabase, order.id, 'admin', 'admin', 'quote_set', { quotedPriceCents: amount, quoteReference: text(body.quoteReference, 100) || null });
  const { data: requester } = await supabase.from('pm_members')
    .select('email, name').eq('id', order.requested_by_member_id).maybeSingle();
  const { data: prop } = await supabase.from('pm_properties')
    .select('address').eq('id', order.property_id).maybeSingle();
  let quoteEmailSent = false;
  if (requester && requester.email) {
    const delivery = await sendWorkOrderEmail({
      to: requester.email,
      subject: 'Your MySubbies work order quote is ready',
      heading: 'Quote ready for review',
      body: 'A quote is ready for ' + order.task_summary + (prop && prop.address ? ' at ' + prop.address : '') +
        '. Quote amount: ' + new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount / 100) +
        (order.approval_required ? '. Approval is required before this work can be released.' : '.'),
      ctaText: 'Review quote in portal →',
      ctaUrl: propertyPortalUrl(),
    }).catch(() => ({ ok: false }));
    quoteEmailSent = !!delivery.ok;
  }
  res.status(200).json({ updated: true, status: nextStatus, approvalStatus, quoteEmailSent });
}
async function adminRelease(supabase, body, res) {
  const { data: order, error: orderError } = await supabase.from('pm_work_orders').select('*').eq('id', body.workOrderId).maybeSingle();
  if (orderError) throw orderError;
  if (!order) { res.status(404).json({ error: 'Work order not found.' }); return; }
  if (order.job_id) { res.status(409).json({ error: 'This work order has already been released.' }); return; }
  if (!order.quoted_price_cents || order.quoted_price_cents <= 0) { res.status(409).json({ error: 'Set a price before releasing the work order.' }); return; }
  const selectedContractorId = text(body.contractorId, 80);
  if (!selectedContractorId) { res.status(400).json({ error: 'Select the site contractor before releasing the work order.' }); return; }
  if (order.approval_required && order.approval_status !== 'approved') { res.status(409).json({ error: 'Required client approval has not been recorded.' }); return; }
  if (order.legal_review_status === 'pending') { res.status(409).json({ error: 'High-value work requires contract/legal review before contractor release.' }); return; }

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

  const { data: selectedContractor, error: contractorError } = await supabase.from('contractors')
    .select('id, email, business_name, status, categories').eq('id', selectedContractorId).maybeSingle();
  if (contractorError) throw contractorError;
  if (!selectedContractor || !['approved','preferred'].includes(selectedContractor.status)) {
    res.status(409).json({ error: 'The selected contractor is not currently approved for allocation.' }); return;
  }

  const resolvedCategory = order.category || (Array.isArray(selectedContractor.categories) && selectedContractor.categories[0]) || 'Property Maintenance';
  if (resolvedCategory !== fullRecord.category) {
    fullRecord.category = resolvedCategory;
    fullRecord.items = [{ taskName: order.task_summary, qty: 1, unit: 'job', base: basePrice }];
    const { error: jobCategoryError } = await supabase.from('jobs').update({
      category: resolvedCategory,
      full_record: fullRecord,
      updated_at: now,
    }).eq('id', jobId);
    if (jobCategoryError) throw jobCategoryError;
  }

  const payoutCents = Math.max(0, Math.round(order.quoted_price_cents * 0.82));
  const { error: offerError } = await supabase.from('job_offers').upsert({
    job_id: jobId, contractor_id: selectedContractor.id, contractor_payout_cents: payoutCents, status: 'pending',
  }, { onConflict: 'job_id,contractor_id' });
  if (offerError) throw offerError;

  await notifyContractor(supabase, {
    email: selectedContractor.email,
    eventType: 'new-property-job-allocated',
    title: 'Property maintenance job allocated to you',
    body: order.task_summary + (property.suburb ? ' in ' + property.suburb : '') + '. This job has been allocated to you for this site. Review and accept it in the contractor portal.',
    subject: 'MySubbies property job allocated to you' + (property.suburb ? ' — ' + property.suburb : ''),
    jobId,
    metadata: { category: resolvedCategory, suburb: property.suburb || null, urgency: order.priority, source: 'property_management', siteAllocated: true },
  }).catch(() => ({ ok: false }));

  const { error: updateError } = await supabase.from('pm_work_orders').update({
    job_id: jobId, category: resolvedCategory, status: 'released',
    contractor_status: 'allocated to ' + (selectedContractor.business_name || selectedContractor.email),
    updated_at: now,
  }).eq('id', order.id);
  if (updateError) throw updateError;
  await event(supabase, order.id, 'admin', 'admin', 'allocated_to_site_contractor', {
    jobId, jobNumber: job.job_number, contractorId: selectedContractor.id,
    contractorName: selectedContractor.business_name || selectedContractor.email,
  });
  res.status(200).json({
    released: true, jobId, jobNumber: job.job_number, contractorOfferCount: 1,
    contractor: { id: selectedContractor.id, name: selectedContractor.business_name || selectedContractor.email },
  });
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
  if (body.legalReviewStatus === 'cleared' && order.legal_review_status === 'pending') patch.legal_review_status = 'cleared';
  if (body.invoiceReference !== undefined) patch.invoice_reference = text(body.invoiceReference, 120) || null;
  if (['not_issued','issued','paid','void'].includes(body.invoiceStatus)) patch.invoice_status = body.invoiceStatus;
  if (body.invoiceAmountCents !== undefined) patch.invoice_amount_cents = cents(body.invoiceAmountCents);
  const { error } = await supabase.from('pm_work_orders').update(patch).eq('id', order.id);
  if (error) throw error;
  await event(supabase, order.id, 'admin', 'admin', 'admin_update', {
    status: patch.status || null, contractorStatus: patch.contractor_status || null,
    legalReviewStatus: patch.legal_review_status || null, invoiceStatus: patch.invoice_status || null, invoiceReference: patch.invoice_reference || null,
  });
  res.status(200).json({ updated: true });
}
async function adminUploadInvoice(supabase, body, res) {
  const { data: order, error: orderError } = await supabase.from('pm_work_orders').select('*').eq('id', body.workOrderId).maybeSingle();
  if (orderError) throw orderError;
  if (!order) { res.status(404).json({ error: 'Work order not found.' }); return; }
  if (!Array.isArray(body.attachments) || body.attachments.length !== 1 || !String(body.attachments[0].dataUrl || '').startsWith('data:application/pdf;base64,')) {
    res.status(400).json({ error: 'Upload one PDF invoice of 1.5 MB or less.' }); return;
  }
  const files = await storeAttachments(supabase, order.organisation_id, order.id, null, body.attachments, 'invoice');
  const patch = {
    invoice_status: 'issued',
    invoice_reference: text(body.invoiceReference, 120) || order.invoice_reference || null,
    invoice_amount_cents: cents(body.invoiceAmountCents) == null ? order.invoice_amount_cents : cents(body.invoiceAmountCents),
    updated_at: new Date().toISOString(),
  };
  const { error: updateError } = await supabase.from('pm_work_orders').update(patch).eq('id', order.id);
  if (updateError) throw updateError;
  await event(supabase, order.id, 'admin', 'admin', 'invoice_uploaded', { invoiceReference: patch.invoice_reference, fileCount: files.length });
  res.status(200).json({ uploaded: files.length, invoiceStatus: 'issued' });
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
    const supabase = getPropertySupabase();
    const action = text((req.query && req.query.action) || (req.body && req.body.action), 80);

    if (req.method === 'GET' && action === 'public-config') {
      const supabaseUrl = String(process.env.PROPERTY_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
      const publishableKey = String(process.env.PROPERTY_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
      if (!supabaseUrl || !publishableKey) {
        res.status(500).json({ error: 'Preview Supabase public configuration is not set.' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.status(200).json({ supabaseUrl, publishableKey });
      return;
    }
    if (req.method === 'GET' && action === 'bootstrap') { await bootstrap(supabase, req, res); return; }
    if (req.method === 'GET' && action === 'admin-summary') { await adminSummary(supabase, req, res); return; }

    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed.' }); return; }

    if (action === 'activate-invite') { await activateInvite(supabase, req, res); return; }
    if (action === 'contractor-completion') { await contractorCompletion(supabase, req, req.body || {}, res); return; }

    if (action.startsWith('admin-')) {
      if (!verifyAdminAuth(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
      if (action === 'admin-create-organisation') { await adminCreateOrganisation(supabase, req.body || {}, res); return; }
      if (action === 'admin-add-member') { await adminAddMember(supabase, req.body || {}, res); return; }
      if (action === 'admin-resend-invite') { await adminResendInvite(supabase, req.body || {}, res); return; }
      if (action === 'admin-add-property') { await adminAddProperty(supabase, req.body || {}, res); return; }
      if (action === 'admin-set-quote') { await adminSetQuote(supabase, req.body || {}, res); return; }
      if (action === 'admin-release-work-order') { await adminRelease(supabase, req.body || {}, res); return; }
      if (action === 'admin-update-work-order') { await adminUpdate(supabase, req.body || {}, res); return; }
      if (action === 'admin-upload-invoice') { await adminUploadInvoice(supabase, req.body || {}, res); return; }
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