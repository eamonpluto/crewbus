import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "crewbus.js");
const HOOK = path.join(HERE, "..", "bin", "crewbus-hook.js");

// Test-local hygiene (crewbus.lead-assign lesson): never leak the operator's
// token/agent into boards that mint fresh identities.
delete process.env.CREWBUS_TOKEN;
delete process.env.CREWBUS_AGENT;

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

import { ensureBoard } from "../bin/lib/store.js";
import { recoverIdentity, reservedNameReason, RESERVED_SENTINELS, hashToken, mintToken, newSalt, writeAgentFile } from "../bin/lib/identity.js";
import { saveTokenFile, loadTokenFile } from "../bin/lib/tokenfile.js";

// ---------------------------------------------------------------------------
// Unit: recoverIdentity scoring on a synthetic board
// ---------------------------------------------------------------------------
const dirU = fs.mkdtempSync(path.join(os.tmpdir(), "cb-recover-unit-"));
const dU = ensureBoard(path.join(dirU, ".crewbus"));

const tokBob = mintToken();
const saltBob = newSalt();
writeAgentFile(dU, "bob", {
  name: "bob", firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
  role: "worker", sessionId: "sess-1", lastDir: process.cwd(),
  tokenHash: hashToken(tokBob, saltBob), salt: saltBob,
});
saveTokenFile(dU.root, "bob", tokBob);

const tokAnn = mintToken();
const saltAnn = newSalt();
writeAgentFile(dU, "ann", {
  name: "ann", firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
  role: "worker", lastDir: path.join(dirU, "elsewhere"),
  tokenHash: hashToken(tokAnn, saltAnn), salt: saltAnn,
});
saveTokenFile(dU.root, "ann", tokAnn);

// legacy-era agent: token file present but no recorded hash → hint, never proven
writeAgentFile(dU, "olaf", {
  name: "olaf", firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
  role: "peer", lastDir: path.join(dirU, "elsewhere"),
});
saveTokenFile(dU.root, "olaf", mintToken());

writeAgentFile(dU, "gone", {
  name: "gone", firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
  role: "peer", offboarded: true, lastDir: process.cwd(),
});

// session binding dominates: bob (+4 binding, +3 proven hash, +1 token, +1 cwd)
let c = recoverIdentity(dU, { sessionID: "sess-1", cwd: process.cwd(), hashToken, loadTokenFile: (root, n) => loadTokenFile(root, n) });
check("recover unit: session binding ranks bob first", c[0] && c[0].name === "bob");
check("recover unit: bob proven via token-hash cross-check", c[0] && c[0].proven === true);
check("recover unit: cwd evidence recorded in why", c[0] && /worked from this directory/.test(c[0].why));
check("recover unit: offboarded agent excluded", !c.some((x) => x.name === "gone"));
check("recover unit: legacy no-hash agent included but never proven", c.some((x) => x.name === "olaf") && !c.find((x) => x.name === "olaf").proven);
check("recover unit: legacy no-hash agent scores token file only", c.find((x) => x.name === "olaf").score === 1);

// wrong session: opener binding vanishes; ann+olaf tie at 1, bob at 1 (no cwd, no session)
c = recoverIdentity(dU, { sessionID: "sess-9", cwd: path.join(dirU, "nowhere"), hashToken, loadTokenFile: (root, n) => loadTokenFile(root, n) });
const bobF = c.find((x) => x.name === "bob");
check("recover unit: bob without session/cwd still proven (hash cross-check alone)", !!bobF && bobF.proven === true && bobF.score === 4);
check("recover unit: hash cross-check works without any session hint", c.every((x) => x.name !== "olaf" || x.proven === false));

// no injectors: token file is a hint, never proven
c = recoverIdentity(dU, { sessionID: "sess-1", cwd: process.cwd() });
check("recover unit: injected verifiers absent → nothing proven", c[0] && c[0].name === "bob" && c[0].proven === false && c[0].score === 6);

// empty board
const dEmpty = ensureBoard(path.join(dirU, "empty", ".crewbus"));
check("recover unit: empty board has no candidates", recoverIdentity(dEmpty, { cwd: process.cwd(), hashToken, loadTokenFile: (root, n) => loadTokenFile(root, n) }).length === 0);

// no token file → not even listed for cwd candidates… unless cwd (+1) matches
writeAgentFile(dU, "cwdonly", {
  name: "cwdonly", firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
  role: "peer", lastDir: process.cwd(),
});
c = recoverIdentity(dU, { cwd: process.cwd(), hashToken, loadTokenFile: (root, n) => loadTokenFile(root, n) });
check("recover unit: cwd-only candidate listed with score 1", c.some((x) => x.name === "cwdonly" && x.score === 1));

// anti-spoof: a token file that does NOT match the stored hash stays a hint
const saltTip = newSalt();
writeAgentFile(dU, "spoof", {
  name: "spoof", firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
  role: "peer", tokenHash: hashToken("abt-real-token", saltTip), salt: saltTip,
});
saveTokenFile(dU.root, "spoof", "abt-forged-token");
c = recoverIdentity(dU, { cwd: process.cwd(), hashToken, loadTokenFile: (root, n) => loadTokenFile(root, n) });
check("recover unit: forged token file never proven", c.find((x) => x.name === "spoof").proven === false && c.find((x) => x.name === "spoof").score === 1);

// sentinel helpers
check("sentinels: RESERVED_SENTINELS covers amnesia throwaways",
  RESERVED_SENTINELS.includes("unknown") && RESERVED_SENTINELS.includes("me") && RESERVED_SENTINELS.includes("you"));
check("sentinels: reservedNameReason fires for unknown", typeof reservedNameReason("unknown") === "string" && /reserved sentinel/.test(reservedNameReason("unknown")));
check("sentinels: reservedNameReason passes real names", reservedNameReason("bob") === null);

// ---------------------------------------------------------------------------
// CLI: sentinel guards + recover verb
// ---------------------------------------------------------------------------
const dirE = fs.mkdtempSync(path.join(os.tmpdir(), "cb-recover-e2e-"));
const boardE = path.join(dirE, ".crewbus");
const envE = { ...process.env, CREWBUS_DIR: boardE };
const run = (args) => execFileSync("node", [CLI, ...args], { env: envE, cwd: dirE, stdio: ["ignore", "pipe", "pipe"] }).toString();
const runFail = (args) => {
  try {
    execFileSync("node", [CLI, ...args], { env: envE, cwd: dirE, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: String((e && e.stderr) || "") + String((e && e.stdout) || "") };
  }
};

try {
  // Guard 1: register --from unknown = amnesia throwaway, refuse to mint.
  const g1 = runFail(["register", "--from", "unknown"]);
  check("cli: register --from unknown refuses", !g1.ok && /reserved sentinel/.test(g1.out));

  // Guard 2: admin --for unknown refuses likewise.
  const bossOut = run(["orchestrator", "init"]);
  const bossTok = (bossOut.match(/token (abt-[0-9a-f]+)/) || [])[1];
  check("cli: orchestrator registers with minted token", !!bossTok);
  const g2 = runFail(["register", "--from", "orchestrator", "--token", bossTok, "--for", "unknown", "--role", "worker"]);
  check("cli: orchestrator --for unknown refuses", !g2.ok && /reserved sentinel/.test(g2.out));

  // Guard 3: send --from unknown refuses (before any identity mint).
  const g3 = runFail(["send", "--from", "unknown", "--to", "somebody", "--body", "hi"]);
  check("cli: send --from unknown refuses", !g3.ok && /reserved sentinel/.test(g3.out));

  // recover on an empty (pre-planted) board: no candidates. recover is
  // read-side — it refuses to plant, so the fixture plants first.
  const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-recover-fresh-"));
  ensureBoard(path.join(freshDir, ".crewbus"));
  const freshEnv = { ...process.env, CREWBUS_DIR: path.join(freshDir, ".crewbus") };
  const fresh = execFileSync("node", [CLI, "recover"], { env: freshEnv, cwd: freshDir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  check("cli: recover on empty board prints no-candidates guidance", fresh.includes("no identity candidates") && /register --from <orchestrator> --for <name>/.test(fresh));
  for (let i = 0; i < 15; i++) { try { fs.rmSync(freshDir, { recursive: true, force: true }); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } }

  // recover with a register-bound identity: proven + resume script.
  const pilgOut = run(["register", "--from", "pilg", "--session", "sess-pilg"]);
  const pilgTok = (pilgOut.match(/token (abt-[0-9a-f]+)/) || [])[1];
  check("cli: pilg registered", !!pilgTok);
  const r1 = run(["recover", "--session", "sess-pilg"]);
  check("cli: recover proves the session-bound identity", r1.includes("proven pilg") && r1.includes("session id matches register binding"));
  check("cli: recover prints the resume script", r1.includes("resume as 'pilg'") && r1.includes("CREWBUS_AGENT=pilg") && /logs[\\/]pilg\.token/.test(r1));
  check("cli: recover points at the unacked digest", r1.includes("crewbus inbox --from pilg --unacked --digest"));

  // recover without --session: still proven via the hash cross-check.
  const r2 = run(["recover"]);
  check("cli: sessionless recover cross-checks the token file", r2.includes("proven pilg") && r2.includes("token file cross-checks the stored hash"));

  // recover --cwd elsewhere (a sibling, not a subdir — the cwd hint's
  // ancestor tolerance counts subdirs of the registered dir as matching):
  // evidence drops, session still wins.
  const r3 = run(["recover", "--session", "sess-pilg", "--cwd", path.join(dirE, "..", "far-away-sibling")]);
  check("cli: --cwd mismatch drops the cwd hint but keeps proof", r3.includes("proven pilg") && !r3.includes("worked from this directory"));

  // recover --session with a wrong value: no binding hint; hash proof persists.
  const r4 = run(["recover", "--session", "sess-wrong"]);
  check("cli: wrong session offers no binding hint", r4.includes("proven pilg") && !r4.includes("session id matches register binding"));

  // offboarded agent: excluded from recovery candidates.
  run(["send", "--from", "pilg", "--token", pilgTok, "--to", "boss", "--body", "ping"]);
  const carlOut = run(["register", "--from", "carl"]);
  const carlTok = (carlOut.match(/token (abt-[0-9a-f]+)/) || [])[1];
  run(["register", "--from", "carl", "--token", carlTok]); // touch carl
  run(["register", "--from", "orchestrator", "--token", bossTok, "--offboard", "carl"]);
  const r5 = run(["recover"]);
  check("cli: offboarded carl excluded from recover", !r5.includes("carl"));
} catch (e) {
  check(`cli recover suite failed (unexpected): ${e.message}`, false);
}

// ---------------------------------------------------------------------------
// crewbus-hook compact: the rehydration recovery chain
// ---------------------------------------------------------------------------
const runHook = (args, extraEnv) => {
  try {
    return execFileSync("node", [HOOK, ...args], { env: { ...envE, ...extraEnv }, cwd: dirE, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    return String((e && (e.stderr || e.stdout)) || e.message || e);
  }
};
try {
  const h1 = runHook(["compact", "--from", "unknown", "--session", "sess-pilg"]);
  check("hook: unknown sentinel resolves to the binded identity", h1.includes("You are 'pilg'") && !h1.includes("reserved sentinel"));
  const h2 = runHook(["compact", "--from", "unknown"], { CREWBUS_DIR: path.join(dirU, "empty", ".crewbus") });
  check("hook: unresolved sentinel prints the recover path", h2.includes("could not identify 'unknown'") && h2.includes("crewbus recover") && h2.includes("sentinel names are reserved"));
  // hook compact --from unknown on a REAL board without a matching session:
  // falls back to the strongest lite-score candidate (token-file + cwd evidence)
  const h3 = runHook(["compact", "--from", "unknown"], { CREWBUS_DIR: path.join(dirE, ".crewbus") });
  check("hook: no-session fallback picks the send-token candidate", h3.includes("You are 'boss'") || h3.includes("You are 'pilg'"));
  const h4 = runHook(["compact", "--from", "pilg"]);
  check("hook: direct identity card unchanged", h4.includes("You are 'pilg'") && h4.includes("crewbus inbox --from pilg --unacked --digest"));
} catch (e) {
  check(`hook compact suite failed (unexpected): ${e.message}`, false);
}

// cleanup
let removed = false;
for (let i = 0; i < 20; i++) {
  try { fs.rmSync(dirE, { recursive: true, force: true }); removed = true; break; }
  catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
}
check("cleanup: temp e2e board removed", removed);
try { fs.rmSync(dirU, { recursive: true, force: true }); } catch {}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nrecover suite passed");
