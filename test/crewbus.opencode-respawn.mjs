// Integration: spawn a REAL opencode worker on a temp board, wait for the
// harness session id capture (log scan or opencode.db storage fallback),
// then respawn --dry-run must preview (not refuse) while the worker runs.
// Skipped when opencode isn't installed.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/crewbus.js", import.meta.url));
const board = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-ocrespawn-")), "board");

// skip barrier: opencode not installed
const which = process.platform === "win32" ? "where" : "which";
const probe = spawnSync(which, ["opencode"], { stdio: "pipe", encoding: "utf8" });
if (probe.error || probe.status !== 0 || !String(probe.stdout || "").trim()) {
  console.log("skip: opencode not installed (spawn -> respawn capture test skipped)");
  process.exit(0);
}

const env = { ...process.env, CREWBUS_DIR: board };
const TOK = {};
const run = (args, extraEnv) => {
  const merged = { ...env, ...(extraEnv || {}) };
  const fi = args.indexOf("--from");
  const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? String(args[fi + 1]).toLowerCase() : null;
  if (who && TOK[who] && !merged.CREWBUS_TOKEN) merged.CREWBUS_TOKEN = TOK[who];
  const out = execFileSync("node", [CLI, ...args], { env: merged }).toString();
  const m = out.match(/token (abt-[0-9a-f]+)/);
  if (m && who && !TOK[who]) TOK[who] = m[1];
  return out;
};

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

run(["init", "--board", board]);
run(["register", "--from", "boss"]);

const worker = "rb1";
run([
  "spawn", "--from", "boss", "--to", worker,
  "--harness", "opencode", "--cwd", board,
  "--auto", "--i-understand-danger", "--keep-env",
  "--body", "Reply to this brief with one short line, then stop.",
]);
console.log(`spawned opencode worker "${worker}"; waiting up to ~45s for session capture...`);

const docPath = path.join(board, "worker-sessions", `${worker}.json`);
let doc = null;
const poll = run; // invoking spawn-status inside syncWorkerSession's caller flow
try {
  const deadline = Date.now() + 45 * 1000;
  while (Date.now() < deadline) {
    execFileSync("node", [CLI, "spawn-status", "--from", "boss", "--to", worker], { env }).toString(); // triggers sync incl. storage probe
    try { doc = JSON.parse(fs.readFileSync(docPath, "utf8")); } catch { doc = null; }
    if (doc && doc.harnessSessionId) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  const idSource = doc && doc.idSource;
  check(`respawn: opencode worker session captured (${idSource || "no source"})`, !!doc && !!doc.harnessSessionId && typeof doc.harnessSessionId === "string" && /^ses_/.test(doc.harnessSessionId) && ["log", "storage", "log-override"].includes(idSource));
  check("respawn: capture stamped", !!doc && !!doc.capturedAt && typeof doc.storageCheckedAt === "string");

  if (!doc || !doc.harnessSessionId) {
    // help future debugging: dump binding doc + log tail once
    try {
      const lp = doc && doc.logPath;
      console.error(`no captured session id for "${worker}"; doc: ${JSON.stringify(doc || null)}`);
      if (lp && fs.existsSync(lp)) console.error(`log tail:\n${fs.readFileSync(lp, "utf8").slice(-1500)}`);
    } catch {}
  } else {
    const dry = run(["respawn", "--from", "boss", "--to", worker, "--auto", "--i-understand-danger", "--dry-run"]);
    check("respawn: dry-run previews instead of refusing", dry.includes(`would respawn ${worker}`) && !dry.includes("no harness session id recorded"));
    console.log(`dry-run shape: ${dry.split("\n")[0]}`);
  }
} finally {
  // never leave a detached opencode worker behind
  try { poll(["spawn-kill", "--from", "boss", "--to", worker]); } catch (e) {
    console.error(`cleanup: spawn-kill failed (${String((e && e.message) || e).split("\n")[0].slice(0, 120)})`);
    try {
      const fallbackDoc = doc || JSON.parse(fs.readFileSync(docPath, "utf8"));
      if (fallbackDoc && fallbackDoc.spawnedPid) {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(fallbackDoc.spawnedPid), "/T", "/F"], { stdio: "ignore" });
        else execFileSync("kill", ["-9", String(fallbackDoc.spawnedPid)], { stdio: "ignore" });
        console.error("cleanup: killed the leftover worker by recorded pid");
      }
    } catch (e2) {
      const s = String((e2 && e2.message) || e2).split("\n")[0];
      console.error(`cleanup: by-pid fallback failed (${s.slice(0, 120)})`);
    }
  }
  let removed = false;
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(path.dirname(board), { recursive: true, force: true }); removed = true; break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); }
  }
  check("cleanup: temp board removed", removed);
}

if (failures > 0) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log("\nopencode respawn integration passed");
