CREATE TABLE payment_refunds (
 tenant_id text NOT NULL REFERENCES tenants(id), id text NOT NULL, request_id uuid NOT NULL,
 payment_id text NOT NULL, contract_id text NOT NULL, receivable_id text NOT NULL, opportunity_id text NOT NULL, owner_id text NOT NULL,
 customer_id text NOT NULL, evidence_id text NOT NULL, actor_id text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents>0 AND amount_cents<=9007199254740991),
 refunded_date date NOT NULL, reference text NOT NULL, note text NOT NULL CHECK(length(trim(note))>=3),
 created_at timestamptz NOT NULL DEFAULT now(), reversed_at timestamptz,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,request_id), UNIQUE(tenant_id,reference),
 FOREIGN KEY(tenant_id,payment_id) REFERENCES payments(tenant_id,id),
 FOREIGN KEY(tenant_id,receivable_id,contract_id,opportunity_id,owner_id) REFERENCES receivables(tenant_id,id,contract_id,opportunity_id,owner_id),
 FOREIGN KEY(tenant_id,customer_id,evidence_id) REFERENCES evidence(tenant_id,customer_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES members(tenant_id,id)
);
ALTER TABLE financial_corrections ADD COLUMN refund_id text;
ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_refund_fk FOREIGN KEY(tenant_id,refund_id) REFERENCES payment_refunds(tenant_id,id);
ALTER TABLE financial_corrections DROP CONSTRAINT financial_corrections_kind_check;
ALTER TABLE financial_corrections ADD CONSTRAINT financial_corrections_kind_check CHECK(kind IN ('contract_cancelled','payment_reversed','refund_reversed'));
