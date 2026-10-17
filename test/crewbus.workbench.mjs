// Workbench tests: artifacts (publish/adopt/verify/list/show/deps), lessons
// (post/list), needs-by delivery + inbox --overdue triage, and the spawn
// brief injection (Workbench block + literal lead-recipient pin).
// Same conventions as crewbus.harness.mjs: real CLI subprocess on a temp
// board, check() counters, non-zero exit on failure.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(new URL("../bin/crewbus.js", import.meta.url));
import { buildSpawnPrompt } from "../bin/lib/spawn.js";
import { renderWorkbenchBlock, workbenchMetrics, selectLessons } from "../bin/lib/workbench.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const TOK = {};
const run = (args, env, cwd, expectFail) => {
  const merged = { ...env };
  const fi = args.indexOf("--from");
  const who = fi !== -1 && args[fi + 1] && !String(args[fi + 1]).startsWith("--") ? args[fi + 1] : null;
  if (who && TOK[tokKey(merged, who)] && !merged.CREWBUS_TOKEN) merged.CREWBUS_TOKEN = TOK[tokKey(merged, who)];
  let out = "";
  try {
    out = execFileSync("node", [CLI, ...args], { env: merged, cwd: cwd || process.cwd() }).toString();
    if (expectFail) check(`${args.join(" ")} (expected failure, got success)`, false);
  } catch (e) {
    if (!expectFail) {
      check(`${args.join(" ")} failed`, false);
      console.log(`  ${String(e.stderr || e.message).slice(0, 300)}`);
    }
    return String(e.stderr || e.stdout || e.message);
  }
  const m = out.match(/token (abt-[0-9a-f]+)/);
  if (m && who && !TOK[tokKey(merged, who)]) TOK[tokKey(merged, who)] = m[1];
  return out;
};
const tokKey = (env, who) => `${(env && env.CREWBUS_DIR) || ""}\n${who}`;

// ---------------------------------------------------------------- board init
const p1 = fs.mkdtempSync(path.join(os.tmpdir(), "cb-wb-"));
const e1 = { ...process.env, CREWBUS_DIR: path.join(p1, ".crewbus") };
run(["init"], { ...e1, CREWBUS_DIR: p1 }, p1);
run(["register", "--from", "lead"], e1);
run(["register", "--from", "worker-a"], e1);
run(["register", "--from", "worker-b"], e1);

// ---------------------------------------------------------- pure unit checks
const wbLines = renderWorkbenchBlock({
  lessons: [{ id: "les-1", from: "worker-a", scope: "audit", text: "WPT oracle beats prose specs", at: "2026-01-01T00:00:00Z" }],
  artifacts: [{ id: "art-260101-000000-abc12345", from: "worker-a", path: "/tmp/out.js", summary: "diff harness", deps: [], adoptedBy: [{ by: "lead" }], verifiedBy: [] }],
  me: "worker-c",
});
check("renderWorkbenchBlock: renders lesson bullet", wbLines.some((l) => l.includes("lesson [audit]")));
check("renderWorkbenchBlock: renders artifact bullet with state", wbLines.some((l) => l.includes("art-260101-000000-abc12345") && l.includes("adopted x1")));
check("renderWorkbenchBlock: empty board is empty", renderWorkbenchBlock({ lessons: [], artifacts: [] }).length === 0);
const pinPrompt = buildSpawnPrompt({ name: "worker-c", from: "lead", body: "x", replyId: "msg-1", cwd: ".", root: "/b" });
check("spawn prompt pins the exact lead recipient (anti-hallucination)", pinPrompt.includes("EXACTLY --to lead") && pinPrompt.includes("never invent"));
const wbPrompt = buildSpawnPrompt({ name: "worker-c", from: "lead", body: "x", replyId: "msg-1", cwd: ".", root: "/b", workbench: ["- lesson [audit] test", "- artifact art-260101-000000-abc12345 /tmp/out.js"] });
check("spawn prompt carries the Workbench block", wbPrompt.includes("Workbench (lessons + artifacts") && wbPrompt.includes("art-260101-000000-abc12345"));
const lookup = (id) => (id === "art-260101-000000-abc12345" ? { id, from: "worker-a", adoptedBy: [], verifiedBy: [{ by: "worker-b" }] } : null);
const wb = workbenchMetrics([
  { id: "m1", from: "worker-b", body: "used art-260101-000000-abc12345" },
  { id: "m2", from: "worker-a", body: "verified art-260101-000000-abc12345" },
], lookup);
check("workbenchMetrics: refs + feed-forward edge (worker-b consumed worker-a's artifact)", wb.artifactRefs === 1 && wb.feedForward === 1 && wb.producers === 1 && wb.verified === 1);
check("workbenchMetrics: empty transcript scores zero", workbenchMetrics([], lookup).artifactRefs === 0);

// ------------------------------------------------------- artifacts end-to-end
const pubOut = run(["artifact", "publish", "--from", "worker-a", "--path", "notes/art-1.js", "--summary", "differential harness"], e1);
check("artifact publish echoes an art- id", /published artifact art-\d{6}-\d{6}-[0-9a-f]{8}/.test(pubOut));
const artId = (pubOut.match(/art-\d{6}-\d{6}-[0-9a-f]{8}/) || [""])[0];
check("artifact publish id parses", artId.length > 0);
run(["artifact", "publish", "--from", "worker-a", "--path", "notes/art-2.js", "--deps", artId], e1);
const depFail = run(["artifact", "publish", "--from", "worker-a", "--path", "notes/art-3.js", "--deps", "art-999999-999999-deadbeef"], e1, undefined, true);
check("artifact publish with unknown dep refuses", depFail.includes("not found on this board"));
const listOut = run(["artifact", "list"], e1);
check("artifact list shows published artifacts", listOut.includes(artId) && listOut.includes("notes/art-1.js"));
const showOut = run(["artifact", "show", "--id", artId], e1);
check("artifact show prints producer + blank adoption state", showOut.includes("producer: worker-a") && showOut.includes("adopted by: (nobody)"));
const adoptOut = run(["artifact", "adopt", "--id", artId, "--from", "worker-b", "--note", "used it"], e1);
check("artifact adopt records adoption", adoptOut.includes(`adopted ${artId} by worker-b (1 total)`));
const adopt2 = run(["artifact", "adopt", "--id", artId, "--from", "worker-b"], e1);
check("artifact adopt is idempotent per agent", adopt2.includes("(1 total)"));
const verOut = run(["artifact", "verify", "--id", artId, "--from", "lead"], e1);
check("artifact verify records verification", verOut.includes(`verified ${artId} by lead (1 total)`));
const show2 = run(["artifact", "show", "--id", artId, "--json"], e1);
const showDoc = JSON.parse(show2);
check("artifact show --json reflects adopt + verify", showDoc.adoptedBy.length === 1 && showDoc.verifiedBy.length === 1 && showDoc.deps.length === 0);
run(["artifact", "publish", "--from", "worker-b", "--path", "notes/art-4.js", "--deps", artId], e1);
const depShow = run(["artifact", "show", "--json", "--id", (run(["artifact", "publish", "--from", "worker-a", "--path", "notes/art-5.js", "--deps", `${artId}`], e1).match(/art-\d{6}-\d{6}-[0-9a-f]{8}/) || [""])[0]], e1);
check("artifact chain: dep recorded on the object", depShow.includes(`"deps": [\n    "${artId}"`));

// ------------------------------------------------------------------ lessons
const lesOut = run(["lesson", "post", "--from", "worker-a", "--scope", "audit", "--text", "use the WPT oracle", e1 || ""], e1);
check("lesson post echoes scope injection note", lesOut.includes("lesson les-") && lesOut.includes("[audit]"));
run(["lesson", "post", "--from", "lead", "--text", "commit artifacts before replying"], e1);
const lesList = run(["lesson", "list"], e1);
check("lesson list shows scoped + global lessons", lesList.includes("[audit]") && lesList.includes("[global]"));
check("lesson list --scope filters", !run(["lesson", "list", "--scope", "camera"], e1).includes("WPT oracle") && run(["lesson", "list", "--scope", "audit"], e1).includes("WPT oracle"));
const sel = selectLessons({ lessons: path.join(e1.CREWBUS_DIR, "lessons") }, { scopes: ["audit"], limit: 8 });
check("selectLessons: audit scope + global injected", sel.length === 2 && sel[0].text.includes("commit artifacts") && sel.some((l) => l.text.includes("WPT oracle")));

// ------------------------------------------------------------- needs-by mail
run(["send", "--from", "lead", "--to", "worker-a", "--needs-by", "1s", "--body", "urgent a"], e1);
run(["send", "--from", "lead", "--to", "worker-a", "--needs-by", "1h", "--body", "not due yet"], e1);
run(["send", "--from", "lead", "--to", "worker-a", "--needs-by", "1s", "--checkpoint", "--body", "checkpoint c"], e1);
await new Promise((r) => setTimeout(r, 1300));
const od = JSON.parse(run(["inbox", "--from", "worker-a", "--overdue", "--json"], e1));
check("inbox --overdue: only past-deadline non-checkpoint open items", od.length === 1 && od[0].body === "urgent a" && od[0].needsBy !== undefined);
const odDigest = run(["inbox", "--from", "worker-a", "--overdue", "--digest"], e1);
check("digest marks overdue", odDigest.includes("[OVERDUE]"));
const notOd = JSON.parse(run(["inbox", "--from", "worker-a", "--json", "--grep", "not due"], e1));
check("future needs-by NOT overdue", notOd.length === 1 && notOd[0].needsBy !== undefined);

// ----------------------------------------------- gather metrics end-to-end
run(["group", "create", "audit", "--add", "worker-a,worker-b"], e1);
const fan = run(["send", "--from", "lead", "--to-group", "audit", "--subject", "audit lane", "--body", "do the audit"], e1);
const batchId = (fan.match(/batch (batch-\d{6}-\d{6}-[0-9a-f]{8})/) || [])[1];
check("fan-out send echoes a batch id", !!batchId);
const briefIds = [...fan.matchAll(/(msg-\d{6}-\d{6}-[0-9a-f]{8}) -> worker-(a|b)/g)].map((m) => m[1]);
check("fan-out send echoes per-recipient ids", briefIds.length === 2);
const g0 = run(["gather", "--batch", batchId], e1);
check("gather text footer: zero-artifact line", g0.includes("workbench: no artifacts referenced"));

// because a fan-out of 2 uses a shared batch id, re-check that collectBatch
// sees things when the reply targets a brief message id inside the batch.
run(["send", "--from", "worker-b", "--to", "lead", "--reply", briefIds[0], "--artifact", artId, "--body", `reused ${artId} for the inflate check`], e1);
run(["send", "--from", "worker-a", "--to", "lead", "--reply", briefIds[1], "--artifact", artId, "--body", `confirmed ${artId}`], e1);
const paste = run(["artifact", "publish", "--from", "worker-a", "--path", "notes/art-6.js", "--summary", "second artifact", "--deps", artId], e1);
const art2 = (paste.match(/art-\d{6}-\d{6}-[0-9a-f]{8}/) || [""])[0];
run(["send", "--from", "worker-a", "--to", "lead", "--reply", briefIds[1], "--artifact", art2, "--body", `published ${art2}`], e1);
const gJson = JSON.parse(run(["gather", "--batch", batchId, "--json"], e1));
check("gather --json carries workbench metrics object", !!gJson.workbench);
check("gather metrics: cross-agent feed-forward edge counted", gJson.workbench.feedForward === 1 && gJson.workbench.artifactRefs === 2 && gJson.workbench.producers === 1);
check("gather metrics: adoption reflected", gJson.workbench.adopted === 1);

// ------------------------------------------------- spawn brief injection e2e
const dry = run(["spawn", "--dry-run", "--from", "lead", "--to", "worker-a", "--to-group", "audit", "--needs-by", "10m", "--body", "go audit"], e1);
check("spawn dry-run brief injects the Workbench block", dry.includes("Workbench (lessons + artifacts") && dry.includes("WPT oracle"));
check("spawn dry-run brief lists board artifacts", dry.includes(artId));
const dryPrompt = dry.slice(dry.indexOf("--- prompt (first worker) ---"));
check("spawn dry-run prompt pins the lead recipient", dryPrompt.includes("EXACTLY --to lead"));

// ----------------------------------------------------------------- cleanup
fs.rmSync(p1, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall workbench tests passed");
