# Contractor notification lifecycle

This branch records contractor lifecycle messages in `notifications` and uses email in addition to in-app delivery for critical events. Notification audit rows carry an event type, related application/job reference, intended channels, per-channel delivery state, and non-sensitive metadata. Failed critical email delivery creates an Admin alert without blocking the underlying business state change.

## Channel matrix

| Event | Contractor | Admin |
| --- | --- | --- |
| Application submitted / resubmitted | Email + in-app | In-app review alert |
| More information, approval, rejection, activation | Email + in-app | In-app decision audit |
| Material profile or payout details changed | In-app; email for login-address changes | In-app for compliance, business, or payout-risk changes |
| Compliance uploaded, expiring, expired, or missing | In-app; email for critical expiry/missing events | In-app compliance alert |
| Job offered, assigned, materially changed, cancelled, or reassigned | Email + in-app | Existing operational flow plus assignment audit |
| Job accepted, declined, offer expired, or progress milestone | In-app | In-app where operationally relevant |
| Payout ready, processed, or issue | In-app; email for processed/issues | In-app audit |
| Suspension or reactivation | Email + in-app | In-app audit |

The payout events are notifications for the existing manual bank-processing workflow only. They do not initiate a transfer. Customer Stripe payment collection is unchanged.

## Staging requirements

After applying the repository base schema and onboarding migrations in the documented order, apply `supabase/schema_v23_contractor_notification_audit.sql`. Verify the Preview deployment uses staging-only Supabase and Resend configuration, then exercise each critical event with synthetic addresses. Confirm successful email delivery, in-app visibility, Admin failure visibility after a deliberately rejected test recipient, and that no bank details or pre-acceptance customer private data occur in notification payloads.

Browser and provider delivery behaviour still requires staging verification. No production database, mail recipient, deployment, or payment operation was used while implementing this change.
