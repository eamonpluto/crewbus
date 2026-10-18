import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

import { msQuote, shQuote, shellChildSpec, shellChildOptions } from "../bin/lib/kidproc.js";
import { resolveShellShot } from "../bin/lib/spawn.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// msQuote — wrap only when needed; correct MS escaping inside wraps
// ---------------------------------------------------------------------------
check("msQuote: empty -> empty quotes", eq(msQuote(""), '""'));
check("msQuote: plain token untouched", eq(msQuote("claude"), "claude"));
check("msQuote: tool list comma stays bare", eq(msQuote("Read,Edit,Write,Bash"), "Read,Edit,Write,Bash"));
check("msQuote: path without spaces stays bare", eq(msQuote("C:\\dir\\"), "C:\\dir\\"));
check("msQuote: spaces wrap", eq(msQuote("a b"), '"a b"'));
check("msQuote: inner quote escaped", eq(msQuote('say "hi"'), '"say \\"hi\\""'));
check("msQuote: trailing backslash doubled inside wrap", eq(msQuote("C:\\dir with space\\"), '"C:\\dir with space\\\\"'));
check("msQuote: backslash before inner quote -> 2n+1", eq(msQuote('a\\"b'), '"a\\\\\\"b"'));
check("msQuote: lone quote wrapped", eq(msQuote('"'), '"\\""') && msQuote('"').startsWith('"\\"'));
check("msQuote: cmd metachars wrap (bare & splits lines)", eq(msQuote("a&b|c^d"), '"a&b|c^d"'));
check("msQuote: percent wraps too", eq(msQuote("100%"), '"100%"'));
check("msQuote: redirect+pipe wrap", eq(msQuote("a<b>c"), '"a<b>c"'));
check("msQuote: benign token with metachar-free text bare", eq(msQuote("Read,Edit,Write,Bash"), "Read,Edit,Write,Bash"));

// ---------------------------------------------------------------------------
// shQuote — POSIX single-quote joining
// ---------------------------------------------------------------------------
check("shQuote: safe token untouched", eq(shQuote("codex"), "codex"));
check("shQuote: spaces single-quoted", eq(shQuote("a b"), "'a b'"));
check("shQuote: inner quote spliced", eq(shQuote("it's"), "'it'\\''s'"));

// ---------------------------------------------------------------------------
// shellChildSpec — wire shape per platform
// ---------------------------------------------------------------------------
check("spec: empty args -> null (no DEP0190 case anyway)", eq(shellChildSpec("node", []), null));
const winSpec = shellChildSpec("claude", ["-p", "--output-format", "json"]);
check("spec: win routes through cmd.exe (+ /d /s /c)", winSpec !== null && winSpec.exe === "cmd.exe" && eq(winSpec.args.slice(0, 3), ["/d", "/s", "/c"]));
check("spec: win line keeps order", /claude\s+-p\s+--output-format\s+json\s*$/.test(String(winSpec.args[3]).replace(/"$/, "")));
const uxSpec = shellChildSpec("claude", ["-p"], "linux");
check("spec: posix routes through /bin/sh -c", uxSpec.exe === "/bin/sh" && eq(uxSpec.args[0], "-c"));
check("spec: platform override honored", shellChildSpec("x", ["a"], "linux").exe === "/bin/sh");

// ---------------------------------------------------------------------------
// ARGV IDENTITY round-trip through the REAL cmd parser: the child must see
// exactly what the caller passed — the invariant the deprecated wire broke.
// Vectors route through `node -e <dump> -- <dut>`: node consumes the `--` so
// its own CLI option parser (which is NOT part of the quoting contract)
// never eats leading dashes of the fetched args.
// ---------------------------------------------------------------------------
if (process.platform === "win32") {
  const inline = `console.log(JSON.stringify(process.argv.slice(process.argv[1]==='--'?2:1)))`;
  const vectors = [
    ["-p", "--output-format", "json", "Read,Edit,Write,Bash"],
    ["arg one", "plain", ""],
    ['has "quote"', "q\"q", "say 'hi'"],
    ["C:\\dir with space\\", "C:\\t\\", "trail\\"],
    ["a&b|c^d", "100%", "sem;i:col"],
    ["two  spaces", "\ttab", "--dash-y"],
    ["redirect<y>pipe", "par(en)th"],
  ];
  for (const v of vectors) {
    const spec = shellChildSpec("node", ["-e", inline, "--", ...v]);
    const r = spawnSync(spec.exe, spec.args, { shell: false, encoding: "utf8", ...shellChildOptions(), windowsHide: true });
    let got = null;
    try { got = JSON.parse(String(r.stdout).trim()); } catch {}
    check(`cmd round-trip identity: ${JSON.stringify(v).slice(0, 58)}`, eq(got, v));
  }
} else {
  // /bin/sh round-trip identity (posix lanes)
  const inline = `console.log(JSON.stringify(process.argv.slice(process.argv[0]==='--'?process.argv.slice(1):process.argv.slice(0))))`;
  const vectors = [["-p", "json"], ["arg one", ""], ["it's", 'has "quote"'], ["a&b|c^d"], ["--dash", "sem;i:col"]];
  for (const v of vectors) {
    const spec = shellChildSpec("node", ["-e", `console.log(JSON.stringify(process.argv.slice(1)))`, "--", ...v]);
    const r = spawnSync(spec.exe, spec.args, { shell: false, encoding: "utf8" });
    let got = null;
    try { got = JSON.parse(String(r.stdout).trim()); } catch {}
    check(`sh round-trip identity: ${JSON.stringify(v).slice(0, 58)}`, eq(got, v));
  }
}

// ---------------------------------------------------------------------------
// launcher migration shape: resolveShellShot turns only shell-needing
// targets into an explicit shell argv0 (no DEP0190); real-exe shell:false
// targets pass through untouched; CREWBUS_SHELL_LEGACY=1 = pre-refactor
// passthrough for exactly one release.
// ---------------------------------------------------------------------------
{
  const shot = resolveShellShot("claude", ["-p", "--output-format", "json"], true);
  check("shot: shell target migrates to cmd.exe argv0", shot.exe === "cmd.exe" && shot.shell === false && shot.args[0] === "/d" && shot.args[1] === "/s" && shot.args[2] === "/c");
  check("shot: verbatim option carried", shot.extraOptions.windowsVerbatimArguments === true);
  const untouched = resolveShellShot("C:\\tools\\opencode.exe", ["run"], false);
  check("shot: real-exe shell:false untouched (pid = harness process)", eq(untouched, { exe: "C:\\tools\\opencode.exe", args: ["run"], shell: false, extraOptions: {} }));
  const old = process.env.CREWBUS_SHELL_LEGACY;
  process.env.CREWBUS_SHELL_LEGACY = "1";
  const shotLegacy = resolveShellShot("claude", ["-p"], true);
  check("shot: legacy escape hatch passthrough", eq(shotLegacy, { exe: "claude", args: ["-p"], shell: true, extraOptions: {} }));
  if (old === undefined) delete process.env.CREWBUS_SHELL_LEGACY; else process.env.CREWBUS_SHELL_LEGACY = old;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nkidproc suite passed");
