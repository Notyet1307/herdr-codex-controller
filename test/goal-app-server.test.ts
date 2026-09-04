import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { GoalAppServer } from "../src/goal-app-server.js";
import { createTestRepo, testConfig } from "./support.js";

test("Goal App Server adapter binds a persistent thread and an offline turn", async (t: any) => {
  const repo = createTestRepo();
  t.after(() => repo.cleanup());
  const fake = join(repo.root, "fake-codex.cjs");
  const statePath = join(repo.root, "fake-goal-state.json");
  const argsPath = join(repo.root, "fake-goal-args.jsonl");
  writeFileSync(fake, FAKE_CODEX, "utf8");
  chmodSync(fake, 0o700);
  const previousState = process.env.FAKE_GOAL_STATE;
  const previousArgs = process.env.FAKE_GOAL_ARGS;
  const previousInstruction = process.env.FAKE_GOAL_INSTRUCTION_SOURCE;
  const previousSuppressCompleted = process.env.FAKE_GOAL_SUPPRESS_COMPLETED;
  process.env.FAKE_GOAL_STATE = statePath;
  process.env.FAKE_GOAL_ARGS = argsPath;
  process.env.FAKE_GOAL_SUPPRESS_COMPLETED = "1";
  t.after(() => {
    if (previousState === undefined) delete process.env.FAKE_GOAL_STATE;
    else process.env.FAKE_GOAL_STATE = previousState;
    if (previousArgs === undefined) delete process.env.FAKE_GOAL_ARGS;
    else process.env.FAKE_GOAL_ARGS = previousArgs;
    if (previousInstruction === undefined) delete process.env.FAKE_GOAL_INSTRUCTION_SOURCE;
    else process.env.FAKE_GOAL_INSTRUCTION_SOURCE = previousInstruction;
    if (previousSuppressCompleted === undefined) delete process.env.FAKE_GOAL_SUPPRESS_COMPLETED;
    else process.env.FAKE_GOAL_SUPPRESS_COMPLETED = previousSuppressCompleted;
  });
  const runtime = new GoalAppServer(testConfig(repo, { codex: { ...testConfig(repo).codex, bin: fake } }));
  const runtimeHome = join(repo.root, "goal-codex-home");

  await runtime.preflight(runtimeHome);
  const created = await runtime.createThread({ cwd: repo.source, codexHome: runtimeHome, objective: "Complete the fixture." });
  assert.equal(created.status, "paused");
  let started: string | null = null;
  const turn = await runtime.runTurn({
    cwd: repo.source,
    codexHome: runtimeHome,
    threadId: created.threadId,
    prompt: "Implement the fixture without network access.",
    onStarted: (turnId) => { started = turnId; },
  });
  assert.equal(turn.turnId, started);
  assert.equal(turn.turnStatus, "completed");
  assert.equal(turn.goal.status, "complete");
  const inspection = await runtime.inspect(created.threadId, repo.source, runtimeHome);
  assert.equal(inspection.goal?.status, "complete");
  assert.deepEqual(inspection.turns, [{ id: turn.turnId, status: "completed" }]);
  assert.equal((await runtime.setStatus(created.threadId, "active", repo.source, runtimeHome)).status, "active");

  const invocations = readFileSync(argsPath, "utf8").trim().split("\n").map((line: string) => JSON.parse(line) as string[]);
  const appServer = invocations.find((args: string[]) => args.includes("app-server"));
  assert.ok(appServer?.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(appServer?.includes("mcp_servers={}"));
  assert.ok(appServer?.includes("features.plugins=false"));
  assert.ok(appServer?.includes("project_doc_max_bytes=0"));

  process.env.FAKE_GOAL_INSTRUCTION_SOURCE = "/untrusted/AGENTS.md";
  await assert.rejects(() => runtime.createThread({ cwd: repo.source, codexHome: runtimeHome, objective: "Must fail closed." }), /instruction source/u);
});

const FAKE_CODEX = `#!/usr/bin/env node
const fs=require("node:fs");
const readline=require("node:readline");
const args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GOAL_ARGS,JSON.stringify(args)+"\\n");
if(process.env.HOME!==process.env.CODEX_HOME){console.error("runtime home not isolated");process.exit(2)}
if(args[0]==="--version"){console.log("codex-cli 0.test");process.exit(0)}
if(args[0]==="login"&&args[1]==="status"){console.log("logged in");process.exit(0)}
const statePath=process.env.FAKE_GOAL_STATE;
const load=()=>fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,"utf8")):{threadId:"thread-1",goal:null,turns:[]};
const save=(state)=>fs.writeFileSync(statePath,JSON.stringify(state));
const send=(value)=>process.stdout.write(JSON.stringify(value)+"\\n");
(async()=>{for await(const line of readline.createInterface({input:process.stdin})){
  const message=JSON.parse(line);if(message.id===undefined)continue;
  const state=load();const method=message.method;const params=message.params||{};
  if(method==="initialize")send({id:message.id,result:{userAgent:"fake",codexHome:"/tmp",platformFamily:"unix",platformOs:"test"}});
  else if(method==="thread/start")send({id:message.id,result:{thread:{id:state.threadId,status:{type:"idle"},turns:[]},instructionSources:process.env.FAKE_GOAL_INSTRUCTION_SOURCE?[process.env.FAKE_GOAL_INSTRUCTION_SOURCE]:[]}});
  else if(method==="thread/resume"){
    if(params.approvalPolicy!=="never"||params.sandbox!=="workspace-write"){send({id:message.id,error:{code:-32602,message:"unsafe resume"}});continue}
    send({id:message.id,result:{thread:{id:state.threadId,status:{type:"idle"},turns:state.turns},instructionSources:process.env.FAKE_GOAL_INSTRUCTION_SOURCE?[process.env.FAKE_GOAL_INSTRUCTION_SOURCE]:[]}});
  }
  else if(method==="thread/goal/set"){
    const previous=state.goal||{threadId:state.threadId,objective:"",tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1};
    state.goal={...previous,...params,threadId:state.threadId,updatedAt:2};save(state);send({id:message.id,result:{goal:state.goal}});
    if(params.status==="active"&&state.turns.some((turn)=>turn.status==="inProgress"))setTimeout(()=>{
      const completed=load();completed.turns=completed.turns.map((turn)=>({...turn,status:"completed"}));completed.goal={...completed.goal,status:"complete",tokensUsed:42,timeUsedSeconds:1,updatedAt:3};save(completed);
      if(!process.env.FAKE_GOAL_SUPPRESS_COMPLETED)send({method:"turn/completed",params:{threadId:completed.threadId,turn:completed.turns[0]}});
    },5);
  }else if(method==="thread/goal/get")send({id:message.id,result:{goal:state.goal}});
  else if(method==="turn/start"){
    const turn={id:"turn-1",status:"inProgress"};send({id:message.id,result:{turn}});
    state.turns=[turn];save(state);
  }else if(method==="thread/read")send({id:message.id,result:{thread:{id:state.threadId,status:{type:"idle"},turns:state.turns}}});
  else send({id:message.id,error:{code:-32601,message:"unknown"}});
}})();
`;
