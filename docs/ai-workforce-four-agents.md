# MySubbies digital workforce — four roles

## General Manager
Reads verified CRM and agent-run data, assigns work through approved job queues, flags stalled opportunities, and prepares a daily briefing. Never claims an action occurred without an audit record.

## Customer Service
Classifies incoming enquiries, retrieves booking/quote status through authenticated read-only APIs, drafts responses and escalation requests. No autonomous refunds, price changes, or customer messaging in phase 1.

## BDM & Sales
Runs licensed suburb/category business discovery, verifies duplicates, qualifies accounts, prepares outreach drafts, and tracks approved communications and replies. Begin with Craigieburn clinics and schools. No unsolicited bulk email or scraping.

## Finance
Read-only view of settled cash receipts, upcoming obligations, outstanding invoices, gross margin, and monthly cash requirement of AUD 20,000. Distinguish booked revenue, invoiced revenue, and cash received. Never initiate payments, change bank details, or approve payouts.

## Operating model
Each agent has a bounded tool allowlist, input/output schema, audit logs, retry policy, spend ceiling, and escalation criteria. The Manager coordinates but cannot override permission boundaries. Use existing GitHub/Vercel/Supabase stack and authenticated server-side endpoints.

## Acceptance gates
1. Confirm existing CRM schema, admin authorization and financial data sources.
2. Review database migration and test RLS in staging.
3. Ship a read-only manager dashboard with real metrics, not placeholders.
4. Test BDM discovery with approved source and documented usage rights.
5. Add customer service drafts and finance read-only reconciliation.
6. Require explicit approval before outbound communications or any money movement.

Status: specification only; agents are not yet deployed.
