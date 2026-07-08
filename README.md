# Org Loom Canvas

A canvas for staging Salesforce records: load existing data, edit it, generate new records with AI, upload back to Salesforce.

**Source-available under the PolyForm Internal Use License 1.0.0.** You can read, audit, modify, and run the source for your company's own internal business purposes. You may not provide it to anyone outside your company — no managed-service hosting, no consulting use, no redistribution to third parties. There is no auto-conversion to an OSI-approved open source license. See [`LICENSE`](./LICENSE).

This package is published so customers, prospects, and their security teams can read the code behind the hosted service at [orgloom.com](https://orgloom.com). **It is not packaged as a turnkey self-host distribution.** The supported product is the hosted one.

## What's in this package

- Canvas UI + API ([`canvas-routes.js`](./src/canvas-routes.js), views, public assets)
- Salesforce integration: OAuth, describe, SOQL, Composite Graph upload, Tooling-API validation-rule engine
- Record-staging mechanics: drag/drop, fill, bulk-edit, run-script, AI generate, upload-recall
- MCP server endpoint for AI clients
- Storage layer: canvas state stored as a JSON file (`ContentVersion`) in the customer's SF org, shared via `ContentDocumentLink`
- Plug-point registry ([`extensions.js`](./src/extensions.js)) that the closed saas layer registers against at boot — auth, capability resolver, quota, audit sink, DB provider, etc.
- Database schemas (migrations under [`src/database/migrations/`](./src/database/migrations/)) and store modules — all the SQL that touches accounts, sessions, audit log, connections, MCP tokens, upload batches, AI proposals

## What's NOT in this package

The hosted SaaS (orgloom.com) adds these on top; they live in a closed package and are not redistributable.

- **Database init layer** (Kysely setup, dialect selection, WAL pragmas, migration runner). Canvas's [`server.js`](./src/server.js) requires a DB provider to be registered before it boots — see "Running it yourself" below.
- Multi-user accounts + workspaces — signup, invite, member roles, admin promotion/demotion, pending-join approval queue, soft-delete + restore
- Email magic-link + SSO sign-in (Google, Microsoft)
- Workspace-level policy and feature flags — production-org approval gate, script-runner toggle, bulk-delete, duplicate-rule bypass, AI-on-real-data, MCP human-review, email-domain restrictions
- Tamper-evident audit chain retention + verification sweep
- Stripe billing + plan-based quotas
- Managed updates, backups, uptime SLA, security incident response

If you need any of those, see [orgloom.com](https://orgloom.com).

## Running it yourself (advanced, unsupported)

[`src/server.js`](./src/server.js) does not boot standalone. The Kysely init that used to live here moved out so the open-source surface stays auditable (you can read every query the canvas runs) without doubling as a turnkey install. To run it, you need a small wrapper that opens a database, runs the migrations in [`src/database/migrations/`](./src/database/migrations/), and registers the result against the plug-point registry — for example:

```js
// my-bootstrap.js
import { Kysely, SqliteDialect, Migrator } from 'kysely';
import Database from 'better-sqlite3';
import { ext } from 'orgloom-canvas/extensions';
import { canvasMigrationsDir } from 'orgloom-canvas/database/index';
// ...read canvasMigrationsDir, build a Migrator, migrateToLatest()...

const sqlite = new Database('./data/orgloom.db');
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
// ...run migrations against db...

ext.registerDbProvider(() => db);
ext.registerRawClientProvider(() => ({ dialect: 'sqlite', client: sqlite }));

await import('orgloom-canvas/server');
```

The schemas under `src/database/migrations/` are auditable: every table, column, index, and constraint that canvas creates is in there. The store modules in [`src/database/`](./src/database/) are the only code that runs SQL against them.

The `Dockerfile`, `docker-compose.yml`, and `render.yaml` in this repo are leftovers from before this split — they reference the old self-bootable path and are no longer kept in sync. They may be removed in a future release.

We do not provide installation help, do not respond to self-host issues, and do not maintain compatibility with self-host wrappers across releases.

## Salesforce External Client App (applies to any self-host attempt)

You need to register Org Loom Canvas as an **External Client App** in **some** Salesforce org. This org doesn't have to be the one you're loading data into — it's just where OAuth credentials live. (Users of the hosted product at orgloom.com don't do this; they connect to the orgloom.com app.)

> Salesforce renamed "Connected Apps" to "External Client Apps" in Summer '24. New apps are created via **External Client App Manager**; the legacy **App Manager** page still exists for managing pre-Summer-'24 Connected Apps but no longer accepts new creation in most orgs. The OAuth flow is the same either way.

1. Log into a Salesforce org. **Setup** → **External Client App Manager** → **New External Client App**.
2. Fill in:
   - **External Client App Name**: `Org Loom Canvas (Self-hosted)`
   - **API Name**: `Org_Loom_Canvas_Self_Hosted`
   - **Contact Email**: yours
   - **Distribution State**: `Local` (single-org install)
3. Check **Enable OAuth**. In the new External Client App UI the OAuth settings live under *API (Enable OAuth Settings)* on the app's Settings tab.
4. **Callback URL**: `http://localhost:3000/auth/callback` (change the port if you set a different `PORT`).
5. **OAuth Scopes**: add
   - `Manage user data via APIs (api)`
   - `Perform requests at any time (refresh_token, offline_access)`
6. Uncheck **Require Proof Key for Code Exchange (PKCE)** if it's on by default. Org Loom Canvas uses the standard OAuth2 web flow with client secret.
7. Click **Create** (or **Save** in the legacy UI). External Client Apps come up with policies disabled by default — open the app, go to **Policies**, and set *OAuth Policies → Permitted Users* to **All users may self-authorize** (or pre-authorize specific users). Save.
8. Wait ~10 minutes for SF to propagate the change (this is a SF-side delay, nothing you can speed up).
9. Open the External Client App's **Settings → OAuth Settings → App Settings** → click **Consumer Key and Secret → Manage Consumer Details** (you may be asked to re-verify your identity). Copy the **Consumer Key** and **Consumer Secret**.
10. Paste them into `.env` as `SF_CLIENT_ID` and `SF_CLIENT_SECRET`. Restart the server.

## AI Generate (optional)

To enable AI-powered record generation:

1. Get an Anthropic API key from [console.anthropic.com](https://console.anthropic.com).
2. Set it in `.env` as `ANTHROPIC_API_KEY`.
3. Restart the server.

You pay Anthropic directly. There are no caps in self-host mode — Anthropic's spend limits are your only ceiling.

## Running on the network (LAN, not just localhost)

Canvas binds to all interfaces but is intended for `localhost` use. **No Salesforce credentials are persisted** — refresh tokens are not requested, and the short-lived access token lives only in the active server-side session. What IS persisted in the local DB and would be exposed by LAN access:

- The single local account's identity (email, display name) and which SF orgs you've connected (org IDs, usernames, instance URLs — metadata, not tokens).
- Canvas state, upload history, audit log, AI proposals.
- MCP bearer-token hashes (plaintext never stored; revoke from the workspace UI).

The real risk on an untrusted LAN isn't credential theft — it's the single-account model: anyone reaching the server can OAuth in and end up acting as the same local account (shared canvases, shared audit log, ability to connect *their* SF orgs to your account).

To intentionally expose to a trusted LAN, set `ORGLOOM_TRUST_NETWORK=1` and add a single shared password via `ORGLOOM_PASSWORD`. **Do not expose Org Loom Canvas to the public internet without putting it behind your own auth proxy.**

## No phone-home

Self-hosted instances do not send telemetry, analytics, or heartbeats. The server makes no outbound connections except to your Salesforce org (the user's own connection) and, if you've configured them, the optional integrations you opted into (Anthropic for AI generation, PostHog for product analytics, Stripe for billing on the SaaS build).

## File layout

```
src/
├── canvas-routes.js    # all canvas API + page routes
├── server.js           # entry point (requires a DB provider registered before import; see above)
├── extensions.js       # plug-point registry (auth, capability, quota, audit, DB providers)
├── ai-plan.js          # AI generation
├── sf-*.js             # SF API wrappers (connection, describe, upload, bulk, soql, validation-rules, ...)
├── upload-recall.js    # undo-upload
├── validation-formula.js  # SF validation-rule formula engine
├── database/           # schemas (migrations/) + store modules (queries); Kysely init lives in the closed saas package
├── storage/            # canvas persistence (SF Files / ContentVersion)
├── mcp/                # MCP server for AI clients
├── views/              # EJS templates (canvas pages + walkthroughs)
└── public/             # frontend JS, CSS, images
```

## Contributing

PRs that improve the canvas — bug fixes, documentation, walkthrough improvements, SF integration polish — are welcome. New features that overlap with the hosted SaaS (multi-user, billing, etc.) belong in a separate fork. Open an issue before non-trivial changes.

## License

[PolyForm Internal Use License 1.0.0](./LICENSE). Use it for your company's own internal business purposes. Cannot be provided to third parties — no managed-service hosting, no consulting use, no redistribution. Source-available indefinitely — no automatic conversion to an OSS license.
