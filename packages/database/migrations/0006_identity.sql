-- No default credentials: the local administrator creates the first workspace explicitly.
CREATE UNIQUE INDEX members_normalized_email ON members(tenant_id, lower(email));

CREATE TABLE identity_credentials (
 tenant_id text NOT NULL, member_id text NOT NULL, password_hash text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,member_id),
 FOREIGN KEY(tenant_id,member_id) REFERENCES members(tenant_id,id)
);
CREATE TABLE identity_sessions (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 tenant_id text NOT NULL, member_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(expires_at>created_at),
 FOREIGN KEY(tenant_id,member_id) REFERENCES members(tenant_id,id)
);
CREATE INDEX identity_sessions_member ON identity_sessions(tenant_id,member_id);
CREATE INDEX identity_sessions_expiry ON identity_sessions(expires_at);
CREATE TABLE identity_login_limits (
 bucket_key text PRIMARY KEY CHECK(bucket_key ~ '^[0-9a-f]{64}$'),
 attempts integer NOT NULL CHECK(attempts>=1), reset_at timestamptz NOT NULL
);
CREATE INDEX identity_login_limits_expiry ON identity_login_limits(reset_at);
