# MySubbies AI Workforce — Phase 1 (staging plan)

Status: design only; no autonomous outreach or production changes.

## Objective
Build a repeatable, low-cost prospect-to-revenue pipeline. Target: $20,000/month cash available after operating expenses, with room for personal commitments. Report cash received and contribution margin separately from sales and gross booking value.

## Architecture
- Existing static admin portal: add an authenticated AI Workforce tab later.
- Vercel API: server-side agents and scheduled job endpoints, never browser-held secrets.
- Supabase Postgres: source of truth for prospects, discovery runs, outreach approvals, activities and agent logs.
- Scheduled discovery: suburb/category queue with bounded daily quotas, deduplication and retries.
- External data: licensed business directory/search APIs subject to provider terms; avoid scraping or assuming contact emails.
- Outreach: draft first, human approval before sending, unsubscribe/suppression and Australian Spam Act/privacy compliance.
- AI general manager: reads verified KPIs and agent logs; cannot invent activity.

## Proposed tables (migration to review, not applied)
- prospect_organisations: id, business_name, category, suburb, website, phone, public_contact, source_url, source_license, discovered_at, last_verified_at, status.
- prospect_locations: id, organisation_id, street_address, suburb, postcode, service_zone.
- discovery_jobs: id, suburb, category, status, started_at, finished_at, counts_json, error.
- prospect_activities: id, prospect_id, agent_type, action, outcome, created_at.
- outreach_drafts: id, prospect_id, channel, subject, body, approval_status, approved_by, sent_at.
- agent_runs: id, agent_name, started_at, finished_at, status, cost_estimate, metrics_json, error.
- suppression_list: id, channel, contact_hash, reason, created_at.

Unique keys for provider IDs and normalized website + location; RLS and service-role access must be designed before migrations.

## Rollout
1. Inspect existing Supabase migrations, CRM/admin API routes, auth, scheduled jobs, and duplicate logic.
2. Add migrations and read-only reporting in a staging branch; test RLS and access controls.
3. Implement discovery agent for one category in Craigieburn, then extend to Melbourne suburbs.
4. Review sample quality and data-source licensing before enabling daily cron.
5. Add sales draft agent, approval queue, and contractor recruiting workflows.
6. Add manager reporting: newly verified prospects, outreach approved/sent, replies, meetings, quotes, wins, cash received, margin and agent cost.

## Safety
No automatic email campaigns, paid API subscriptions, migrations, merges, or live deployments without explicit approval. Rate-limit and audit every agent. Existing payment and contractor payout workflows must remain untouched.
