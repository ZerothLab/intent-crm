ALTER TABLE planning_runs
 ADD COLUMN parent_run_id text,
 ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK(attempt > 0),
 ADD COLUMN retry_reason text,
 ADD CONSTRAINT planning_runs_source_identity UNIQUE(tenant_id,customer_id,evidence_id,id),
 ADD CONSTRAINT planning_runs_single_successor UNIQUE(tenant_id,parent_run_id),
 ADD CONSTRAINT planning_runs_retry_shape CHECK(
  (parent_run_id IS NULL AND attempt=1 AND retry_reason IS NULL) OR
  (parent_run_id IS NOT NULL AND attempt>1 AND retry_reason IS NOT NULL AND length(trim(retry_reason))>0 AND parent_run_id<>id)
 );
ALTER TABLE planning_runs ADD CONSTRAINT planning_runs_parent_source_fk
 FOREIGN KEY(tenant_id,customer_id,evidence_id,parent_run_id) REFERENCES planning_runs(tenant_id,customer_id,evidence_id,id);
CREATE INDEX planning_runs_source_attempt_idx ON planning_runs(tenant_id,customer_id,evidence_id,attempt DESC,created_at DESC,id DESC);

ALTER TABLE facts DROP CONSTRAINT facts_status_check;
ALTER TABLE facts
 ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 ADD COLUMN reviewed_by text,
 ADD COLUMN review_note text,
 ADD COLUMN reviewed_at timestamptz,
 ADD CONSTRAINT facts_status_check CHECK(status IN ('candidate','confirmed','rejected')),
 ADD CONSTRAINT facts_reviewer_fk FOREIGN KEY(tenant_id,reviewed_by) REFERENCES members(tenant_id,id),
 ADD CONSTRAINT facts_review_metadata CHECK(
  (revision=1 AND status IN ('candidate','confirmed') AND reviewed_by IS NULL AND review_note IS NULL AND reviewed_at IS NULL) OR
  (status IN ('confirmed','rejected') AND reviewed_by IS NOT NULL AND review_note IS NOT NULL AND length(trim(review_note))>0 AND reviewed_at IS NOT NULL)
 );
CREATE TABLE fact_reviews (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, fact_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>1), from_status text NOT NULL CHECK(from_status IN ('candidate','confirmed','rejected')),
 to_status text NOT NULL CHECK(to_status IN ('confirmed','rejected')), note text NOT NULL CHECK(length(trim(note))>0),
 actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,fact_id,revision), CHECK(from_status<>to_status),
 FOREIGN KEY(tenant_id,fact_id) REFERENCES facts(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES members(tenant_id,id)
);
CREATE TABLE conversations (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, customer_id text NOT NULL, member_id text NOT NULL,
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
 FOREIGN KEY(tenant_id,member_id) REFERENCES members(tenant_id,id)
);
CREATE INDEX conversations_owner_page_idx ON conversations(tenant_id,member_id,updated_at DESC,id DESC);
CREATE TABLE conversation_turns (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, conversation_id text NOT NULL, request_id uuid NOT NULL,
 message text NOT NULL CHECK(length(trim(message)) BETWEEN 1 AND 2000), reply jsonb NOT NULL CHECK(jsonb_typeof(reply)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,conversation_id,request_id),
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES conversations(tenant_id,id)
);
CREATE INDEX conversation_turns_page_idx ON conversation_turns(tenant_id,conversation_id,created_at DESC,id DESC);
