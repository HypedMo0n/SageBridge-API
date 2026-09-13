-- Stable installation IDs are globally unique when present.
-- Legacy connectors with NULL installation_id remain valid and may coexist.
-- A connector may be claimed by multiple consumed pairing codes during
-- credential rotation; replay safety remains enforced by pairing-code status.
DROP INDEX IF EXISTS pairing_claimed_connector;
CREATE INDEX IF NOT EXISTS pairing_claimed_connector
ON pairing_codes(claimed_connector_id)
WHERE claimed_connector_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS connectors_installation_id_unique
ON connectors(installation_id)
WHERE installation_id IS NOT NULL;
