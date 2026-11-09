ALTER TABLE evidence ADD COLUMN source_digest text;
-- Byte-length prefixes match the Node SHA-256 input, including Unicode and embedded newlines.
UPDATE evidence SET source_digest = encode(sha256(convert_to(
 octet_length(kind)::text || ':' || kind ||
 octet_length(title)::text || ':' || title ||
 octet_length(body)::text || ':' || body,
 'UTF8')), 'hex');
ALTER TABLE evidence ALTER COLUMN source_digest SET NOT NULL;
ALTER TABLE evidence ADD CONSTRAINT evidence_source_digest_format CHECK(source_digest ~ '^[0-9a-f]{64}$');
ALTER TABLE evidence ADD CONSTRAINT evidence_source_unique UNIQUE(tenant_id,customer_id,source_digest);
