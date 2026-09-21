-- MySubbies issuing entity postal address.
-- Apply once after schema_v31 in the Supabase SQL editor.
-- Safe to re-run: this only updates the configured issuing entity row.

update issuing_entities
set
  address_line = 'PO Box 1126',
  suburb = 'Craigieburn',
  state = 'VIC',
  postcode = '3064'
where legal_name = 'Mysubbies Holdings Pty Ltd';
