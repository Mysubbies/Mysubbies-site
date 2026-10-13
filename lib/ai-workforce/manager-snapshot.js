// Read-only metrics shared by the four MySubbies agents.
// Never estimates cash received from quote totals or booking values.
async function count(supabase, table, apply = q => q) {
  const { count, error } = await apply(supabase.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw error;
  return count || 0;
}
async function managerSnapshot(supabase) {
  const [leads, customers, contractors, prospects, pendingDrafts, succeededPayments] = await Promise.all([
    count(supabase, 'customer_leads'),
    count(supabase, 'customers'),
    count(supabase, 'contractors'),
    count(supabase, 'ai_prospects'),
    count(supabase, 'ai_outreach_drafts', q => q.eq('status', 'pending_review')),
    count(supabase, 'payments', q => q.eq('status', 'succeeded'))
  ]);
  return {
    as_of: new Date().toISOString(),
    source: 'supabase',
    leads, customers, contractors, prospects, pending_outreach_approvals: pendingDrafts,
    succeeded_payment_records: succeededPayments,
    cash_received_aud: null,
    cash_target_aud_per_month: 20000,
    cash_target_note: 'Cash balance and available surplus require reconciled bank, Stripe and expenses data. Payment record counts are not cash totals.',
    agents: {
      manager: 'read_only_reporting',
      customer_service: 'draft_only_planned',
      bdm: 'prospect_discovery_planned',
      finance: 'read_only_reconciliation_planned'
    }
  };
}
module.exports = { managerSnapshot };
