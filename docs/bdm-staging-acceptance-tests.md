# BDM staging acceptance tests

Scope: MySubbies Group; Melbourne property managers and facilities-maintenance prospects. No live outreach or production database changes.

## Gates
1. Verify current admin MFA/session authentication and server-side role checks; no browser service-role keys.
2. Review existing CRM schema and proposed AI Workforce migration before applying in an isolated staging Supabase project.
3. Prospect create/list/update: only authorized admin can write or read private CRM records. Reject unauthenticated and non-admin requests.
4. Import five permitted-source test prospects with source URL/license and verification timestamp. Reject invalid input and deduplicate by provider ID or normalized website/location.
5. Draft five tailored outreach emails without assuming unpublished email addresses; record pending approval and audit history.
6. Approve/reject draft as authenticated admin; verify rejected drafts cannot be sent. Keep Outlook sending disabled for this test.
7. Verify suppression/opt-out checks and Australian Spam Act compliance before any later real outreach.
8. Validate agent run logs, error handling, retry/idempotency and no cross-account data exposure.
9. Run npm test, npm run check:syntax and git diff --check; document evidence, failures and remaining blockers.

## Release policy
No scheduled discovery, external paid data source, Outlook send, production migration, or merge to main without explicit approval. Never treat mocked tests as proof of live Supabase/Outlook integration.
