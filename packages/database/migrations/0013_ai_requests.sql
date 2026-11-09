CREATE TABLE ai_requests (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  member_id text NOT NULL,
  request_key text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '3 minutes',
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES members(tenant_id, id)
);
CREATE UNIQUE INDEX ai_requests_active_key ON ai_requests(tenant_id, member_id, request_key) WHERE finished_at IS NULL;
CREATE INDEX ai_requests_recent ON ai_requests(tenant_id, started_at);
