# Org Loom Canvas

Org Loom Canvas is the source-available canvas core at the center of [Org Loom](https://orgloom.com), a workspace for exploring Salesforce schemas and preparing data changes before they are sent to Salesforce.

The canvas brings existing records, drafts, and relationships into one visual workspace. It includes the Salesforce integration and browser interface used to import, edit, validate, upload, and recall record changes.

This repository contains the canvas portion of Org Loom. Hosted account, workspace, billing, and administration features are maintained separately.

## Feedback and source publication

Development happens in Org Loom's private integration repository. Reviewed
versions of the complete canvas directory are then published here without
removing comments or rewriting the source. This repository is therefore a
downstream source publication, not the canonical development repository.

GitHub Issues are welcome for reproducible bugs, Salesforce compatibility
problems, documentation errors, and focused feature suggestions. Public pull
requests are not imported into the hosted application and are not currently
accepted. When an issue leads to a change, that change is implemented and
reviewed in the canonical repository before a new exact-source version is
published here.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the issue and repository policy.

## Development

You will need Node.js 24 or later. A Salesforce org is needed for workflows that exercise the live Salesforce integration.

```bash
git clone https://github.com/getorgloom/orgloom-canvas.git
cd orgloom-canvas
npm install
cp .env.example .env
npm test
npm run dev
```

The comments in [`.env.example`](./.env.example) describe the development configuration. Never include credentials, access tokens, customer data, or Salesforce record data in an issue, fixture, or pull request.

## Issues and security

Use [GitHub Issues](https://github.com/getorgloom/orgloom-canvas/issues) for bugs and focused feature proposals. Include the expected behavior, actual behavior, and the smallest useful reproduction.

Report suspected vulnerabilities privately to [security@orgloom.com](mailto:security@orgloom.com). Do not open a public issue for a security report. See [SECURITY.md](./SECURITY.md) for the reporting policy.

## License

Org Loom Canvas is source-available under the [PolyForm Internal Use License 1.0.0](./LICENSE). It is not distributed under an OSI-approved open-source license. Review the full license before using or modifying the code.

The full [LICENSE](./LICENSE) controls if this summary and the license differ.
