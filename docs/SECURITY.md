# Security boundary

Repository bytes, Issue/Planner strings, validation/CI output, and model results are untrusted data. Prompts keep them in one bounded digest envelope; model output never grants Git, GitHub, validation, retry, or merge authority.

Every Codex run is fresh and ephemeral with approvals `never`, fixed models/reasoning, ignored user config/rules, empty MCP/hooks/plugins, no extra writable roots, a closed environment, and network disabled. These runtime restrictions remain enforced locally even though executable byte/path identity is no longer exported across repositories.

Authoritative validation runs in disposable exact-candidate projections with isolated HOME/TMP/cache. TMP is a private command-scoped runtime sibling outside the candidate root, so repository validation can independently deny reads outside its own root; bootstrap and its semantic command share only that command runtime, while commands, Jobs, and repositories never share temporary state. An optional Controller-private dependency bootstrap reruns inside every projection and may use only its configured network policy; the semantic validation command always runs afterward under a fresh network-denied policy. Neither phase inherits host environment, npm user config, Controller state, or credentials. Ignored Worker state is absent; new or changed links, devices, FIFOs, and sockets are rejected. Output is bounded and process groups are terminated on timeout or overflow. Candidate bytes, mode, type, and link count are verified after bootstrap and again after validation; either drift fails closed in Receipt v4 before the projection and its command runtime are destroyed.

Config v4 retains exact remote binding and app/workflow-bound required checks. Controller-owned exact-head auto-merge is the only merge authority. Revocation verifies the PR, disables auto-merge, and quarantines only the exact unchanged remote head with compare-and-swap semantics.

Private logs/state are bounded regular files. Public `review.md` omits private paths and secrets. Public `release-result:v1` contains only semantic release and verified delivery facts; it is not a cryptographic proof or a Controller build attestation.

The design does not claim containment against a malicious operator with the Controller OS account, a compromised kernel, or compromised local Controller/Codex/sandbox executables.
