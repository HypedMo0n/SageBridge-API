-- Bind a pairing claim to the connector created by the same atomic D1 batch.
ALTER TABLE pairing_codes ADD COLUMN claimed_connector_id TEXT;
CREATE UNIQUE INDEX pairing_claimed_connector ON pairing_codes(claimed_connector_id) WHERE claimed_connector_id IS NOT NULL;