# Live SF integration tests

Tests in this folder hit a real Salesforce org. They're skipped by
default: `npm test` only runs the unit suite. To turn them on,
point the harness at an SF org alias already configured via
`sf org login`. The scratch orgs in this dev environment (`dev1`,
`dev2`, etc.) work. Avoid pointing at a real customer org; the
tests CREATE + DELETE validation rules and Account records by design.

### PowerShell (Windows)

From inside `packages/canvas/`:

```powershell
$env:RUN_SF_LIVE = "1"
$env:SF_TEST_ORG_ALIAS = "dev1"
npm run test:integration
```

From the monorepo root (note the `=` in `--workspace=...`: npm's
arg parser dislikes the space form for path-style workspace names):

```powershell
$env:RUN_SF_LIVE = "1"
$env:SF_TEST_ORG_ALIAS = "dev1"
npm run test:integration --workspace=packages/canvas
```

To clear afterwards: `Remove-Item Env:RUN_SF_LIVE, Env:SF_TEST_ORG_ALIAS`.

### Bash / zsh / Git Bash

From inside `packages/canvas/`:

```bash
RUN_SF_LIVE=1 SF_TEST_ORG_ALIAS=dev1 npm run test:integration
```

From the monorepo root:

```bash
RUN_SF_LIVE=1 SF_TEST_ORG_ALIAS=dev1 npm run test:integration --workspace=packages/canvas
```

The harness uses the `sf` CLI to fetch a current access token via
`sf org display --target-org <alias> --json`. No password / OAuth
plumbing needed: if `sf` can talk to your org, the tests can too.

## What the tests do

For each rule-pattern test (see `validation-live.test.js`):

1. **Deploy** a uniquely-named active `ValidationRule` to `Account`
   via the Tooling API. The rule's error-message is a per-test
   sentinel string so we can disambiguate it from any other rules
   the org might fire.
2. **Run the engine** (`evaluateRule(...)`) against a set of record
   values designed to make the rule fire, and assert it returns
   `'fail'`.
3. **Insert** the same values via `conn.sobject('Account').create(...)`
   and assert SF rejects with our sentinel error message.
4. **Run the engine** against values designed to pass, and assert
   it returns `'pass'`.
5. **Insert** those values and assert SF accepts (record id returned).
6. **Delete** the inserted record + the test rule, regardless of
   whether the assertions held.

Steps 2/3 verify our engine doesn't miss a fail. Steps 4/5 verify
we don't surface a false-positive "fail" on a record SF would
accept. Together they pin the contract "engine prediction ==
SF's actual verdict, for the supported rule subset."

## Cleanup

Every test wraps its SF state in try/finally so a thrown assertion
doesn't leak rules or records. Beyond that, the suite's `after`
hook does a final sweep: it looks for any `ValidationRule` on
`Account` whose name matches the test prefix (`OrgLoomTest_*`) and
deletes them. Run this if a previous test crash left rules around:

PowerShell:
```powershell
$env:RUN_SF_LIVE = "1"; $env:SF_TEST_ORG_ALIAS = "dev1"
node packages/canvas/tests/integration/cleanup.js
```

Bash:
```bash
RUN_SF_LIVE=1 SF_TEST_ORG_ALIAS=dev1 \
  node packages/canvas/tests/integration/cleanup.js
```

(`cleanup.js` is the same `after` body, callable standalone.)

## What's NOT tested

- **Cross-object rules** that resolve through related records. The
  engine supports these via `savedRecords` + `describeCache`, but
  exercising them live requires inserting both records and the
  test stays simpler if rules key on the same-record fields.
- **Unsupported formula functions** (VLOOKUP, REGEX, etc.). The
  engine returns `'unknown'`; the modal shows a neutral badge. Not
  exercised here since there's no engine prediction to compare.

The unit-test suite at `tests/validation-formula.test.js` covers the
cross-object resolution path with fully-mocked field metadata, so
that side of the engine is exercised, just not against a live SF.
