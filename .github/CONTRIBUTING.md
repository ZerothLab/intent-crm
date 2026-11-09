# Contributing to Intent

Thank you for helping improve Intent. Useful contributions include reproducible bug reports, clearer documentation, accessibility improvements, translations, and focused fixes.

## Before opening a change

- Search existing issues and pull requests for related work.
- Use an issue to explain substantial behavior changes before implementing them. Include the user problem, an example workflow, and the expected outcome.
- Keep a pull request focused on one problem. Separate unrelated formatting or dependency updates.
- Use fictional records and example addresses. Never include credentials, customer evidence, personal data, database dumps, or local environment files.

## Pull requests

Explain the problem, the resulting behavior, and how the change was verified. Include relevant screenshots for interface changes, with private information removed. Report checks that were skipped and why; a skipped integration test does not establish that the integration works.

Changes must preserve tenant isolation, role permissions, evidence attribution, revision-bound approval, and safe handling of uncertain delivery outcomes. A fix affecting these behaviors needs a regression test. Existing database migrations must remain unchanged; schema changes require a new migration and an upgrade plan that preserves data.

Public documentation and interface text use English by default, with Simplified Chinese translations where supported. Keep original customer evidence verbatim. Label the Fixture provider and simulated delivery accurately.

Maintainers review scope, correctness, compatibility, security, and validation before merging. An issue or pull request is not a commitment to accept a feature or provide a release date.

## Reporting problems

Use the repository's issue templates for bugs and feature requests. For usage questions, start with the [support guide](SUPPORT.md). For vulnerabilities, follow the [security policy](SECURITY.md) instead of opening a public issue.

All participation follows the [code of conduct](CODE_OF_CONDUCT.md).
