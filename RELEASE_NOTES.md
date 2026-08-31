# 0.2 breaking contract release

- Added dynamic `review.md`, shared PR-body rendering, and optional isolated Review Demo.
- Kept one serial fresh-Worker delivery path with Controller-owned baseline, validation, aggregate review, PR, required CI, exact-head auto-merge, and merge verification.
- Replaced exact Controller build coupling with semantic `controllerContractVersion: 1` and `start --approve-plan <planDigest>`.
- Added concise `release-result:v1`.
- Removed Dispatcher, Plan v1/v2 execution compatibility, manual merge, legacy counters, Completion v1-v3, Controller provenance, runtime lock, executable identity, trust history, and multi-version Job/config readers.

Compatibility cutoff: new Jobs accept only the semantic Plan contract and export only Result v1. Historical artifacts are not runtime inputs.
