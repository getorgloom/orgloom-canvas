# Canvas platform integration

The browser runtime is shared by the hosted app, VS Code and Salesforce-native app.
Install a trusted `window.OrgLoom.platform` object before `app.js` executes.
Omitting it retains hosted behavior. Never populate it from imported JSON, record
values, query parameters or other untrusted content. These UI hooks do not replace
server-side permissions, feature grants or session ownership checks.

| Optional hook | Contract |
| --- | --- |
| `onboarding.getFlag(name)`, `onboarding.setFlag(name)` | Optional synchronous preference storage for `dismissed` and `completed` booleans. Native persists only these flags, scoped to Salesforce org/user; all canvas storage remains in memory. Omission uses the hosted localStorage keys. |
| `onboarding.completeOnFirstRecord` | Completes the guide when an actual record is added or opened. Omission retains the hosted completion-after-upload behavior. |
| `toolbar.showCanvasesMenu` | Adds the existing saved-canvases dropdown between Share and Save; omitted by default. |
| `canEdit()` | Synchronous boolean, combined with canvas role permissions before local scripts and auto-fill commit. Native checks whether its editing session has ended. |
| `migration.label`, `migration.description` | Plain text for Tools; escaped before rendering. |
| `migration.start({exportForMigration})` | Handles the menu action. Native calls the supplied export function; omission uses the hosted org-switch flow. |
| `share.buildUrl(canvasId)` | Produces the installation's canvas link; encode the ID. Omission uses the current origin and canvas path. |
| `share.searchPlaceholder`, `share.teammatePlaceholder` | Plain text matching the platform's user-search capabilities. |
| `share.notificationMessage(response)` | Returns a message, or `undefined` to retain the default email-result message. |
| `requestSequenceFloor(payload)` | Returns a positive safe integer reserving request IDs hidden from a partial saved-canvas projection. Invalid or missing results are ignored. Native interprets its existing `nativeNextSlotId` metadata here. |
| `afterRequestsSubmitted(context)` | Awaited after a successful server submission. Receives `role`, `fills`, `response`, `canvasState`, `reload()` and `render()`. Native reloads contributors; owners/editors finalize completed requests and revision state without relying on live events. |
| `clipboard.usesEvents` | Leaves ordinary copy/paste key presses to clipboard events. Shift-paste retains the shared multiple-copy prompt. |
| `clipboard.mount(context)` | Called once after canvas bootstrap with state, permission predicate, record commit, render, toast, graph/canvas getters and card copy/paste callbacks. |

## Shared module contracts

`bulkScript.mount` and `bulkAutofill.mount` accept optional `canCommit()`.
Both also capture the starting canvas and record collection, and refuse to apply
delayed work if either changes. The normal application supplies its role checks
combined with the platform editing-session predicate.

`soqlImport.mount` exposes `commitRecords(result, options)` for trusted adapters.
It uses the normal import cap, de-duplication, association and layout path.
`options.canCommit()` is rechecked after asynchronous metadata selection and
before record insertion. Callers must validate source org, permissions and
payloads through their backend; this method is not an authorization boundary.

The editor preserves UI API dependent-picklist controller indexes by record type.
That is shared metadata normalization, not a Salesforce-native build patch.

## Updating consumers

Change the authoritative `packages/canvas` source and run its tests. From the
integration repository, explicitly export the reviewed runtime inventory:

```text
node tools/canvas-runtime/export.mjs <consumer-repository>
```

The exporter records the base commit, working-tree status and SHA-256 hashes. A
working-tree snapshot is a development build, not a published release. After
committing the source, re-export for a clean release pin. The existing public
canvas publication process remains separate.

Consumers verify hashes and package shared assets unchanged. Salesforce builds
still generate Visualforce URLs and a Static Resource; VS Code builds still
generate a webview script list. Neither should rewrite shared JavaScript.
