ALTER TABLE tenants ADD COLUMN revision integer NOT NULL DEFAULT 1;
ALTER TABLE tenants ADD CONSTRAINT tenants_revision_positive CHECK (revision > 0);
