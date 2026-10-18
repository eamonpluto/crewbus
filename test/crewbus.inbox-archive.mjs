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

const dirE = fs.mkdtempSync(path.join(os.tmpdir(), "cb-inbarch-"));
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
  const bossTok = tok(run(["register", "--from", "boss"]));
  const meTok = tok(run(["register", "--from", "me-lane"]));
  check("setup: identities registered", !!bossTok && !!meTok);

  // Unscoped archive refuses (no --all / --before)
  const g1 = runFail(["inbox", "archive", "--from", "me-lane", "--token", meTok]);
  check("archive requires a scope", !g1.ok && /needs a scope/.test(g1.out));

  // Seed three numbered mails: one work brief, one checkpoint, one acked
  const s1 = run(["send", "--from", "boss", "--token", bossTok, "--to", "me-lane", "--body", "THE WORK BRIEF", "--subject", "brief"]);
  check("setup: work brief sent", s1.includes("sent msg-"));
  run(["send", "--from", "boss", "--token", bossTok, "--to", "me-lane", "--body", "progress so far", "--checkpoint"]);
  const s3 = run(["send", "--from", "boss", "--token", bossTok, "--to", "me-lane", "--body", "status update"]);
  const ackId = (s3.match(/sent (msg-[0-9a-f-]+) ->/) || [])[1];
  run(["ack", "--from", "me-lane", "--token", meTok, "--id", ackId]);
  check("setup: mail Stuttgart (3 rows: brief + checkpoint + acked update)", fs.readdirSync(path.join(boardE, "dm", "me-lane")).filter((f) => f.endsWith(".json")).length === 3);

  // Now archive the acked one (row is older than the 1s window by 1.4s):
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1400);
  const ar0 = run(["inbox", "archive", "--from", "me-lane", "--token", meTok, "--before", "1"]);
  // (races: nothing was acked yet at first probed runs? recompute: the ack is done above, so --before 1ms moves it if the row predates now-1ms)
  const live = fs.readdirSync(path.join(boardE, "dm", "me-lane")).filter((f) => f.endsWith(".json"));
  const arch = fs.existsSync(path.join(boardE, "dm-archive", "me-lane")) ? fs.readdirSync(path.join(boardE, "dm-archive", "me-lane")).filter((f) => f.endsWith(".json")) : [];
  // With --before 1ms and quick timing, "status update" may or may not be old
  // enough; the IMPORTANT invariant: unacked work brief + fresh checkpoint
  // handling? checkpoint IS archivable. Assert: the WORK BRIEF survived.
  const briefEverInArchive = arch.some((f) => /THE WORK BRIEF/.test(fs.readFileSync(path.join(boardE, "dm-archive", "me-lane", f), "utf8")));
  const briefInLive = live.some((f) => /THE WORK BRIEF/.test(fs.readFileSync(path.join(boardE, "dm", "me-lane", f), "utf8")));
  check("unacked work brief never archives implicitly", !briefEverInArchive && briefInLive);

  // --all archives acked + checkpoints explicitly
  run(["ack", "--from", "me-lane", "--token", meTok, "--all"]);
  const ar1 = run(["inbox", "archive", "--from", "me-lane", "--token", meTok, "--all"]);
  check("archive --all moves acked + checkpoints", /\barchived 3 message/.test(ar1) || /archived \d+ message/.test(ar1));
  const live2 = fs.readdirSync(path.join(boardE, "dm", "me-lane")).filter((f) => f.endsWith(".json"));
  check("live inbox emptied by the archive", live2.length === 0);
  const arch2 = fs.readdirSync(path.join(boardE, "dm-archive", "me-lane")).filter((f) => f.endsWith(".json"));
  check("archive holds the moved rows", arch2.length === 3);

  // Read-back opt-in
  const rb = run(["inbox", "--from", "me-lane", "--token", meTok, "--archived"]);
  check("--archived read shows the archived rows", rb.includes("THE WORK BRIEF") && rb.includes("progress so far"));
  const rbLive = run(["inbox", "--from", "me-lane", "--token", meTok]);
  check("live read no longer shows them", !rbLive.includes("THE WORK BRIEF") && rbLive.includes("no messages"));

  // Id-collision safety: re-delivery of an already-archived id keeps the original
  const sample = JSON.parse(fs.readFileSync(path.join(boardE, "dm-archive", "me-lane", fs.readdirSync(path.join(boardE, "dm-archive", "me-lane"))[0]), "utf8"));
  fs.writeFileSync(path.join(boardE, "dm", "me-lane", `${sample.id}.json`), JSON.stringify(sample));
  const ar2 = run(["inbox", "archive", "--from", "me-lane", "--token", meTok, "--all"]);
  check("id collision keeps the archive copy, no double-move", /\barchived 0 message/.test(ar2) && fs.existsSync(path.join(boardE, "dm-archive", "me-lane", `${sample.id}.json`)));

  // --json output
  const ar3 = JSON.parse(run(["inbox", "archive", "--from", "me-lane", "--token", meTok, "--all", "--json"]));
  check("--json shape", ar3.agent === "me-lane" && ar3.moved === 0 && ar3.kept === 1 && /dm-archive/.test(ar3.archive));

  // Authorization: another agent's identity cannot archive my inbox
  const evilTok = tok(run(["register", "--from", "evil"]));
  const g2 = runFail(["inbox", "archive", "--from", "me-lane", "--token", evilTok, "--all"]);
  check("archive is token-gated to the owner", !g2.ok && /bad token/.test(g2.out));
} catch (e) {
  check(`inbox-archive suite failed (unexpected): ${e.message}`, false);
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
console.log("\ninbox-archive suite passed");
