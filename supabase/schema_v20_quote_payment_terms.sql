-- Sep 2026: real "Payment terms" free text per quote version, requested so
-- the issued quote PDF/page shows payment terms explicitly rather than
-- leaving payment_schedule_note (a Stage-2 structured-schedule placeholder,
-- see schema_v19_quotes_crm.sql) doing double duty as both a plain-text
-- field and a future structured one. This is deliberately free text, not a
-- computed schedule -- real approved-schedule selection is still Stage 2
-- invoicing work.
alter table quote_versions add column if not exists payment_terms_text text;
