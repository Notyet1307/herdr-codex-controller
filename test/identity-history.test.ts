import assert from "node:assert/strict";
import test from "node:test";
import { appendQualifiedControllerIdentity, readControllerIdentityHistory, requireHistoricallyTrustedController, validateControllerIdentityHistory } from "../src/identity-history.js";
import { digestJson } from "../src/util.js";

test("historical Controller trust is append-only, schema-bound, and revocable", () => {
  const history = readControllerIdentityHistory();
  const trusted = history.entries[0]!;
  assert.equal(requireHistoricallyTrustedController(trusted.identity, history).identity.digest, trusted.identity.digest);

  const revoked = structuredClone(history);
  revoked.entries[0]!.revocation = { revokedAt: "2026-08-31T05:00:00.000Z", reason: "qualification withdrawn" };
  const { digest: _revokedDigest, ...revokedBody } = revoked;
  revoked.digest = `sha256:${digestJson(revokedBody)}`;
  assert.throws(
    () => requireHistoricallyTrustedController(trusted.identity, validateControllerIdentityHistory(revoked)),
    (error: any) => error?.code === "controller_identity_revoked",
  );

  const unknown = structuredClone(trusted.identity);
  unknown.sourceRevision = "f".repeat(40);
  const { digest: _unknownDigest, ...unknownBody } = unknown;
  unknown.digest = digestJson(unknownBody);
  assert.throws(
    () => requireHistoricallyTrustedController(unknown, history),
    (error: any) => error?.code === "controller_identity_unknown",
  );
  const outgoing = {
    identity: unknown,
    ownedSchemas: trusted.ownedSchemas,
    qualificationStatus: "qualified" as const,
    activatedAt: "2026-09-01T00:00:00.000Z",
    revocation: null,
  };
  const upgraded = appendQualifiedControllerIdentity(history, outgoing);
  assert.equal(requireHistoricallyTrustedController(unknown, upgraded).identity.digest, unknown.digest);
  assert.equal(history.entries.length, 1);

  for (const mutate of [
    (value: any) => { value.digestAlgorithm = "locale-dependent"; },
    (value: any) => { value.entries[0].ownedSchemas[0].sha256 = `sha256:${"0".repeat(64)}`; },
  ]) {
    const drifted = structuredClone(history) as any;
    mutate(drifted);
    assert.throws(() => validateControllerIdentityHistory(drifted), /digest|algorithm|header/iu);
  }
});
