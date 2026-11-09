# Intent

**The AI-native CRM. Understand intent. Move business forward.**

[Website](https://zerothlab.github.io/intent-crm-website/) · [v0.4.0-rc.1 prerelease](https://github.com/ZerothLab/intent-crm/releases/tag/v0.4.0-rc.1) · [Docker Hub](https://hub.docker.com/r/zerothlab/intent-crm)

Intent turns customer evidence into reviewable next steps, then connects approved work to verifiable outcomes. Its assistant keeps private conversation history, cites customer sources, and helps people decide what to do next. Business changes remain explicit, permission-checked commands.

## See Intent in action

[![Watch the Intent product overview (1:18)](https://zerothlab.github.io/intent-crm-website/assets/videos/overview-poster.jpg)](https://zerothlab.github.io/intent-crm-website/#product-demo)

[Watch the product overview (1:18)](https://zerothlab.github.io/intent-crm-website/#product-demo) · [Getting-started tutorial (2:55)](https://zerothlab.github.io/intent-crm-website/#tutorial)

Both videos offer English and Simplified Chinese narration and captions on the website. Actual application footage uses fictional data, the Fixture model, and simulated delivery.

## From evidence to outcomes

1. Create a customer and import meeting notes, correspondence, or customer feedback.
2. Review extracted facts against their original quotes.
3. Ask the assistant for a grounded recommendation, or prepare a next-step proposal for an opportunity.
4. Edit, approve, dismiss, or cancel the exact proposal under review.
5. Follow delivery receipts, customer replies, tasks, contracts, and net collections back into the customer record.

A delivered message is evidence of delivery. Customer consent, a signed contract, and payment are separate business records.

## Capabilities

- **Model management:** configure DeepSeek or a custom OpenAI-compatible Chat Completions endpoint, test the saved configuration, and activate a model for reasoning or extraction. Credentials are encrypted and never returned to the browser. A clearly labeled Fixture demo provider remains available.
- **Grounded assistance:** private, persisted conversations; exact evidence citations; retained human fact reviews; current customer outcomes; prior proposal decisions; links to the relevant review screens.
- **Daily workbench:** visible model readiness, candidate facts awaiting verification, proposed actions, assigned tasks, recovery work, and next-step guidance based on authorized records.
- **Controlled execution:** approvals bind exact revisions. Changes to content, access, contacts, or delivery settings invalidate execution authority. Unknown delivery outcomes block automatic redispatch.
- **Customer continuity:** transfer customers with open opportunities, tasks, and pending work in one transaction. Managers can take over a draft after its original initiator leaves.
- **Commercial operations:** opportunity stages and forecasts, targets, immutable forecast snapshots, intervention tasks, signed contracts, installment schedules, payments, partial refunds, and evidence-backed corrections.
- **Delivery integration:** an authenticated delivery gateway with stable operation IDs, signed delivery events, and deduplicated customer replies that enter the next evidence cycle.
- **Administration:** workspace settings, four built-in roles, versioned member management, session revocation, administrator audit history, custom fields, execution diagnostics, and recovery of stalled planning.
- **English and Chinese:** English is the default. Switch to Simplified Chinese from the sign-in screen or top bar; the preference persists. Source evidence and customer-entered text retain their original language.

## Get started

Intent is self-hosted. You will need Docker Engine and Compose v2, a persistent Temporal service, and an HTTPS reverse proxy. PostgreSQL 16 is included in the production Compose configuration.

Start with **v0.4.0-rc.1**, a release candidate for evaluation, and its published application image. The image supports `linux/amd64` and `linux/arm64`:

```sh
git clone --branch v0.4.0-rc.1 --depth 1 https://github.com/ZerothLab/intent-crm.git
cd intent-crm
docker pull zerothlab/intent-crm:0.4.0-rc.1
```

Follow the [deployment guide](docs/deployment.md) to configure the installation and initialize an administrator. Set `INTENT_IMAGE=zerothlab/intent-crm:0.4.0-rc.1` in `.env.docker`; the guide also provides an immutable digest and an optional source-build path. A production installation needs the Temporal endpoint and HTTPS origin described in that guide. Then use the [product guide](docs/product-guide.md) to configure the workspace and complete a customer workflow.

Model setup is available at **Manage → Model settings**. Review role permissions and security changes at **Manage → Access and audit**. Customer delivery and execution health are at **Manage → Delivery and runtime**. The [integration guide](docs/integrations.md) describes provider configuration and the gateway contract. Existing installations should follow the [upgrade guide](docs/upgrade.md).

## Deployment scope

Intent is designed for private deployment with PostgreSQL, a persistent Temporal service, and a same-origin HTTPS endpoint. Each workspace has its own members, business records, model settings, and delivery configuration.

New workspaces start with a deterministic demo model and simulated delivery. External inference and customer delivery require administrator configuration. Contract, payment, and refund entries record business events; Intent does not initiate bank transfers or perform revenue recognition. Currency is currently CNY, and business dates use Asia/Shanghai regardless of interface language.

The application includes password authentication and administrator-managed accounts. SSO, MFA, invitation emails, password recovery emails, bank synchronization, and SaaS billing are not included. Deployment operators must validate their provider, gateway, backup restoration, network controls, and workload before handling live customer traffic.

## Community

Bug reports, product feedback, documentation improvements, and focused pull requests are welcome. Read the [contribution guidelines](.github/CONTRIBUTING.md) and [code of conduct](.github/CODE_OF_CONDUCT.md) before participating.

Use the [support guide](.github/SUPPORT.md) for questions and troubleshooting. Report vulnerabilities privately using the [security policy](.github/SECURITY.md); do not include credentials or customer data in public issues.

## License

Intent is licensed under the [Apache License 2.0](LICENSE).
