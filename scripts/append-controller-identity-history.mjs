import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendQualifiedControllerIdentity, readControllerIdentityHistory } from "../dist/src/identity-history.js";
import { sha256 } from "../dist/src/util.js";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || !args[index + 1]) throw new Error(`--${name} is required`);
  return args[index + 1];
};
const controllerRoot = realpathSync(resolve(option("controller-root")));
const activatedAt = new Date(option("activated-at")).toISOString();
if (!lstatSync(controllerRoot).isDirectory()) throw new Error("Controller root is not a directory");
const status = spawnSync("git", ["-C", controllerRoot, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
if (status.status !== 0 || String(status.stdout).trim()) throw new Error("outgoing Controller checkout must be exact and clean");
const identityResult = spawnSync(process.execPath, [
  "--input-type=module", "-e",
  "import {readControllerIdentity} from './dist/src/provenance.js';process.stdout.write(JSON.stringify(readControllerIdentity()))",
], { cwd: controllerRoot, encoding: "utf8" });
if (identityResult.status !== 0) throw new Error(`outgoing Controller identity is unavailable: ${identityResult.stderr}`);
const identity = JSON.parse(identityResult.stdout);
const completionSchema = JSON.parse(readFileSync(resolve(controllerRoot, "schemas/release-completion-v3.schema.json"), "utf8"));
const configSchema = JSON.parse(readFileSync(resolve(controllerRoot, "schemas/controller-config.schema.json"), "utf8"));
const configVersion = Math.max(...configSchema.properties.version.enum);
const ownedSchemas = [
  { schema: completionSchema.properties.schema.const, path: "schemas/release-completion-v3.schema.json" },
  { schema: "herdr-codex-controller:release-plan:v2", path: "schemas/release-plan-v2.schema.json" },
  { schema: `herdr-codex-controller:config:v${configVersion}`, path: "schemas/controller-config.schema.json" },
].map(({ schema, path }) => ({ schema, sha256: `sha256:${sha256(readFileSync(resolve(controllerRoot, path)))}` }))
  .sort((left, right) => left.schema < right.schema ? -1 : left.schema > right.schema ? 1 : 0);
const entry = { identity, ownedSchemas, qualificationStatus: "qualified", activatedAt, revocation: null };
const next = appendQualifiedControllerIdentity(readControllerIdentityHistory(), entry);
if (args.includes("--write")) {
  const path = fileURLToPath(new URL("../contracts/controller-identity-history.json", import.meta.url));
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
} else process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
