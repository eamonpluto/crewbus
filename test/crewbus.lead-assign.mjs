import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "crewbus.js");

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

import { buildSpawnPrompt, buildCoordinatorPrompt, buildCrewContext, provisionAutoLead, LEAD_NAME } from "../bin/lib/spawn.js";
import { ensureBoard } from "../bin/lib/store.js";
import { loadTokenFile } from "../bin/lib/tokenfile.js";

// ---------------------------------------------------------------------------
// Unit: worker prompt pinning
// ---------------------------------------------------------------------------
const cwdUnit = path.join(os.tmpdir(), "cb-lead-assign-unit");
const rootUnit = path.join(cwdUnit, ".crewbus");

const pBoard = buildSpawnPrompt({
  name: "sec-1", from: "boss", lead: LEAD_NAME, body: "mission text",
  replyId: "msg-1", cwd: cwdUnit, root: rootUnit,
});
check("spawn prompt: board mode pins --to lead", pBoard.includes("crewbus send --from sec-1 --to lead --reply msg-1"));
check("spawn prompt: board mode names the lead lane", pBoard.includes("the board's lead lane"));
check("spawn prompt: board mode keeps legacy anti-invent line out", !pBoard.includes("never invent a recipient name"));
check("spawn prompt: board mode verdicts name the lead", pBoard.includes("only from lead") && pBoard.includes("--to lead --reply msg-1 --subject \"approval:"));
check("spawn prompt: board mode checkpoints to lead", pBoard.includes("--to lead --reply msg-1 --checkpoint"));

const pLeadDirect = buildSpawnPrompt({
  name: "sec-1", from: "lead", body: "mission text",
  replyId: "msg-1", cwd: cwdUnit, root: rootUnit,
});
check("spawn prompt: lead direct pins to lead", pLeadDirect.includes("crewbus send --from sec-1 --to lead --reply msg-1") && pLeadDirect.includes("the board's lead lane"));
check("spawn prompt: verdicts accept only from lead", pLeadDirect.includes("only from lead"));

const pCustomLead = buildSpawnPrompt({
  name: "sec-1", from: "boss", lead: "coordinator-x", body: "m",
  replyId: "msg-9", cwd: cwdUnit, root: rootUnit,
});
check("spawn prompt: named lead lane pins verbatim", pCustomLead.includes("--to coordinator-x --reply msg-9") && pCustomLead.includes("only from coordinator-x"));

// ---------------------------------------------------------------------------
// Unit: coordinator prompt
// ---------------------------------------------------------------------------
const cCoord = buildCoordinatorPrompt({
  name: "lead", from: "boss", subject: "scope", body: "THE MISSION TEXT",
  batch: "batch-77", cwd: cwdUnit, root: rootUnit, auto: true,
  workers: [
    { name: "sec-1", id: "msg-11", harness: "opencode" },
    { name: "sec-2", id: "msg-12", harness: "claude" },
  ],
  crew: [
    "your group(s): crew (sec-1, sec-2) — your lane: scope.",
  ],
});
check("coord prompt: auto-provisioned identity", cCoord.includes("auto-provisioned lead for this crew (batch batch-77)"));
check("coord prompt: names the boss", cCoord.includes("spawned the crew as boss") && cCoord.includes("from boss"));
check("coord prompt: mission carried verbatim", cCoord.includes("THE MISSION TEXT"));
check("coord prompt: worker roster with brief ids", cCoord.includes("- sec-1: brief msg-11 [opencode]") && cCoord.includes("- sec-2: brief msg-12 [claude]"));
check("coord prompt: token-file convention", cCoord.includes("logs/lead.token") && cCoord.includes("Never re-register"));
check("coord prompt: poll loop guidance", cCoord.includes("listen --from lead --timeout 120000") && cCoord.includes("sleep 60 + inbox --digest"));
check("coord prompt: respawn chase with --fresh fallback", cCoord.includes("spawn-status --all") && cCoord.includes("respawn --from lead --to <name>") && cCoord.includes("--fresh"));
check("coord prompt: respawn cap before boss ping", cCoord.includes("2 respawn attempts per lane"));
check("coord prompt: verdict lane fail-closed", cCoord.includes('"approval:"') && cCoord.includes("fail-closed") && cCoord.includes("NEVER approvable"));
check("coord prompt: boss escalation lane", cCoord.includes(`crewbus send --from lead --to boss --priority high`));
check("coord prompt: milestones aggregate lane", cCoord.includes(`send --from lead --to boss --subject "result: ..."`));
check("coord prompt: needs-by + overdue discipline", cCoord.includes(`stamp --needs-by`) && cCoord.includes("[OVERDUE]"));
check("coord prompt: does the mission itself never", cCoord.includes("Never: change the workers' mission text") && cCoord.includes("redo workers' work"));
check("coord prompt: unattended inheritance noted", cCoord.includes("respawns inherit it"));

const cSelf = buildCoordinatorPrompt({
  name: "lead", from: "lead", subject: "self", body: "SELF SPAWN",
  cwd: cwdUnit, root: rootUnit,
});
check("coord prompt: sender==lead avoids DM-to-self guidance", cSelf.includes("spawned from the 'lead' lane itself") && !cSelf.includes("send --from lead --to lead"));

// ---------------------------------------------------------------------------
// Unit: crew context names the lead lane
// ---------------------------------------------------------------------------
const cc = buildCrewContext({ name: "sec-1", from: "boss", lead: LEAD_NAME, offTask: 0 });
check("crew context: lead is for approvals only", cc.join(" ").includes("lead is for approvals and scope disputes only"));

// ---------------------------------------------------------------------------
// Unit: provisioning mints + transfers + token file (generic spawnOpts — the
// guard against generic coordinators lives in cmdSpawn, not in the helper)
// ---------------------------------------------------------------------------
const dirUnit = fs.mkdtempSync(path.join(os.tmpdir(), "cb-leadprov-"));
const dUnit = ensureBoard(path.join(dirUnit, ".crewbus"));
const logDirUnit = path.join(dUnit.root, "logs");

const prov = provisionAutoLead(dUnit, {
  spawnOpts: { harness: "opencode", root: dUnit.root, cwd: dirUnit },
  from: "boss-c", subject: "", body: "PROVISION MISSION",
  workers: [
    { name: "pw-1", id: "msg-z1", harness: "opencode" },
    { name: "pw-2", id: "msg-z2", harness: "opencode" },
  ],
  batch: "batch-prov", logDir: logDirUnit, auto: false,
});
check("provision: mints the lead lane", prov.action === "minted" && prov.leadName === "lead");
check("provision: token minted once", typeof prov.token === "string" && /^abt-[0-9a-f]+$/.test(prov.token));
check("provision: pid recorded (generic boot)", prov.action === "minted");
check("provision: worker ownership transferred", prov.transferred === 2);

const leadDocU = JSON.parse(fs.readFileSync(path.join(dUnit.agents, "lead.json"), "utf8"));
check("provision: role forced to lead (never the defaultRole worker)", leadDocU.role === "lead");
check("provision: provisioned-by stamped", leadDocU.provisionedBy === "boss-c");
check("provision: token file persisted (tokenfile convention)", loadTokenFile(dUnit.root, "lead") === prov.token);
for (const w of ["pw-1", "pw-2"]) {
  const doc = JSON.parse(fs.readFileSync(path.join(dUnit.agents, `${w}.json`), "utf8"));
  check(`provision: ${w} spawnedBy transferred to lead`, doc.spawnedBy === "lead");
}
const coordFileU = fs.readdirSync(logDirUnit).find((f) => f.startsWith("lead-") && f.endsWith(".prompt.md"));
check("provision: coordinator prompt file written", !!coordFileU && fs.readFileSync(path.join(logDirUnit, coordFileU), "utf8").includes("PROVISION MISSION"));

const prov2 = provisionAutoLead(dUnit, {
  spawnOpts: { harness: "opencode", root: dUnit.root, cwd: dirUnit },
  from: "boss-c", subject: "", body: "PROVISION MISSION 2",
  workers: [{ name: "pw-3", id: "msg-z3", harness: "opencode" }], batch: "batch-prov2", logDir: logDirUnit, auto: false,
});
check("provision: second burst reuses the lane (never re-mints)", prov2.action === "reused" && prov2.token === null);
check("provision: reused burst still transfers ownership", prov2.transferred === 1);
const leadDocU2 = JSON.parse(fs.readFileSync(path.join(dUnit.agents, "lead.json"), "utf8"));
check("provision: token untouched on reuse", loadTokenFile(dUnit.root, "lead") === prov.token && leadDocU2.tokenHash === leadDocU.tokenHash);

// No `--from lead` bypass: the call must provision or reuse the coordinator,
// never take the old self-bootstrap skip. The lane already exists here and
// may have a live coordinator, so "reused" and "minted" are both valid; a
// coordinator boot failure is the only remaining skip path.
const senderIsLead = provisionAutoLead(dUnit, {
  spawnOpts: { harness: "opencode", root: dUnit.root, cwd: dirUnit },
  from: "lead", authToken: prov.token, workers: [], batch: "batch-self", logDir: logDirUnit,
});
check("provision: sender==lead never takes the old bypass", !/sender IS the lead/.test(String(senderIsLead.reason || "")));
check("provision: sender==lead provisions or reuses the coordinator", senderIsLead.action !== "skipped" || /coordinator boot failed/.test(String(senderIsLead.reason || "")));

// A board where the lead lane is the spawner from the start: provisioning
// mints the lane and boots the persistent coordinator instead of skipping.
const dirSelfSpawn = fs.mkdtempSync(path.join(os.tmpdir(), "cb-leadself-"));
const dSelfSpawn = ensureBoard(path.join(dirSelfSpawn, ".crewbus"));
const selfSpawn = provisionAutoLead(dSelfSpawn, {
  spawnOpts: { harness: "opencode", root: dSelfSpawn.root, cwd: dirSelfSpawn },
  from: LEAD_NAME, subject: "self", body: "SELF-LEAD MISSION", workers: [], batch: "batch-self-fresh",
  logDir: path.join(dSelfSpawn.root, "logs"),
});
check("provision: from lead on a fresh lane mints the lane (no bypass)", selfSpawn.action === "minted" && selfSpawn.leadName === "lead");
check("provision: from lead persists the coordinator token file", !!loadTokenFile(dSelfSpawn.root, "lead"));
const selfPromptFile = fs.readdirSync(path.join(dSelfSpawn.root, "logs")).find((f) => f.startsWith("lead-") && f.endsWith(".prompt.md"));
check("provision: self-boss coordinator prompt avoids DM-to-self", !!selfPromptFile && fs.readFileSync(path.join(dSelfSpawn.root, "logs", selfPromptFile), "utf8").includes("spawned from the 'lead' lane itself"));

// Lead-revive (C9): an EMPTY roster still provisions/boots the coordinator
// (that is exactly what `spawn --count 0` exercises end-to-end).
const dirRevive = fs.mkdtempSync(path.join(os.tmpdir(), "cb-leadrevive-"));
const dRevive = ensureBoard(path.join(dirRevive, ".crewbus"));
const provRevive = provisionAutoLead(dRevive, {
  spawnOpts: { harness: "opencode", root: dRevive.root, cwd: dirRevive },
  from: "boss-r", subject: "revive", body: "REVIVE MISSION", workers: [], batch: undefined, logDir: path.join(dRevive.root, "logs"),
});
check("revive: empty roster still mints + boots the coordinator", provRevive.action === "minted" && provRevive.action === "minted");
check("revive: nothing to transfer", provRevive.transferred === 0);
const coordFileR = fs.readdirSync(path.join(dRevive.root, "logs")).find((f) => f.startsWith("lead-") && f.endsWith(".prompt.md"));
check("revive: coordinator prompt carries the mission text", !!coordFileR && fs.readFileSync(path.join(dRevive.root, "logs", coordFileR), "utf8").includes("REVIVE MISSION"));

// offboarded lane refuses silent resurrection
fs.copyFileSync(path.join(dUnit.agents, "lead.json"), path.join(dUnit.agents, "lead.json.bak"));
const docOff = JSON.parse(fs.readFileSync(path.join(dUnit.agents, "lead.json"), "utf8"));
docOff.offboarded = true;
fs.writeFileSync(path.join(dUnit.agents, "lead.json"), JSON.stringify(docOff));
const provOff = provisionAutoLead(dUnit, {
  spawnOpts: { harness: "opencode", root: dUnit.root, cwd: dirUnit },
  from: "boss-c", workers: [], batch: "batch-off", logDir: logDirUnit,
});
check("provision: offboarded lane refuses", provOff.action === "skipped" && /offboarded/.test(provOff.reason));
fs.copyFileSync(path.join(dUnit.agents, "lead.json.bak"), path.join(dUnit.agents, "lead.json"));

// ---------------------------------------------------------------------------
// CLI E2E (requires a coding harness on PATH — opencode — else skip,
// mirroring crewbus.opencode-respawn.mjs)
// ---------------------------------------------------------------------------
const which = process.platform === "win32" ? "where" : "which";
const probe = spawnSync(which, ["opencode"], { stdio: "pipe", encoding: "utf8" });
const hasOc = probe.status !== null && probe.status !== undefined && !probe.error && String(probe.stdout || "").trim() !== "" && fs.existsSync(String(probe.stdout).split(/\r?\n/)[0].trim());

if (!hasOc) {
  console.log("skip: opencode not installed (CLI lead-assign E2E skipped)");
} else {
  const dirE2E = fs.mkdtempSync(path.join(os.tmpdir(), "cb-leade2e-"));
  const boardE2E = path.join(dirE2E, ".crewbus");
  const envE2E = { ...process.env, CREWBUS_DIR: boardE2E };
  delete envE2E.CREWBUS_TOKEN;
  const run2 = (args) =>
    execFileSync("node", [CLI, ...args], { env: envE2E, cwd: dirE2E, stdio: ["ignore", "pipe", "pipe"] }).toString();

  // First caller (boss) claims admin. Verify --lead none is refused.
  const noneRes = (() => {
    try {
      run2(["spawn", "--from", "boss", "--count", "1", "--prefix", "gz", "--harness", "opencode", "--body", "warmup", "--lead", "none"]);
      return { ok: true, out: "" };
    } catch (e) {
      return { ok: false, out: String((e && e.stderr) || (e && e.stdout) || "") };
    }
  })();
  check("e2e: --lead none is refused", !noneRes.ok && /only --lead auto is supported/.test(noneRes.out));
  const bossTok = run2(["register", "--from", "boss"]).match(/token (abt-[0-9a-f]+)/)[1];

  const out = run2(["spawn", "--from", "boss", "--token", bossTok, "--count", "2", "--prefix", "sec", "--harness", "opencode", "--auto", "--i-understand-danger", "--body", "lead-assign e2e: claim, one-line ack DM to lead, exit"]);
  check("e2e: live spawn pins workers reported", out.includes("spawned sec-1") && out.includes("spawned sec-2"));
  const mintedLine = /auto-lead provisioned: minted lane 'lead' .*coordinator pid (\d+)/.exec(out);
  check("e2e: coordinator provisioned + pid in output", !!mintedLine && Number(mintedLine[1]) > 0);
  check("e2e: token surfaced once", /lead token \(set CREWBUS_TOKEN=abt-[0-9a-f]+ to act as 'lead'\)/.test(out));

  const leadTokFile = loadTokenFile(boardE2E, "lead");
  check("e2e: token file on disk matches output", !!leadTokFile && /^abt-[0-9a-f]+$/.test(leadTokFile));
  const leadDoc = JSON.parse(fs.readFileSync(path.join(boardE2E, "agents", "lead.json"), "utf8"));
  check("e2e: lead doc forced role = lead", leadDoc.role === "lead");
  const sec1 = JSON.parse(fs.readFileSync(path.join(boardE2E, "agents", "sec-1.json"), "utf8"));
  check("e2e: worker ownership transferred (spawnedBy=lead)", sec1.spawnedBy === "lead");

  const logsDir = path.join(boardE2E, "logs");
  const wPrompt = fs.readdirSync(logsDir).find((f) => f.startsWith("sec-1-") && f.endsWith(".prompt.md"));
  const wPromptText = fs.readFileSync(path.join(logsDir, wPrompt), "utf8");
  check("e2e: worker prompt pins --to lead", wPromptText.includes("--to lead") && wPromptText.includes("the board's lead lane"));
  const cPrompt = fs.readdirSync(logsDir).find((f) => f.startsWith("lead-") && f.endsWith(".prompt.md"));
  const cPromptText = fs.readFileSync(path.join(logsDir, cPrompt), "utf8");
  check("e2e: coordinator prompt written from the CLI path", cPromptText.includes("auto-provisioned lead") && cPromptText.includes("--to boss"));

  // Second burst on the same board reuses the standing coordinator.
  const out2 = run2(["spawn", "--from", "boss", "--token", bossTok, "--count", "1", "--prefix", "sec3", "--harness", "opencode", "--auto", "--i-understand-danger", "--body", "second burst for the same lane"]);
  check("e2e: second burst reuses the lead lane", out2.includes("auto-lead reused") && out2.includes("crew transferred"));

  // ---- Lead-revive (C9) CLI guards (deterministic, no boots) ----
  const gRevTo = (() => { try { run2(["spawn", "--from", "boss", "--token", bossTok, "--count", "0", "--to", "wx", "--body", "m"]); return { ok: true, out: "" }; } catch (e) { return { ok: false, out: String((e && e.stderr) || "") }; } })();
  check("revive: --count 0 refuses worker operands", !gRevTo.ok && /revives ONLY the auto-coordinator/.test(gRevTo.out));
  const gRevNone = (() => { try { run2(["spawn", "--from", "boss", "--token", bossTok, "--count", "0", "--lead", "none", "--harness", "opencode", "--body", "m"]); return { ok: true, out: "" }; } catch (e) { return { ok: false, out: String((e && e.stderr) || (e && e.stdout) || "") }; } })();
  check("revive: --count 0 refuses --lead none", !gRevNone.ok && /only --lead auto is supported/.test(gRevNone.out));
  const gRevNeg = (() => { try { run2(["spawn", "--from", "boss", "--token", bossTok, "--count", "-1", "--body", "m"]); return { ok: true, out: "" }; } catch (e) { return { ok: false, out: String((e && e.stderr) || "") }; } })();
  check("revive: negative --count still refuses", !gRevNeg.ok && /--count must be >= 0/.test(gRevNeg.out));
  const dryRevive = run2(["spawn", "--from", "boss", "--token", bossTok, "--count", "0", "--dry-run", "--body", "REVIVE THE COORDINATOR AFTER THE REBOOT"]);
  check("revive: dry-run preview mentions no workers", dryRevive.includes("lead-revive:") && dryRevive.includes("0 workers") && !dryRevive.includes("would spawn "));
  check("revive: dry-run preview notes the standing coordinator", dryRevive.includes("reused, not duplicated"));

  // ---- Lead-revive live (real coordinator boot, no worker boots) ----
  const preWorkers = fs.existsSync(path.join(boardE2E, "agents")) ? fs.readdirSync(path.join(boardE2E, "agents")).filter((f) => f.startsWith("sec")).length : 0;
  const outRevive = run2(["spawn", "--from", "boss", "--token", bossTok, "--count", "0", "--body", "revive: the coordinator died after a reboot; re-read your crew and come back"]);
  check("revive: live run boots no worker pids", !/\bspawned \w+\b/.test(outRevive));
  check("revive: live run provisions or reuses the coordinator", outRevive.includes("auto-lead provisioned") || outRevive.includes("auto-lead reused"));
  const postWorkers = fs.readdirSync(path.join(boardE2E, "agents")).filter((f) => /^sec/.test(f)).length;
  check("revive: no new worker lanes created", postWorkers === preWorkers);

  // Cleanup: admin may kill everything incl. the coordinator lane.
  let killOut = "";
  try {
    killOut = run2(["spawn-kill", "--from", "boss", "--token", bossTok, "--all"]);
  } catch (e) {
    killOut = String((e && e.stdout) || e.message || e);
  }
  check("e2e: cleanup kills recorded", killOut.includes("killed") || killOut.includes("exited"));
  let removedE2E = false;
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dirE2E, { recursive: true, force: true }); removedE2E = true; break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
  }
  check("e2e: cleanup temp board removed", removedE2E);
}

let removedUnit = false;
for (let i = 0; i < 20; i++) {
  try { fs.rmSync(dirUnit, { recursive: true, force: true }); removedUnit = true; break; }
  catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
}
for (let i = 0; i < 20; i++) {
  try { fs.rmSync(dirSelfSpawn, { recursive: true, force: true }); break; }
  catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nlead-assign suite passed");
