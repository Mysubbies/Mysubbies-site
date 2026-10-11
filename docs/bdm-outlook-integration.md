# BDM Microsoft 365 shared-mailbox integration — preparation only

Status: development branch, **not connected**, **not sending**. Approved sender identity: `accounts@mysubbies.com.au` (Microsoft 365 shared mailbox). User reports mail sent from Outlook displays this address. This does **not** establish that the MySubbies app has Graph access.

## Architecture decision

Keep prospect CRM and approval state in Supabase. Do not treat `ai_bdm_approvals.status='approved'` as authority to send: the current approval table has no recipient, approver identity, immutable approved content hash, or delivery/audit record. The existing `review` action explicitly records a decision without sending and must stay that way.

Preferred future integration: server-side Microsoft Graph, with the identity and permission model reviewed by a Microsoft 365 administrator. A signed-in user with delegated access may use delegated Graph permissions appropriate for a shared mailbox, such as `Mail.ReadWrite.Shared` for drafts and `Mail.Send.Shared` for sending, plus verified Exchange **Send As** or **Send on behalf** rights. For unattended server workflows, consider application permissions with narrowly scoped Exchange mailbox access controls, tenant administrator consent, and credential rotation; **never** assume that the interactive Outlook connector grants the Vercel app access. Validate current Microsoft documentation and tenant policies before choosing a flow.

## Deployment settings (server-only; do not set yet without tenant admin review)

- `MS365_TENANT_ID`: tenant ID
- `MS365_CLIENT_ID`: registered application ID
- `MS365_CLIENT_SECRET`: secret stored only in protected server-side environment configuration (prefer certificate/managed credentials where supported)
- `BDM_OUTLOOK_SEND_ENABLED`: leave unset/false; no implementation currently uses it to send

Never commit tenant secrets, OAuth refresh/access tokens, customer addresses, or mailbox contents. The config module `lib/ai-workforce/outlook-shared-mailbox-config.js` reports readiness but **hard-disables sending**.

## Before writing any mail endpoints

1. Confirm shared mailbox membership and actual Send As rights; select delegated or narrowly scoped application authentication; configure Entra app registration and admin consent as required.
2. Add a verified recipient email field, provenance, lawful marketing basis/consent review, opt-out/suppression state, and unsubscribe process consistent with the Australian Spam Act. Do not copy Google Places preview results into CRM without rights review.
3. Store an immutable approval record containing recipient, subject, body/content hash, approving admin ID, timestamp and expiration. Enforce server-side revalidation, idempotency and CSRF/origin controls.
4. Separate **draft**, **approve**, and **send** endpoints. Sending requires a second explicit action and exact-match recipient/content against the approval record; never trigger sending solely from a status change.
5. Persist send attempts, Graph message IDs, errors, and delivery/reply reconciliation. Add rate limits, safe retry strategy, and a global kill switch.
6. Test with an internal MySubbies recipient first. Do not send to external prospects until permission, compliance and end-to-end tests are signed off.

## Existing system boundaries

- `api/ai-bdm-crm.js`: authenticated CRUD and approval recording only; **does not send**.
- `bdm-crm.html`: manual pipeline and approval queue.
- `api/ai-bdm-discover.js`: Google Places preview only, not a CRM source.
- ChatGPT Outlook connector and Vercel website integration are separate authorization contexts.

## Acceptance criteria for a later implementation

- No outbound mail with send flag disabled or missing credentials.
- No sending without a verified email address, marketing eligibility, and explicit matching admin approval.
- Only `accounts@mysubbies.com.au` appears as sender; mailbox scope cannot expand silently.
- Every attempt is auditable and retry-safe.
- Internal test proves draft creation, explicit send authorization, and traceable outcome without external contact.
