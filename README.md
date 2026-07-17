# Org Loom Canvas

Org Loom Canvas is the public canvas at the center of [Org Loom](https://orgloom.com), a workspace for exploring Salesforce schemas and preparing data changes before they are sent to Salesforce.

The canvas brings existing records, drafts, and relationships into one visual workspace. It includes the Salesforce integration and browser interface used to import, edit, validate, upload, and recall record changes.

This repository contains the canvas portion of Org Loom. Hosted account, workspace, billing, and administration features are maintained separately.

## Contributing

Contributions that make the canvas safer, clearer, or more useful are welcome. Good contributions include:

- Reproducible bug fixes
- Salesforce API, schema, and field-type compatibility improvements
- Tests for data integrity and edge cases
- Accessibility, performance, and focused interface improvements
- Documentation corrections

For a substantial feature, data-model change, or architectural change, open an issue before writing the implementation. This helps confirm that the proposal belongs in the public canvas and avoids duplicated work.

Pull requests should be focused and include:

- A clear explanation of the problem and intended behavior
- Tests for functional changes
- Reproduction or verification steps
- Screenshots or a short recording for visible interface changes

The public repository is the contribution surface and a maintained source repository. Accepted public changes are brought into the hosted Org Loom application through a reviewed integration pull request. Contributors do not need access to the private application repository.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contribution guide.

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

Org Loom Canvas is source-available under the [PolyForm Internal Use License 1.0.0](./LICENSE). The license permits noncommercial purposes, personal uses, and internal business use by a single company, subject to its full terms.

Contributions are licensed under the same terms. The full [LICENSE](./LICENSE) controls if this summary and the license differ.
