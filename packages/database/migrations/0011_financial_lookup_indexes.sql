CREATE INDEX payments_receivable_active_idx ON payments(tenant_id,receivable_id) WHERE reversed_at IS NULL;
CREATE INDEX refunds_payment_active_idx ON payment_refunds(tenant_id,payment_id) WHERE reversed_at IS NULL;
CREATE INDEX refunds_receivable_active_idx ON payment_refunds(tenant_id,receivable_id) WHERE reversed_at IS NULL;
CREATE INDEX refunds_opportunity_idx ON payment_refunds(tenant_id,opportunity_id);
CREATE INDEX financial_corrections_contract_idx ON financial_corrections(tenant_id,contract_id,created_at);
