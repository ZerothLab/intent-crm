ALTER TABLE model_connections DROP CONSTRAINT model_connections_provider_check;
ALTER TABLE model_connections ADD CONSTRAINT model_connections_provider_check CHECK(provider IN ('fixture','deepseek','openai-compatible'));
ALTER TABLE model_connections ADD COLUMN base_url text, ADD COLUMN credential text,
 ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0), ADD COLUMN timeout_ms integer NOT NULL DEFAULT 30000 CHECK(timeout_ms BETWEEN 1000 AND 45000),
 ADD COLUMN tested_revision integer, ADD COLUMN tested_at timestamptz, ADD COLUMN test_error text;
CREATE UNIQUE INDEX model_active_purpose_idx ON model_connections(tenant_id,purpose) WHERE enabled;
ALTER TABLE planning_runs ADD COLUMN locale text NOT NULL DEFAULT 'en' CHECK(locale IN ('en','zh-CN'));
ALTER TABLE advancement_proposals DROP CONSTRAINT advancement_proposals_model_check;
ALTER TABLE actions DROP CONSTRAINT actions_status_check;
ALTER TABLE actions ADD CONSTRAINT actions_status_check CHECK(status IN ('draft','approved','executing','succeeded','unknown','failed','cancelled'));
ALTER TABLE actions ADD COLUMN execution_actor_id text, ADD COLUMN resolution_note text, ADD COLUMN transport text NOT NULL DEFAULT 'simulated' CHECK(transport IN ('simulated','webhook'));
ALTER TABLE actions ADD CONSTRAINT actions_execution_actor_fk FOREIGN KEY(tenant_id,execution_actor_id) REFERENCES members(tenant_id,id);
ALTER TABLE commitments DROP CONSTRAINT commitments_status_check;
ALTER TABLE commitments ADD CONSTRAINT commitments_status_check CHECK(status IN ('open','fulfilled','cancelled'));
ALTER TABLE receipts DROP CONSTRAINT receipts_simulated_check;
ALTER TABLE opportunity_tasks DROP CONSTRAINT opportunity_tasks_status_check;
ALTER TABLE opportunity_tasks ADD CONSTRAINT opportunity_tasks_status_check CHECK(status IN ('open','completed','cancelled'));
ALTER TABLE opportunity_tasks ADD COLUMN change_note text;
ALTER TABLE sales_contracts ADD COLUMN cancelled_at timestamptz;
ALTER TABLE sales_contracts DROP CONSTRAINT sales_contracts_tenant_id_opportunity_id_key;
CREATE UNIQUE INDEX active_contract_opportunity_idx ON sales_contracts(tenant_id,opportunity_id) WHERE cancelled_at IS NULL;
ALTER TABLE payments ADD COLUMN reversed_at timestamptz;
CREATE TABLE financial_corrections (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, request_id uuid NOT NULL,
 contract_id text NOT NULL, payment_id text, actor_id text NOT NULL, evidence_id text NOT NULL, customer_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('contract_cancelled','payment_reversed')), note text NOT NULL CHECK(length(trim(note))>=3), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,contract_id) REFERENCES sales_contracts(tenant_id,id), FOREIGN KEY(tenant_id,payment_id) REFERENCES payments(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES members(tenant_id,id), FOREIGN KEY(tenant_id,customer_id,evidence_id) REFERENCES evidence(tenant_id,customer_id,id)
);
CREATE TABLE delivery_settings (
 tenant_id text PRIMARY KEY REFERENCES tenants(id), revision integer NOT NULL DEFAULT 1,
 mode text NOT NULL CHECK(mode IN ('simulated','webhook')), endpoint text, sender text, credential text, webhook_secret text,
 CHECK(mode='simulated' OR (endpoint IS NOT NULL AND sender IS NOT NULL AND credential IS NOT NULL AND webhook_secret IS NOT NULL))
);
CREATE TABLE inbound_events (
 tenant_id text NOT NULL REFERENCES tenants(id), event_id text NOT NULL, digest text NOT NULL, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,event_id)
);
CREATE TABLE runtime_heartbeats (id text PRIMARY KEY, heartbeat_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX planning_runs_active_idx ON planning_runs(tenant_id,created_at) WHERE status IN ('queued','planning');

ALTER TABLE planning_runs ADD COLUMN execution_actor_id text;
ALTER TABLE planning_runs ADD CONSTRAINT planning_runs_execution_actor_fk FOREIGN KEY(tenant_id,execution_actor_id) REFERENCES members(tenant_id,id);
ALTER TABLE actions ADD COLUMN delivery_revision integer NOT NULL DEFAULT 0;
CREATE TABLE dispatch_attempts (
 tenant_id text NOT NULL REFERENCES tenants(id), operation_id text NOT NULL, action_id text NOT NULL, revision integer NOT NULL,
 status text NOT NULL CHECK(status IN ('claimed','unknown','delivered','not_delivered')), reference text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,operation_id), FOREIGN KEY(tenant_id,action_id) REFERENCES actions(tenant_id,id)
);
