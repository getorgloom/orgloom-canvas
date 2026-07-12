# Changelog

All notable changes to Org Loom Canvas will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **First public release** of the source-available canvas, split out from the closed-source Org Loom monorepo under the PolyForm Internal Use License 1.0.0.
- First-boot setup wizard at `/setup`, which guides through Salesforce Connected App creation, paste-in form for credentials, writes them to `.env`.
- Docker support: `Dockerfile`, `docker-compose.yml`, `.dockerignore`. One-command self-host via `docker compose up -d`.
- Render Blueprint (`render.yaml`) for one-click hosted self-host.
- Canvas-standalone entry at `src/server.js`: fully self-contained, no SaaS-side dependencies required at runtime.
- Conditional saas-route registration: routes that only exist in the hosted SaaS (workspaces, billing, multi-user audit) 404 cleanly in the standalone build.
- Plug-point registry (`src/extensions.js`): 8 providers + 6 registration queues let the hosted SaaS extend canvas behavior without canvas knowing anything about it.

### Carried over from the closed-source monorepo

These were already real features before the split; calling them out so the open-core feature set is clear:

- Records canvas (drag/drop, edit, fill, bulk-edit, run-script).
- Schema view with self-referencing FKs, polymorphic lookups, junction objects, master-detail.
- CSV import (auto-mapping, multi-file linking by value).
- SOQL import (read-only SELECT, child subqueries, 500-row cap).
- Quick Upload (CSV → SF directly, no canvas staging).
- AI Generate (Claude Sonnet 4.6, schema-aware, FK-aware, BYO Anthropic key).
- Upload pipeline (topological sort, Composite Graph, atomic groups, preflight).
- Recall an upload (delete records the upload created, leave updates in place).
- Multi-org support (multiple SF connections per account, switchable).
- Save/load canvases to your own SF org as a custom object.
- MCP server endpoint for Claude/Cursor/ChatGPT access.
- 28 walkthroughs in `/docs/walkthroughs/`.

## Versioning

Once we publish 0.1.0 as the first tagged release, subsequent versions follow semver:
- **MAJOR** bumps signal incompatible API or behavior changes.
- **MINOR** bumps add features in a backwards-compatible way.
- **PATCH** bumps are bug fixes.

Until 1.0.0, MINOR bumps may include breaking changes, a common practice for pre-1.0 projects. We'll call them out explicitly in this changelog.

## License

Source-available under the [PolyForm Internal Use License 1.0.0](./LICENSE). The license terms are stable: no automatic conversion to an OSI-approved open source license. You may read, audit, modify, and run the source for your company's own internal business purposes. You may not provide it to anyone outside your company: no managed-service hosting, no consulting use, no redistribution.
