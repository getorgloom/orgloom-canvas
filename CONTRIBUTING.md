# Contributing to Org Loom Canvas

Welcome, and thanks for considering a contribution. This is a short guide to how we work and what kinds of changes land easily versus need more discussion.

## What kinds of changes we accept

**Easy yeses:**
- Bug fixes (with a clear reproduction).
- Salesforce API compatibility updates (new field types, new SObject metadata, etc.).
- Documentation improvements: README, walkthroughs, code comments.
- New walkthroughs for features that ship in the canvas but aren't covered yet.
- Tests, especially around edge cases in upload, CSV import, AI plan validation, and the OAuth lifecycle.
- Self-host UX improvements: setup wizard polish, better error messages, faster boot, smaller Docker images.
- Performance fixes that don't change behavior.

**Discuss first (open an issue):**
- New features in the canvas itself. We want to keep the open core focused; sprawl is the enemy. If you're not sure whether a feature belongs in the open canvas or in the hosted Org Loom product, ask.
- Changes to the plug-point registry (`src/extensions.js`). The interface is load-bearing for the open-core split; design changes need a conversation.
- Schema changes (new migrations, new tables). We add these conservatively because they're hard to undo.
- Anything that touches the canvas's frontend (`src/public/js/app.js`) significantly: it's 24k lines of carefully-tuned UI code; small fixes welcome, redesigns need discussion.

**Hard nos:**
- Features that duplicate what the hosted product offers (multi-user workspaces, billing, audit retention, SSO). These belong in the hosted product, not the source-available core. The PolyForm Internal Use License also restricts use of this software to internal company purposes: providing it to third parties (managed service, consulting use, redistribution) is not permitted.
- Telemetry / phone-home additions. Self-hosted Org Loom makes no outbound connections other than to the user's Salesforce org and the optional integrations they explicitly configure.
- Changes that require a separate paid service (cloud-only deps, proprietary APIs, etc.).

## How to set up

```bash
git clone https://github.com/getorgloom/orgloom-canvas.git
cd orgloom-canvas
npm install
cp .env.example .env
# Fill in SF_CLIENT_ID + SF_CLIENT_SECRET (see README.md), then:
npm run dev
```

The dev server hot-reloads on file changes (`node --watch`). Visit [http://localhost:3000](http://localhost:3000).

If you don't have a Salesforce External Client App yet (the Summer-'24 successor to Connected Apps), the setup wizard at `/setup` walks you through creating one.

## Testing

```bash
npm test
```

The unit suite covers the extension contracts, Salesforce query and upload
boundaries, canvas persistence, recall, validation formulas, CSV handling, and
the browser-side helpers that can be exercised without a live org. New tests
are especially welcome around:

- `sf-upload.js` topological sort + composite graph
- `upload-recall.js` cascade detection
- `ai-plan.js` validation (rejecting AI hallucinations against the SF describe)
- `slot-helpers.js` slot-fill logic

## Code style

- ESM modules (`import`/`export`); no CommonJS.
- Async/await over callbacks.
- Avoid adding new dependencies casually: every dep is a future supply-chain decision. If you need to add one, mention why in the PR description.
- Comments explain *why*, not *what*. The code already says what it does.
- One file per concept. We'd rather have 10 short files than 1 sprawling one.

## PR process

The public `orgloom-canvas` repository is the contribution surface and a
maintained source repository. It is not a generated mirror. A merged public
change is imported into the private hosted-app integration repository through
a reviewed subtree pull request before it is deployed. Contributors never
need access to the private repository, and a later Org Loom sync will not
overwrite public commits.

1. Open an issue first if the change is non-trivial (more than 50 lines, new feature, schema change). Saves both sides the back-and-forth.
2. Branch from `main`. Name the branch something descriptive (`fix-soql-empty-result`, `add-bulk-edit-find-replace`).
3. Keep PRs focused. One concept per PR: separate bug fixes from feature work.
4. Keep useful comments. Comments should explain constraints, security boundaries, or non-obvious decisions. Do not include secrets, customer data, or internal incident details.
5. Run `npm test` locally. CI will run it again.
6. In the PR description, include:
   - What changed and why
   - How to verify (browser steps, curl commands, screenshots if UI)
   - Anything reviewers should pay particular attention to

## Reporting bugs

Open an issue with:
- Org Loom Canvas version (run `npm ls orgloom-canvas`)
- Node version (`node --version`)
- OS + Docker version if using Docker
- Exact steps to reproduce
- Expected vs. actual behavior
- Relevant log output (redact any tokens / org IDs)

Security issues: please email security@orgloom.com instead of opening a public issue. See [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the same license as the project (PolyForm Internal Use License 1.0.0). See [`LICENSE`](./LICENSE).

## Code of conduct

Be kind. Be specific. Assume good faith. We don't have a formal CoC because we're small enough that being decent works fine. If we grow to where one is needed, we'll add one. In the meantime: behave like you would in a colleague's office.
