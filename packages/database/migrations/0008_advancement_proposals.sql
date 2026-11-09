ALTER TABLE facts ADD CONSTRAINT facts_customer_identity UNIQUE(tenant_id,customer_id,id);
CREATE TABLE advancement_proposals (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL,
 opportunity_id text NOT NULL, customer_id text NOT NULL, request_id uuid NOT NULL, created_by text NOT NULL,
 opportunity_revision integer NOT NULL CHECK(opportunity_revision>0),
 fact_id text NOT NULL, fact_revision integer NOT NULL CHECK(fact_revision>0), evidence_id text NOT NULL,
 evidence_title text NOT NULL, quote text NOT NULL CHECK(length(trim(quote))>0), fact_value text NOT NULL,
 goal text NOT NULL CHECK(length(trim(goal)) BETWEEN 3 AND 200), due_date date NOT NULL,
 next_step text NOT NULL CHECK(length(trim(next_step)) BETWEEN 3 AND 500),
 rationale text NOT NULL CHECK(length(trim(rationale)) BETWEEN 3 AND 1000),
 previous_next_step text NOT NULL, previous_due_date date,
 model text NOT NULL DEFAULT 'fixture-v1' CHECK(model='fixture-v1'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','dismissed')),
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz, decided_by text, decision_note text, applied_opportunity_revision integer,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,created_by,request_id),
 FOREIGN KEY(tenant_id,customer_id,opportunity_id) REFERENCES opportunities(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,customer_id,fact_id) REFERENCES facts(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,customer_id,evidence_id) REFERENCES evidence(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES members(tenant_id,id),
 FOREIGN KEY(tenant_id,decided_by) REFERENCES members(tenant_id,id),
 CHECK((status='pending' AND revision=1 AND decided_at IS NULL AND decided_by IS NULL AND decision_note IS NULL AND applied_opportunity_revision IS NULL)
 OR (status IN ('applied','dismissed') AND revision=2 AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND decision_note IS NOT NULL AND length(trim(decision_note))>=3
 AND ((status='applied' AND applied_opportunity_revision IS NOT NULL AND applied_opportunity_revision=opportunity_revision+1) OR (status='dismissed' AND applied_opportunity_revision IS NULL))))
);
CREATE INDEX advancement_opportunity_idx ON advancement_proposals(tenant_id,opportunity_id,created_at DESC,id DESC);
