# Feedback for Org Loom Canvas

Org Loom Canvas is a source-available publication of the canvas code used by
the hosted Org Loom application. The private Org Loom integration repository
is canonical, and reviewed canvas versions are published here afterward as an
exact source subtree.

## Issues are welcome

Open a GitHub issue for:

- a reproducible bug;
- a Salesforce API, schema, object, or field-type compatibility problem;
- an accessibility or performance problem;
- a documentation correction; or
- a focused feature suggestion.

Include expected behavior, actual behavior, the smallest useful reproduction,
and relevant logs with credentials, tokens, org IDs, and customer data
removed. For a visible interface problem, a screenshot or short recording is
helpful.

Security issues must be reported privately to
[security@orgloom.com](mailto:security@orgloom.com), not through a public
issue. See [SECURITY.md](./SECURITY.md).

## Pull requests

Public pull requests are not currently accepted. Commits in this repository
do not flow back into the hosted product automatically and direct changes to
public `main` would break the exact-source publication history. If an issue is
accepted, Org Loom will implement and review the change in the canonical
repository and publish the resulting canvas source here.

## Local review and testing

You can inspect and test the published source under the terms of the license:

```bash
git clone https://github.com/getorgloom/orgloom-canvas.git
cd orgloom-canvas
npm install
cp .env.example .env
npm test
```

Node.js 24 or later is required. Live Salesforce workflows require an
appropriate Salesforce org and External Client App configuration.

## License

Org Loom Canvas is source-available under the
[PolyForm Internal Use License 1.0.0](./LICENSE), not an OSI-approved
open-source license. The full license controls all use and modification of the
published code.
