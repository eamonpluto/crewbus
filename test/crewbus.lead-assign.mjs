import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Stub opencode on PATH so provisioning boots a real detached process that
// sleeps (never the real harness). Mirrors test/crewbus.smoke.mjs.
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-orch-shim-"));
if (process.platform === "win32") {
  fs.writeFileSync(path.join(shimDir, "opencode.cmd"), `@echo off\r\n"${process.execPath}" -e "setInterval(() => {}, 1000)"\r\n`);
} else {
  const shimPath = path.join(shimDir, "opencode");
  fs.writeFileSync(shimPath, `#!/bin/sh\nexec "${process.execPath}" -e 'setInterval(() => {}, 1000)'\n`);
  fs.chmodSync(shimPath, 0o755);
}
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH || ""}`;
process.env.OPENCODE_EXE = "";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "crewbus.js");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

import { buildSpawnPrompt, buildOrchestratorPrompt, buildCrewContext, provisionOrchestrator, killWorkers, ORCHESTRATOR_NAME } from "../bin/lib/spawn.js";
import { ensureBoard } from "../bin/lib/store.js";
import { loadTokenFile } from "../bin/lib/tokenfile.js";

const cwdUnit = path.join(os.tmpdir(), "cb-orch-unit");
const rootUnit = path.join(cwdUnit, ".crewbus");

// ---------------------------------------------------------------------------
// Unit: worker prompt pinning
// ---------------------------------------------------------------------------
const pBoard = buildSpawnPrompt({
  name: "sec-1", orchestrator: ORCHESTRATOR_NAME, body: "mission text",
  replyId: "msg-1", cwd: cwdUnit, root: rootUnit,
});
check("spawn prompt: pins --to orchestrator", pBoard.includes("crewbus send --from sec-1 --to orchestrator --reply msg-1"));
check("spawn prompt: names the board orchestrator", pBoard.includes("the board orchestrator, which owns this crew"));
check("spawn prompt: no boss/lead language", !/boss|\blead\b/i.test(pBoard));
check("spawn prompt: verdicts name the orchestrator", pBoard.includes("only from orchestrator") && pBoard.includes("--subject \"approval:"));
check("spawn prompt: checkpoints to orchestrator", pBoard.includes("--to orchestrator --reply msg-1 --checkpoint"));

// ---------------------------------------------------------------------------
// Unit: orchestrator prompt
// ---------------------------------------------------------------------------
const cOrch = buildOrchestratorPrompt({
  name: ORCHESTRATOR_NAME, subject: "scope", body: "THE MISSION TEXT",
  batch: "batch-77", cwd: cwdUnit, root: rootUnit, auto: true,
  workers: [
    { name: "sec-1", id: "msg-11", harness: "opencode" },
    { name: "sec-2", id: "msg-12", harness: "claude" },
  ],
  crew: ["your group(s): crew (sec-1, sec-2) — your lane: scope."],
});
check("orchestrator prompt: identity", cOrch.includes("the board orchestrator (batch batch-77)"));
check("orchestrator prompt: mission carried verbatim", cOrch.includes("THE MISSION TEXT"));
check("orchestrator prompt: worker roster with brief ids", cOrch.includes("- sec-1: brief msg-11 [opencode]") && cOrch.includes("- sec-2: brief msg-12 [claude]"));
check("orchestrator prompt: token-file convention", cOrch.includes("logs/orchestrator.token") && cOrch.includes("Never re-register"));
check("orchestrator prompt: poll loop guidance", cOrch.includes("listen --from orchestrator --timeout 120000") && cOrch.includes("sleep 60 + inbox --digest"));
check("orchestrator prompt: respawn chase", cOrch.includes("spawn-status --all") && cOrch.includes("respawn --from orchestrator --to <name>") && cOrch.includes("--fresh"));
check("orchestrator prompt: verdict lane fail-closed", cOrch.includes('"approval:"') && cOrch.includes("fail-closed") && cOrch.includes("NEVER approvable"));
check("orchestrator prompt: no boss escalation lane", !/boss/i.test(cOrch) && !/--to boss/.test(cOrch));
check("orchestrator prompt: aggregate posts on the board", cOrch.includes("post the aggregate on the board"));
check("orchestrator prompt: needs-by + overdue discipline", cOrch.includes("stamp --needs-by") && cOrch.includes("[OVERDUE]"));
check("orchestrator prompt: never does the workers' work", cOrch.includes("Never: change the workers' mission text") && cOrch.includes("redo workers' work"));

const cc = buildCrewContext({ name: "sec-1", orchestrator: ORCHESTRATOR_NAME, offTask: 0 });
check("crew context: orchestrator is for approvals only", cc.join(" ").includes("orchestrator is for approvals and scope disputes only"));

// ---------------------------------------------------------------------------
// Unit: provisioning mints + transfers + token file
// ---------------------------------------------------------------------------
const dirUnit = fs.mkdtempSync(path.join(os.tmpdir(), "cb-orchprov-"));
const dUnit = ensureBoard(path.join(dirUnit, ".crewbus"));
const logDirUnit = path.join(dUnit.root, "logs");

const prov = provisionOrchestrator(dUnit, {
  spawnOpts: { harness: "opencode", root: dUnit.root, cwd: dirUnit },
  subject: "", body: "PROVISION MISSION",
  workers: [
    { name: "pw-1", id: "msg-z1", harness: "opencode" },
    { name: "pw-2", id: "msg-z2", harness: "opencode" },
  ],
  batch: "batch-prov", logDir: logDirUnit, auto: false,
});
check("provision: creates the orchestrator lane", prov.action === "created" && prov.orchestratorName === ORCHESTRATOR_NAME);
check("provision: token minted once", typeof prov.token === "string" && /^abt-[0-9a-f]+$/.test(prov.token));
check("provision: pid recorded", typeof prov.pid === "number" && prov.pid > 0);
check("provision: worker ownership transferred", prov.transferred === 2);

const orchDocU = JSON.parse(fs.readFileSync(path.join(dUnit.agents, "orchestrator.json"), "utf8"));
check("provision: role forced to orchestrator", orchDocU.role === "orchestrator");
check("provision: token file persisted", loadTokenFile(dUnit.root, "orchestrator") === prov.token);
for (const w of ["pw-1", "pw-2"]) {
  const doc = JSON.parse(fs.readFileSync(path.join(dUnit.agents, `${w}.json`), "utf8"));
  check(`provision: ${w} spawnedBy orchestrator`, doc.spawnedBy === "orchestrator");
}
const orchFileU = fs.readdirSync(logDirUnit).find((f) => f.startsWith("orchestrator-") && f.endsWith(".prompt.md"));
check("provision: orchestrator prompt file written", !!orchFileU && fs.readFileSync(path.join(logDirUnit, orchFileU), "utf8").includes("PROVISION MISSION"));

const prov2 = provisionOrchestrator(dUnit, {
  spawnOpts: { harness: "opencode", root: dUnit.root, cwd: dirUnit },
  subject: "", body: "PROVISION MISSION 2",
  workers: [{ name: "pw-3", id: "msg-z3", harness: "opencode" }], batch: "batch-prov2", logDir: logDirUnit, auto: false,
});
check("provision: second burst reuses the standing orchestrator", prov2.action === "reused" && prov2.token === undefined);
check("provision: reused burst still transfers ownership", prov2.transferred === 1);
const orchDocU2 = JSON.parse(fs.readFileSync(path.join(dUnit.agents, "orchestrator.json"), "utf8"));
check("provision: token untouched on reuse", loadTokenFile(dUnit.root, "orchestrator") === prov.token && orchDocU2.tokenHash === orchDocU.tokenHash);

// Revive: empty roster still ensures/boots the orchestrator (spawn --count 0).
const dirRevive = fs.mkdtempSync(path.join(os.tmpdir(), "cb-orchrevive-"));
const dRevive = ensureBoard(path.join(dirRevive, ".crewbus"));
const provRevive = provisionOrchestrator(dRevive, {
  spawnOpts: { harness: "opencode", root: dRevive.root, cwd: dirRevive },
  subject: "revive", body: "REVIVE MISSION", workers: [], batch: undefined, logDir: path.join(dRevive.root, "logs"),
});
check("revive: empty roster creates + boots the orchestrator", provRevive.action === "created" && provRevive.pid > 0);
check("revive: nothing to transfer", provRevive.transferred === 0);
const orchFileR = fs.readdirSync(path.join(dRevive.root, "logs")).find((f) => f.startsWith("orchestrator-") && f.endsWith(".prompt.md"));
check("revive: orchestrator prompt carries the mission text", !!orchFileR && fs.readFileSync(path.join(dRevive.root, "logs", orchFileR), "utf8").includes("REVIVE MISSION"));

// ---------------------------------------------------------------------------
// CLI E2E (stub opencode)
// ---------------------------------------------------------------------------
const dirE2E = fs.mkdtempSync(path.join(os.tmpdir(), "cb-orche2e-"));
const boardE2E = path.join(dirE2E, ".crewbus");
const envE2E = { ...process.env, CREWBUS_DIR: boardE2E };
delete envE2E.CREWBUS_TOKEN;
delete envE2E.CREWBUS_AGENT;
const run2 = (args) => execFileSync("node", [CLI, ...args], { env: envE2E, cwd: dirE2E, stdio: ["ignore", "pipe", "pipe"] }).toString();

const noneRes = (() => {
  try { run2(["spawn", "--from", "boss", "--count", "1", "--body", "x", "--dry-run"]); return { ok: true, out: "" }; }
  catch (e) { return { ok: false, out: String((e && e.stderr) || (e && e.stdout) || "") }; }
})();
check("e2e: --from is refused", !noneRes.ok && /--from is not supported/.test(noneRes.out));
const leadRes = (() => {
  try { run2(["spawn", "--lead", "auto", "--count", "1", "--body", "x", "--dry-run"]); return { ok: true, out: "" }; }
  catch (e) { return { ok: false, out: String((e && e.stderr) || (e && e.stdout) || "") }; }
})();
check("e2e: --lead is refused", !leadRes.ok && /--lead is not supported/.test(leadRes.out));

const out = run2(["spawn", "--count", "2", "--prefix", "sec", "--harness", "opencode", "--auto", "--i-understand-danger", "--body", "orchestrator e2e: claim, one-line ack DM to orchestrator, exit"]);
check("e2e: live spawn pins workers reported", out.includes("spawned sec-1") && out.includes("spawned sec-2"));
const mintedLine = /orchestrator provisioned: lane 'orchestrator' .*pid (\d+)/.exec(out);
check("e2e: orchestrator provisioned + pid in output", !!mintedLine && Number(mintedLine[1]) > 0);
check("e2e: token surfaced once", /token abt-[0-9a-f]+/.test(out));

const orchTokFile = loadTokenFile(boardE2E, "orchestrator");
check("e2e: token file on disk matches output", !!orchTokFile && /^abt-[0-9a-f]+$/.test(orchTokFile));
const orchDoc = JSON.parse(fs.readFileSync(path.join(boardE2E, "agents", "orchestrator.json"), "utf8"));
check("e2e: orchestrator doc role = orchestrator", orchDoc.role === "orchestrator");
const sec1 = JSON.parse(fs.readFileSync(path.join(boardE2E, "agents", "sec-1.json"), "utf8"));
check("e2e: worker ownership transferred", sec1.spawnedBy === "orchestrator");

const logsDir = path.join(boardE2E, "logs");
const wPrompt = fs.readdirSync(logsDir).find((f) => f.startsWith("sec-1-") && f.endsWith(".prompt.md"));
check("e2e: worker prompt pins --to orchestrator", fs.readFileSync(path.join(logsDir, wPrompt), "utf8").includes("--to orchestrator"));
const cPrompt = fs.readdirSync(logsDir).find((f) => f.startsWith("orchestrator-") && f.endsWith(".prompt.md"));
check("e2e: orchestrator prompt written", fs.readFileSync(path.join(logsDir, cPrompt), "utf8").includes("the board orchestrator"));

const out2 = run2(["spawn", "--count", "1", "--prefix", "sec3", "--harness", "opencode", "--auto", "--i-understand-danger", "--body", "second burst for the same lane"]);
check("e2e: second burst reuses the orchestrator", out2.includes("orchestrator reused") && out2.includes("crew transferred"));

const gRevTo = (() => { try { run2(["spawn", "--count", "0", "--to", "wx", "--body", "m"]); return { ok: true, out: "" }; } catch (e) { return { ok: false, out: String((e && e.stderr) || "") }; } })();
check("revive: --count 0 refuses worker operands", !gRevTo.ok && /revives ONLY the orchestrator/.test(gRevTo.out));
const gRevNeg = (() => { try { run2(["spawn", "--count", "-1", "--body", "m"]); return { ok: true, out: "" }; } catch (e) { return { ok: false, out: String((e && e.stderr) || "") }; } })();
check("revive: negative --count still refuses", !gRevNeg.ok && /--count must be >= 0/.test(gRevNeg.out));
const dryRevive = run2(["spawn", "--count", "0", "--dry-run", "--body", "REVIVE THE ORCHESTRATOR AFTER THE REBOOT"]);
check("revive: dry-run preview mentions no workers", dryRevive.includes("orchestrator-revive:") && dryRevive.includes("0 workers") && !dryRevive.includes("would spawn "));
check("revive: dry-run preview notes the standing orchestrator", dryRevive.includes("reused, not duplicated"));

const preWorkers = fs.readdirSync(path.join(boardE2E, "agents")).filter((f) => f.startsWith("sec")).length;
const outRevive = run2(["spawn", "--count", "0", "--body", "revive: the orchestrator died after a reboot; re-read your crew and come back"]);
check("revive: live run boots no worker pids", !/\bspawned \w+\b/.test(outRevive));
check("revive: live run provisions or reuses the orchestrator", outRevive.includes("orchestrator provisioned") || outRevive.includes("orchestrator reused"));
const postWorkers = fs.readdirSync(path.join(boardE2E, "agents")).filter((f) => /^sec/.test(f)).length;
check("revive: no new worker lanes created", postWorkers === preWorkers);

let killOut = "";
try {
  killOut = run2(["spawn-kill", "--from", "orchestrator", "--token", orchTokFile, "--all"]);
} catch (e) {
  killOut = String((e && e.stdout) || e.message || e);
}
check("e2e: cleanup kills recorded", killOut.includes("killed") || killOut.includes("exited"));

// Unit-board cleanup: kill the stubs we booted.
try { await killWorkers(dUnit, ["pw-1", "pw-2", "pw-3", "orchestrator"]); } catch {}
try { await killWorkers(dRevive, ["orchestrator"]); } catch {}
fs.rmSync(dirE2E, { recursive: true, force: true });
fs.rmSync(dirUnit, { recursive: true, force: true });
fs.rmSync(dirRevive, { recursive: true, force: true });
fs.rmSync(shimDir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\norchestrator-assign suite passed");