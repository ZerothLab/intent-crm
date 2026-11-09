ALTER TABLE members ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE members ADD COLUMN authorization_version integer NOT NULL DEFAULT 1 CHECK (authorization_version > 0);
ALTER TABLE actions ADD COLUMN approved_actor_version integer;
ALTER TABLE actions ADD COLUMN approved_execution_version integer;

-- Existing approvals predate authority binding and require a fresh review.
UPDATE actions SET status='draft', revision=revision+1, approved_revision=NULL, approved_by=NULL,
  last_error='Access controls were upgraded. Review and approve this action again.', updated_at=now()
WHERE status='approved';
UPDATE planning_runs r SET status='waiting_approval'
FROM actions a WHERE a.tenant_id=r.tenant_id AND a.run_id=r.id AND a.status='draft';

CREATE INDEX audit_events_recent_idx ON audit_events(tenant_id, created_at DESC, id DESC);
