# Contractor onboarding launch-readiness remediation — 11 September 2026

## Fixed now

- New applications are create-only, server validated, versioned-consent recorded, duplicate email/ABN protected, bot-honeypot checked, and limited to five attempts per hashed client fingerprint per hour.
- Application Received, More Information Required, Approved, Rejected, licence reminder, and insurance reminder emails use the shared mobile-friendly MySubbies HTML wrapper. Result-aware sends create persistent Admin delivery-failure notifications.
- Admin receives new-application, missing-document-review, resubmission, decision, expiry, and delivery-failure notifications. Approval/rejection/more-information decisions require the authenticated Admin API; negative decisions require a reason.
- More Information Required emails carry a random 14-day resubmission link. The contractor securely reloads the existing application, edits it, re-accepts the current Terms, uploads documents, and resubmits without creating a duplicate. Admin sees `manual_review` plus the resubmission notification.
- Approval emails carry a random 14-day activation link. Eligibility and activation require that token, an approved/preferred status, and a matching Supabase Auth session; the public endpoint no longer exposes whether an arbitrary email exists.
- Licence, insurance and identity files are signature-checked PDF/JPEG/PNG files, limited to 5 MB and ten files per section, given safe opaque names, and stored in the private `contractor-documents` Supabase Storage bucket. Application JSON stores metadata/path only. Admin-only application reads mint five-minute signed URLs. Normal contractor/profile APIs never expose paths or signed URLs.
- Approved-only APIs reject manual-review, rejected, suspended, expired-document, and explicitly expired compliance accounts. Account resolution binds the Supabase bearer token to exactly one role/account. Job claiming requires a pending contractor-specific offer.
- Cross-device contractor profile hydration now restores categories, regions, suburbs and availability from the server.

Malware scanning is **not implemented**: the current stack has no scanner. Signature/MIME/size validation substantially reduces risk, but Admin should not open unexpected documents outside the staging/controlled review workflow. A scanner can be added after launch or before higher-volume paid acquisition.

## Still requires staging

No production or staging credentials were used during remediation. Before promotion, the staging database migration, storage bucket, Auth configuration, email sender/recipient policy, CRON authentication, browser flows and real provider delivery must be proven once using synthetic data.

### MySubbies-Staging SQL execution order

Because MySubbies-Staging may be empty, execute **every repository schema file** in this exact order. There is intentionally no v11 file.

1. `supabase/schema.sql`
2. `supabase/schema_v2_marketplace.sql`
3. `supabase/schema_v3_payment_schedules.sql`
4. `supabase/schema_v4_account_status.sql`
5. `supabase/schema_v5_property_profiles.sql`
6. `supabase/schema_v6_property_profile_extras.sql`
7. `supabase/schema_v7_admin_contractor_messages.sql`
8. `supabase/schema_v8_two_way_admin_contractor_messages.sql`
9. `supabase/schema_v9_contractor_referrals.sql`
10. `supabase/schema_v10_job_numbers.sql`
11. `supabase/schema_v12_rate_card_sync.sql`
12. `supabase/schema_v13_notifications.sql`
13. `supabase/schema_v14_disputes_inquiries.sql`
14. `supabase/schema_v15_customer_referrals_and_credits.sql`
15. `supabase/schema_v16_contractor_business_structure.sql`
16. `supabase/schema_v17_contractor_address.sql`
17. `supabase/schema_v18_customer_preferences.sql`
18. `supabase/schema_v19_quotes_crm.sql`
19. `supabase/schema_v20_quote_payment_terms.sql`
20. `supabase/schema_v21_contractor_onboarding.sql`
21. `supabase/schema_v22_contractor_bank_payouts.sql`
22. `supabase/schema_v23_contractor_notification_audit.sql`

Then configure the Preview/Staging deployment with staging-only Supabase URL/service-role and browser publishable key, `RESEND_API_KEY`, verified `RESEND_FROM_EMAIL`, `ADMIN_NOTIFY_EMAIL` pointing to the test inbox, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `CRON_SECRET`, and a unique `SIGNUP_RATE_LIMIT_SECRET`. Resend must be restricted to the synthetic test inbox during verification.

### One manual staging test

Use one synthetic contractor, one Admin operator and one allowlisted test inbox:

1. Open the staging signup on desktop at a mobile viewport once and a desktop viewport once. Submit a synthetic contractor with one category, one region plus one suburb, a checksum-valid synthetic/test ABN reserved for this test process, licence/insurance declarations, current Terms acceptance, one small genuine PDF licence and one small genuine PNG insurance file.
2. Confirm the success screen, one `manual_review` contractor row, structured consent fields, metadata-only document entries, private Storage objects, the Application Received email, and Admin new-application/missing-documents notifications.
3. In Admin choose **More info**, enter “Upload a current insurance certificate and confirm Northern Melbourne coverage,” and confirm the correct email arrives.
4. Open the secure link, verify the same application is prefilled, update the requested information/file, re-accept Terms, resubmit, and confirm Admin sees the resubmission notification without a second contractor row.
5. Approve in Admin. Confirm the Approved email includes the secure activation link and operational guidance.
6. Follow the activation link, create the Supabase password, complete any staging Auth confirmation email, and log in.
7. Confirm the portal shows the selected category, region/suburb and availability. Confirm a customer login cannot open the contractor job API and that the approved contractor sees no offer unless a pending `job_offers` row exists.
8. Delete the synthetic Auth user, contractor row, notifications and private objects from **staging only** after evidence is captured.

Community promotion should begin only after all eight steps pass. Any failure returns the decision to NO-GO until corrected and rerun.

## Optional post-launch improvements

- Add managed malware scanning/quarantine for document uploads.
- Replace the small Admin reason prompt with a richer modal and reason presets.
- Add automated browser E2E tests against an isolated Supabase project.
- Add rate-limit cleanup/retention automation and tune thresholds using non-sensitive aggregate staging/launch observations.
- Add SMS or push only if email response times prove insufficient; it is not required for initial community promotion.

## Decisions

- **Free community promotion: CONDITIONAL GO after the single staging test passes.** Code-level blockers are remediated; staging/provider/configuration proof is the only launch gate.
- **Paid Meta contractor ads: NO-GO.** Complete community validation first and add malware scanning or a documented controlled-review risk acceptance before higher-volume acquisition.
- **Production deployment: NO-GO now.** Review this commit, apply migrations to MySubbies-Staging, complete the manual test, and only then schedule a separate approved production rollout. This work was not deployed or merged.
