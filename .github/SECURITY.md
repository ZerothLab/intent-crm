# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/ZerothLab/intent-crm/security/advisories/new). Do not disclose an unpatched vulnerability in a public issue or pull request.

Include the affected commit or image digest, deployment conditions, impact, and minimal reproduction steps using fictional data. Areas of particular interest include cross-workspace access, permission checks, authentication, credential exposure, outbound requests, and execution without valid approval.

Do not submit real credentials, customer evidence, or database backups. Test only systems and accounts you are authorized to assess. Coordinate public disclosure in the private report so affected operators can receive a fix or mitigation first.

## Supported versions

Security fixes are developed on the default branch. Older snapshots do not have a separate security maintenance commitment. Deploy a reviewed commit or immutable image digest, and assess upgrades using the [upgrade guide](../docs/upgrade.md).

## Deployment responsibilities

Operators are responsible for HTTPS, protected PostgreSQL and Temporal endpoints, access control, credential storage, provider and gateway policies, and verified backups. Follow the [deployment guide](../docs/deployment.md) and [integration guide](../docs/integrations.md). Automated tests do not certify the security of an individual deployment.
