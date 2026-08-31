import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateControllerIdentityHistory } from "../dist/src/identity-history.js";
import { digestJson } from "../dist/src/util.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const path = resolve(root, "contracts/controller-identity-history.json");
const current = JSON.parse(readFileSync(path, "utf8"));
const { digest: _digest, ...body } = current;
const generated = { ...body, digest: `sha256:${digestJson(body)}` };
validateControllerIdentityHistory(generated);
const expected = `${JSON.stringify(generated, null, 2)}\n`;
if (process.argv.slice(2).includes("--write")) writeFileSync(path, expected, "utf8");
else if (readFileSync(path, "utf8") !== expected) {
  process.stderr.write("Controller identity history is stale; run npm run history:generate\n");
  process.exitCode = 1;
}
