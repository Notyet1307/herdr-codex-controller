import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createTestRepo, testConfig, testPlan, writeInputs } from "./support.js";

test("CLI starts and completes a local no-PR release with fake gh and Codex executables", () => {
  const repo = createTestRepo();
  const bin = join(repo.root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  try {
    const fakeGh = join(bin, "gh");
    writeFileSync(fakeGh, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[0]==='auth'&&a[1]==='status') process.exit(0);\nif(a[0]==='repo'&&a[1]==='view'){console.log(JSON.stringify({nameWithOwner:'example/project'}));process.exit(0)}\nif(a[0]==='issue'&&a[1]==='view'){const n=Number(a[2]);console.log(JSON.stringify({number:n,title:'Issue '+n,body:'Create issue-'+n+'.txt.',state:'OPEN',labels:[{name:'ready'}],assignees:[],url:'https://github.com/example/project/issues/'+n}));process.exit(0)}\nconsole.error('unsupported gh '+a.join(' '));process.exit(2);\n`, "utf8");
    chmodSync(fakeGh, 0o700);
    const fakeCodex = join(bin, "codex");
    writeFileSync(fakeCodex, `#!/usr/bin/env node\nimport fs from 'node:fs';import path from 'node:path';\nconst a=process.argv.slice(2);\nif(a[0]==='--version'){console.log('codex-test');process.exit(0)}\nif(a[0]==='login'&&a[1]==='status'){console.log('logged in');process.exit(0)}\nlet prompt='';for await(const c of process.stdin)prompt+=c;\nconst out=a[a.indexOf('--output-last-message')+1];const review=a.includes('read-only');\nif(!review){const m=prompt.match(/Issue #(\\d+)/);if(m)fs.writeFileSync(path.join(process.cwd(),'issue-'+m[1]+'.txt'),'implemented\\n')}\nconst result=review?{status:'pass',summary:'pass',findings:[]}:{status:'completed',summary:'done',selfReview:{performed:true,findingsFixed:[],remainingConcerns:[]},testsRun:[],residualRisks:[],blockedReason:null};\nfs.writeFileSync(out,JSON.stringify(result));console.log(JSON.stringify({type:'turn.completed'}));\n`, "utf8");
    chmodSync(fakeCodex, 0o700);
    const config = testConfig(repo, { codex: { ...testConfig(repo).codex, bin: fakeCodex } } as any);
    const plan = testPlan([1, 2]);
    const { configPath, planPath } = writeInputs(repo, config, plan);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const cli = resolve("dist/src/cli.js");
    const start = spawnSync("node", [cli, "start", "--config", configPath, "--plan", planPath, "--json"], { cwd: resolve("."), env, encoding: "utf8" });
    assert.equal(start.status, 0, start.stderr);
    const jobId = JSON.parse(String(start.stdout)).id as string;
    const run = spawnSync("node", [cli, "run", "--config", configPath, "--job", jobId, "--max-steps", "100", "--json"], { cwd: resolve("."), env, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const status = spawnSync("node", [cli, "status", "--config", configPath, "--job", jobId, "--json"], { cwd: resolve("."), env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    const job = JSON.parse(String(status.stdout));
    assert.equal(job.status, "completed");
    assert.deepEqual(job.issues.map((issue: any) => issue.status), ["committed", "committed"]);
  } finally { repo.cleanup(); }
});

test("CLI enforces one active release per repository state root", () => {
  const repo = createTestRepo();
  try {
    const config = testConfig(repo);
    const configPath = join(repo.root, "config-single-writer.json");
    const firstPlanPath = join(repo.root, "plan-first.json");
    const secondPlanPath = join(repo.root, "plan-second.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    writeFileSync(firstPlanPath, `${JSON.stringify({ ...testPlan([1]), id: "release-first" }, null, 2)}\n`, "utf8");
    writeFileSync(secondPlanPath, `${JSON.stringify({ ...testPlan([2]), id: "release-second" }, null, 2)}\n`, "utf8");
    const cli = resolve("dist/src/cli.js");

    const first = spawnSync("node", [cli, "start", "--config", configPath, "--plan", firstPlanPath, "--json"], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);

    const second = spawnSync("node", [cli, "start", "--config", configPath, "--plan", secondPlanPath, "--json"], {
      cwd: resolve("."), encoding: "utf8",
    });
    assert.notEqual(second.status, 0);
    assert.match(String(second.stderr), /active release job/);
  } finally { repo.cleanup(); }
});
