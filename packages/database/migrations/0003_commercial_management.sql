CREATE TABLE opportunities (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, customer_id text NOT NULL, owner_id text NOT NULL,
 title text NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000000000), currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
 expected_close_date date NOT NULL, stage text NOT NULL CHECK(stage IN ('discovery','qualified','proposal','negotiation','won','lost')),
 forecast_category text NOT NULL CHECK(forecast_category IN ('pipeline','best_case','commit','excluded')),
 next_step text NOT NULL DEFAULT '', next_step_due_date date, evidence_id text, lost_reason text,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), stage_entered_at timestamptz NOT NULL DEFAULT now(), closed_date date,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id), FOREIGN KEY(tenant_id,owner_id) REFERENCES members(tenant_id,id),
 FOREIGN KEY(tenant_id,customer_id,evidence_id) REFERENCES evidence(tenant_id,customer_id,id),
 CHECK(stage<>'lost' OR length(trim(lost_reason))>0), CHECK((stage IN ('won','lost'))=(closed_date IS NOT NULL))
);
CREATE INDEX opportunities_owner_period ON opportunities(tenant_id,owner_id,expected_close_date);
CREATE TABLE opportunity_history (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, opportunity_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 actor_id text NOT NULL, note text NOT NULL, before_state jsonb, after_state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,opportunity_id,revision),
 FOREIGN KEY(tenant_id,opportunity_id) REFERENCES opportunities(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES members(tenant_id,id)
);
CREATE TABLE sales_contracts (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, opportunity_id text NOT NULL, customer_id text NOT NULL, owner_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000000000), currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
 signed_date date NOT NULL, reference text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,opportunity_id), UNIQUE(tenant_id,reference), UNIQUE(tenant_id,id,opportunity_id,owner_id),
 FOREIGN KEY(tenant_id,customer_id,opportunity_id) REFERENCES opportunities(tenant_id,customer_id,id), FOREIGN KEY(tenant_id,owner_id) REFERENCES members(tenant_id,id)
);
CREATE TABLE receivables (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, contract_id text NOT NULL, opportunity_id text NOT NULL, owner_id text NOT NULL,
 due_date date NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000000000),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,contract_id,opportunity_id,owner_id),
 FOREIGN KEY(tenant_id,contract_id,opportunity_id,owner_id) REFERENCES sales_contracts(tenant_id,id,opportunity_id,owner_id)
);
CREATE TABLE payments (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, receivable_id text NOT NULL, contract_id text NOT NULL, opportunity_id text NOT NULL, owner_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000000000), paid_date date NOT NULL, reference text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,reference),
 FOREIGN KEY(tenant_id,receivable_id,contract_id,opportunity_id,owner_id) REFERENCES receivables(tenant_id,id,contract_id,opportunity_id,owner_id)
);
CREATE TABLE sales_targets (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, period text NOT NULL CHECK(period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'), owner_id text,
 bookings_target_cents bigint NOT NULL CHECK(bookings_target_cents BETWEEN 1 AND 1000000000000), collection_target_cents bigint NOT NULL CHECK(collection_target_cents BETWEEN 1 AND 1000000000000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,owner_id) REFERENCES members(tenant_id,id)
);
CREATE UNIQUE INDEX sales_target_member_unique ON sales_targets(tenant_id,period,owner_id) WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX sales_target_workspace_unique ON sales_targets(tenant_id,period) WHERE owner_id IS NULL;
CREATE TABLE forecast_snapshots (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, period text NOT NULL CHECK(period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'), owner_id text,
 captured_by text NOT NULL, captured_at timestamptz NOT NULL DEFAULT now(), metrics jsonb NOT NULL, items jsonb NOT NULL,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,owner_id) REFERENCES members(tenant_id,id), FOREIGN KEY(tenant_id,captured_by) REFERENCES members(tenant_id,id)
);
CREATE INDEX forecast_snapshot_scope ON forecast_snapshots(tenant_id,period,owner_id,captured_at DESC);
CREATE TABLE opportunity_tasks (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, opportunity_id text NOT NULL, title text NOT NULL, assignee_id text NOT NULL,
 due_date date NOT NULL, status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')), completion_note text,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,opportunity_id) REFERENCES opportunities(tenant_id,id), FOREIGN KEY(tenant_id,assignee_id) REFERENCES members(tenant_id,id),
 CHECK((status='completed')=(completed_at IS NOT NULL)), CHECK(status<>'completed' OR length(trim(completion_note))>0)
);
