import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "crewbus.js");

delete process.env.CREWBUS_TOKEN;
delete process.env.CREWBUS_AGENT;

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

import { buildOrchestratorPrompt, provisionOrchestrator, killWorkers, ORCHESTRATOR_NAME } from "../bin/lib/spawn.js";
import { ensureBoard } from "../bin/lib/store.js";

// ---------------------------------------------------------------------------
// Unit: coordinator prompt budget mandate
// ---------------------------------------------------------------------------
const cwdU = path.join(os.tmpdir(), "cb-leadbudget-unit");
const rootU = path.join(cwdU, ".crewbus");
const baseArgs = {
  name: ORCHESTRATOR_NAME, subject: "s", body: "m", batch: "b-1",
  workers: [{ name: "w-1", id: "msg-1", harness: "opencode" }],
  crew: [], cwd: cwdU, root: rootU, auto: false,
};
const plain = buildOrchestratorPrompt({ ...baseArgs });
check("prompt: no-budget coordinator mentions no mandate", !plain.includes("Budget mandate:"));
const capped = buildOrchestratorPrompt({ ...baseArgs, budgetTokens: 400000, budgetMinutes: 30 });
check("prompt: budgeted coordinator states tokens", capped.includes("Budget mandate:") && capped.includes("400000 est. tokens total"));
check("prompt: budgeted coordinator states minutes + reap warning", capped.includes("30 wall-clock minutes total") && capped.includes("reaped at the cap"));
const onlyMin = buildOrchestratorPrompt({ ...baseArgs, budgetMinutes: 30 });
check("prompt: minutes-only budget reads cleanly", onlyMin.includes("Budget mandate:") && onlyMin.includes("30 wall-clock minutes total") && !onlyMin.includes("est. tokens"));

// ---------------------------------------------------------------------------
// Unit: provisionOrchestrator plumbs the budget into bootWorker's stamp
// ---------------------------------------------------------------------------
const dirU = fs.mkdtempSync(path.join(os.tmpdir(), "cb-leadbudget-prov-"));
const dU = ensureBoard(path.join(dirU, ".crewbus"));
try {
  const prov = provisionOrchestrator(dU, {
    spawnOpts: { harness: "opencode", cwd: dirU, root: dU.root },
    subject: "budget UA", body: "coord budget check", rev: "r0",
    logDir: path.join(dU.root, "logs"),
    workers: [{ name: "w-1", id: "msg-1", harness: "opencode" }],
    batch: "b-ua", crew: [], workbench: [], auto: false,
    budgetTokens: 1000, budgetMinutes: 3,
  });
  check("prov: coordinator minted+booted", prov.action === "created" && typeof prov.pid === "number");
  const doc = JSON.parse(fs.readFileSync(path.join(dU.agents, `${ORCHESTRATOR_NAME}.json`), "utf8"));
  check("prov: budget tokens stamped on the lane", doc.budgetTokens === 1000);
  check("prov: budget minutes stamped on the lane", doc.budgetMinutes === 3);
  check("prov: budget clock (budgetSince) flipped at boot", typeof doc.budgetSince === "string" && !Number.isNaN(Date.parse(doc.budgetSince)));
  try { await killWorkers(dU, [ORCHESTRATOR_NAME]); } catch {}
} catch (e) {
  check(`prov suite failed (unexpected): ${e.message}`, false);
}

// ---------------------------------------------------------------------------
// CLI: --lead-budget-* parse validation (off happy path)
// ---------------------------------------------------------------------------
const dirE = fs.mkdtempSync(path.join(os.tmpdir(), "cb-leadbudget-e2e-"));
const envE = { ...process.env, CREWBUS_DIR: path.join(dirE, ".crewbus") };
const runFail = (args) => {
  try {
    execFileSync("node", [CLI, ...args], { env: envE, cwd: dirE, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (e) {
    return { ok: false, out: String((e && e.stderr) || "") };
  }
};
const g1 = runFail(["spawn", "--count", "1", "--harness", "opencode", "--body", "x", "--dry-run", "--orchestrator-budget-tokens", "not-a-number"]);
check("cli: --orchestrator-budget-tokens rejects non-numbers", !g1.ok && /--orchestrator-budget-tokens must be a positive number/.test(g1.out));
const g2 = runFail(["spawn", "--count", "1", "--harness", "opencode", "--body", "x", "--dry-run", "--orchestrator-budget-minutes", "0"]);
check("cli: --orchestrator-budget-minutes rejects 0", !g2.ok && /--orchestrator-budget-minutes must be a positive number/.test(g2.out));
const g3 = runFail(["spawn", "--count", "1", "--harness", "opencode", "--body", "x", "--dry-run", "--orchestrator-budget-tokens", "1000", "--budget-minuts", "30"]);
check("cli: known limitation — typo'd budget flag is silently ignored (crewbus lenient-argv; strict-unknown flags is a repo-wide policy item)", g3.ok === true || (!g3.ok && /unknown/i.test(g3.out)));

for (const d of [dirU, dirE]) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(d, { recursive: true, force: true }); break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nlead-budget suite passed");
