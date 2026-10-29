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

import { ensureBoard } from "../bin/lib/store.js";
import { authorizeCheck } from "../bin/lib/identity.js";

const dirE = fs.mkdtempSync(path.join(os.tmpdir(), "cb-chanmember-"));
const boardE = path.join(dirE, ".crewbus");
ensureBoard(boardE);
const envE = { ...process.env, CREWBUS_DIR: boardE };
const run = (args) => execFileSync("node", [CLI, ...args], { env: envE, cwd: dirE, stdio: ["ignore", "pipe", "pipe"] }).toString();
const runFail = (args) => {
  try {
    execFileSync("node", [CLI, ...args], { env: envE, cwd: dirE, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: String((e && e.stderr) || "") };
  }
};
const tok = (out) => (out.match(/token (abt-[0-9a-f]+)/) || [])[1];

try {
  const bossTok = tok(run(["orchestrator", "init"]));
  check("setup: orchestrator registered", !!bossTok);
  const aliceTok = tok(run(["register", "--from", "alice"]));
  check("setup: alice registered", !!aliceTok);
  const bobTok = tok(run(["register", "--from", "bob"]));
  check("setup: bob registered", !!bobTok);

  run(["group", "create", "alpha", "--add", "alice"]);
  const dU = { root: boardE, agents: path.join(boardE, "agents"), groups: path.join(boardE, "groups") };

  // Unit-level authorizeCheck matrix
  const u1 = authorizeCheck(dU, "orchestrator", "channel-post", { channelGroup: "alpha" });
  check("unit: orchestrator posts anywhere", u1.ok === true);
  check("unit: orchestrator posts to any board channel", authorizeCheck(dU, "orchestrator", "channel-post", {}).ok === true);
  const u2 = authorizeCheck(dU, "alice", "channel-post", { channelGroup: "alpha" });
  check("unit: member posts to own group channel", u2.ok === true);
  const u3 = authorizeCheck(dU, "bob", "channel-post", { channelGroup: "alpha" });
  check("unit: non-member worker refused on foreign group channel", u3.ok === false && /members only/.test(u3.reason));
  const u4 = authorizeCheck(dU, "alice", "channel-post", {});
  check("unit: worker refused on board channels without mapping", u4.ok === false && /board channels/.test(u4.reason));
  const u5 = authorizeCheck(dU, "alice", "channel-post", { channelGroup: "ghost" });
  check("unit: nonexistent target group refused", u5.ok === false && /not found/.test(u5.reason));

  // CLI E2E
  const ok1 = run(["channel", "post", "--channel", "grp-alpha", "--from", "alice", "--token", aliceTok, "--body", "hi crew"]);
  check("cli: member posts to grp-alpha", ok1.includes("posted ch-"));
  const ok2 = run(["channel", "post", "--channel", "grp-alpha", "--from", "orchestrator", "--token", bossTok, "--body", "admin ping"]);
  check("cli: orchestrator posts to grp-alpha", ok2.includes("posted ch-"));
  const bad1 = runFail(["channel", "post", "--channel", "board-lounge", "--from", "alice", "--token", aliceTok, "--body", "x"]);
  check("cli: board channels are orchestrator-only", !bad1.ok && /orchestrator-only/.test(bad1.out));
  const bad2 = runFail(["channel", "post", "--channel", "grp-alpha", "--from", "bob", "--token", bobTok, "--body", "x"]);
  check("cli: non-member refused", !bad2.ok && /members only/.test(bad2.out));

  // Restricted group: member posting still works, non-member refused.
  run(["group", "create", "beta", "--add", "bob", "--restricted"]);
  run(["group", "add", "beta", "--member", "bob"]);
  const ok3 = run(["channel", "post", "--channel", "grp-beta", "--from", "bob", "--token", bobTok, "--body", "member of restricted group"]);
  check("cli: restricted group member still posts", ok3.includes("posted ch-"));
  const bad3 = runFail(["channel", "post", "--channel", "grp-beta", "--from", "alice", "--token", aliceTok, "--body", "x"]);
  check("cli: restricted non-member refused", !bad3.ok && /members only/.test(bad3.out));

  // --also-channel mirrors gate per-group; DMs always deliver.
  const mir1 = run(["send", "--from", "alice", "--token", aliceTok, "--to", "bob", "--to-group", "alpha", "--also-channel", "--body", "mirrored to alpha"]);
  check("cli: member mirror posts", mir1.includes("+channel grp-alpha") && !mir1.includes("skipped"));
  const mir2 = run(["send", "--from", "bob", "--token", bobTok, "--to", "alice", "--to-group", "alpha", "--also-channel", "--body", "skip for me"]);
  check("cli: non-member mirror skipped with note, DM still sent", mir2.includes("sent msg-") && mir2.includes("[channel mirror skipped, members-only: alpha]"));
} catch (e) {
  check(`channel-member suite failed (unexpected): ${e.message}`, false);
}

let removed = false;
for (let i = 0; i < 20; i++) {
  try { fs.rmSync(dirE, { recursive: true, force: true }); removed = true; break; }
  catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
}
check("cleanup: temp board removed", removed);

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nchannel-member suite passed");
