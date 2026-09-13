-- Beta 1 data-contract columns for existing D1 installations.
-- Apply after the original schema.sql. Removed invoice state fields are no
-- longer read or written by the API and are intentionally not recreated here.

ALTER TABLE customers ADD COLUMN contact TEXT;
ALTER TABLE customers ADD COLUMN alternate_phone TEXT;
ALTER TABLE customers ADD COLUMN fax TEXT;
ALTER TABLE customers ADD COLUMN credit_limit REAL;
ALTER TABLE customers ADD COLUMN home_currency_balance REAL;

ALTER TABLE invoices ADD COLUMN reference TEXT;
ALTER TABLE invoices ADD COLUMN pre_tax_total REAL;
ALTER TABLE invoices ADD COLUMN home_currency_total REAL;
ALTER TABLE invoices ADD COLUMN home_currency_balance REAL;
ALTER TABLE invoices ADD COLUMN transaction_currency_total REAL;
ALTER TABLE invoices ADD COLUMN transaction_currency_balance REAL;

ALTER TABLE products ADD COLUMN unit TEXT;
ALTER TABLE products ADD COLUMN status TEXT;
