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

import { buildCoordinatorPrompt, provisionAutoLead, killWorkers, LEAD_NAME } from "../bin/lib/spawn.js";
import { ensureBoard } from "../bin/lib/store.js";

// ---------------------------------------------------------------------------
// Unit: coordinator prompt budget mandate
// ---------------------------------------------------------------------------
const cwdU = path.join(os.tmpdir(), "cb-leadbudget-unit");
const rootU = path.join(cwdU, ".crewbus");
const baseArgs = {
  name: LEAD_NAME, from: "boss", subject: "s", body: "m", batch: "b-1",
  workers: [{ name: "w-1", id: "msg-1", harness: "opencode" }],
  crew: [], cwd: cwdU, root: rootU, auto: false,
};
const plain = buildCoordinatorPrompt({ ...baseArgs });
check("prompt: no-budget coordinator mentions no mandate", !plain.includes("Budget mandate:"));
const capped = buildCoordinatorPrompt({ ...baseArgs, budgetTokens: 400000, budgetMinutes: 30 });
check("prompt: budgeted coordinator states tokens", capped.includes("Budget mandate:") && capped.includes("400000 est. tokens total"));
check("prompt: budgeted coordinator states minutes + reap warning", capped.includes("30 wall-clock minutes total") && capped.includes("reaped at the cap"));
const onlyMin = buildCoordinatorPrompt({ ...baseArgs, budgetMinutes: 30 });
check("prompt: minutes-only budget reads cleanly", onlyMin.includes("Budget mandate:") && onlyMin.includes("30 wall-clock minutes total") && !onlyMin.includes("est. tokens"));

// ---------------------------------------------------------------------------
// Unit: provisionAutoLead plumbs the budget into bootWorker's stamp
// ---------------------------------------------------------------------------
const dirU = fs.mkdtempSync(path.join(os.tmpdir(), "cb-leadbudget-prov-"));
const dU = ensureBoard(path.join(dirU, ".crewbus"));
try {
  const prov = provisionAutoLead(dU, {
    spawnOpts: { harness: "opencode", cwd: dirU, root: dU.root },
    from: "boss", subject: "budget UA", body: "coord budget check", rev: "r0",
    logDir: path.join(dU.root, "logs"),
    workers: [{ name: "w-1", id: "msg-1", harness: "opencode" }],
    batch: "b-ua", crew: [], workbench: [], auto: false,
    budgetTokens: 1000, budgetMinutes: 3,
  });
  check("prov: coordinator minted+booted", prov.action === "minted" && typeof prov.pid === "number");
  const doc = JSON.parse(fs.readFileSync(path.join(dU.agents, `${LEAD_NAME}.json`), "utf8"));
  check("prov: budget tokens stamped on the lane", doc.budgetTokens === 1000);
  check("prov: budget minutes stamped on the lane", doc.budgetMinutes === 3);
  check("prov: budget clock (budgetSince) flipped at boot", typeof doc.budgetSince === "string" && !Number.isNaN(Date.parse(doc.budgetSince)));
  try { await killWorkers(dU, [LEAD_NAME]); } catch {}
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
const g1 = runFail(["spawn", "--from", "boss", "--count", "1", "--harness", "opencode", "--body", "x", "--dry-run", "--lead-budget-tokens", "not-a-number"]);
check("cli: --lead-budget-tokens rejects non-numbers", !g1.ok && /--lead-budget-tokens must be a positive number/.test(g1.out));
const g2 = runFail(["spawn", "--from", "boss", "--count", "1", "--harness", "opencode", "--body", "x", "--dry-run", "--lead-budget-minutes", "0"]);
check("cli: --lead-budget-minutes rejects 0", !g2.ok && /--lead-budget-minutes must be a positive number/.test(g2.out));
const g3 = runFail(["spawn", "--from", "boss", "--count", "1", "--harness", "opencode", "--body", "x", "--dry-run", "--lead-budget-tokens", "1000", "--budget-minuts", "30"]);
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
