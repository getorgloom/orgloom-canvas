# Org Loom managed package source

This directory contains the Salesforce managed package source alongside the
canvas source for review: Apex classes and tests, triggers, object and field
definitions, permission sets, and external client app metadata.

Development and package builds use `orgloom-package/` in Org Loom's private
integration repository. This directory is a publication copy, not a separate
development project. Its source files and comments are copied unchanged and
published through the same source snapshots as the canvas.

## Contents

- `force-app/`: Salesforce metadata and Apex, including tests.
- `sfdx-project.json`: namespace, package configuration, and package aliases.
- `.forceignore`: packaging exclusions. In particular, the smoke-test
  permission set is present for review but excluded from package builds.
- `config/project-scratch-def.json`: development scratch-org configuration.

Local authentication state, generated builds, install reports, and seed data
are not included. A canvas source tag identifies this source snapshot; it does
not by itself establish which source built a customer's installed package.
The package aliases are not a source-to-release attestation.

The copy uses the canvas repository's [license](../LICENSE),
[contribution policy](../CONTRIBUTING.md), and [security reporting policy](../SECURITY.md).
