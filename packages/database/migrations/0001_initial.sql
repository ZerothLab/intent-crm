CREATE TABLE tenants (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE members (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, name text NOT NULL, email text NOT NULL,
 role text NOT NULL CHECK (role IN ('admin','manager','sales','engineer')), active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,email)
);
CREATE TABLE customers (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, name text NOT NULL, industry text NOT NULL,
 contact text NOT NULL, email text NOT NULL, owner_id text NOT NULL, stage text NOT NULL DEFAULT 'discovery', revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,owner_id) REFERENCES members(tenant_id,id)
);
CREATE TABLE evidence (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, customer_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('meeting','reply','note')), title text NOT NULL, body text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id)
);
CREATE TABLE planning_runs (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, customer_id text NOT NULL, evidence_id text NOT NULL, actor_id text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','planning','waiting_approval','waiting_reconciliation','completed','failed')),
 action_id text, model text NOT NULL DEFAULT 'fixture-v1', error text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id), FOREIGN KEY(tenant_id,customer_id,evidence_id) REFERENCES evidence(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES members(tenant_id,id)
);
CREATE TABLE actions (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, customer_id text NOT NULL, run_id text NOT NULL,
 kind text NOT NULL DEFAULT 'send_proposal' CHECK(kind='send_proposal'), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','executing','succeeded','unknown','failed')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0), approved_revision integer, approved_by text, recipient text NOT NULL, subject text NOT NULL, body text NOT NULL,
 evidence_ids jsonb NOT NULL DEFAULT '[]', operation_id text NOT NULL UNIQUE, last_error text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,run_id), UNIQUE(tenant_id,customer_id,id), UNIQUE(tenant_id,id,operation_id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id), FOREIGN KEY(tenant_id,customer_id,run_id) REFERENCES planning_runs(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,approved_by) REFERENCES members(tenant_id,id), CHECK((approved_revision IS NULL)=(approved_by IS NULL)),
 CHECK(status NOT IN ('approved','executing','succeeded','unknown') OR approved_revision=revision)
);
ALTER TABLE planning_runs ADD CONSTRAINT planning_run_action_fk FOREIGN KEY(tenant_id,customer_id,action_id) REFERENCES actions(tenant_id,customer_id,id);
CREATE TABLE facts (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, customer_id text NOT NULL, key text NOT NULL, value text NOT NULL,
 evidence_id text NOT NULL, quote text NOT NULL, status text NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate','confirmed')),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
 FOREIGN KEY(tenant_id,customer_id,evidence_id) REFERENCES evidence(tenant_id,customer_id,id)
);
CREATE TABLE receipts (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, action_id text NOT NULL, operation_id text NOT NULL UNIQUE,
 reference text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), simulated boolean NOT NULL DEFAULT true CHECK(simulated),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,action_id,id), FOREIGN KEY(tenant_id,action_id,operation_id) REFERENCES actions(tenant_id,id,operation_id)
);
CREATE TABLE commitments (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, customer_id text NOT NULL, action_id text NOT NULL, title text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','fulfilled')), due_at timestamptz, evidence_id text NOT NULL, completion_receipt_id text,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,customer_id,action_id) REFERENCES actions(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,customer_id,evidence_id) REFERENCES evidence(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,action_id,completion_receipt_id) REFERENCES receipts(tenant_id,action_id,id), CHECK((status='fulfilled')=(completion_receipt_id IS NOT NULL))
);
CREATE TABLE field_definitions (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, key text NOT NULL, label text NOT NULL,
 type text NOT NULL CHECK(type IN ('text','number','date','select')), required boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true, options jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,key)
);
CREATE TABLE customer_field_values (
 tenant_id text NOT NULL REFERENCES tenants(id), customer_id text NOT NULL, field_id text NOT NULL, value jsonb,
 PRIMARY KEY(tenant_id,customer_id,field_id), FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id), FOREIGN KEY(tenant_id,field_id) REFERENCES field_definitions(tenant_id,id)
);
CREATE TABLE model_connections (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, name text NOT NULL, provider text NOT NULL DEFAULT 'fixture' CHECK(provider='fixture'), model text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, purpose text NOT NULL CHECK(purpose IN ('reasoning','extraction')), PRIMARY KEY(tenant_id,id)
);
CREATE TABLE outbox (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, type text NOT NULL CHECK(type IN ('plan.requested','action.approved','action.reconciled')),
 aggregate_id text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
 PRIMARY KEY(tenant_id,id), UNIQUE(id), FOREIGN KEY(tenant_id,aggregate_id) REFERENCES planning_runs(tenant_id,id)
);
CREATE INDEX outbox_pending_idx ON outbox(created_at) WHERE published_at IS NULL;
CREATE INDEX customers_owner_idx ON customers(tenant_id,owner_id);
CREATE TABLE audit_events (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, actor_id text, event text NOT NULL, entity_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES members(tenant_id,id)
);
