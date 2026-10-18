// bin/lib/kidproc.js — shell-mode child processes without DEP0190.
//
// Node >=22 deprecates `spawn(exe, args, { shell: true })` when `args` is
// non-empty (DEP0190) — args are passed through the shell UNESCAPED (the
// warning exists because the old wire is unsafe: `"arg one"` emitted raw
// splits into two argv tokens on the receiving process). This module
// reproduces the intended semantics with CORRECT quoting:
//
//   Windows  old: spawn(exe, args, { shell:true })   (unescaped raw concat)
//            new: spawn("cmd.exe", ["/d","/s","/c", quoted line],
//                      { windowsVerbatimArguments: true })
//   POSIX    old: spawn(exe, args, { shell:true })
//            new: spawn("/bin/sh", ["-c", quoted line], { shell:false })
//
// (On win32 `windowsVerbatimArguments` matters: without it node re-quotes the
// already-quoted outer string and cmd would double-parse the escapes.)
//
// NOTE: this is intentionally NOT bit-identical to the deprecated wire —
// the old wire mangled args (space splitting, quote eating) and let bare
// cmd metacharacters (& | ^) inject into the command line. The regression
// bar here is argv IDENTITY: what the child receives equals what the
// caller passed. Known cmd limitation documented here: a matched %VAR%
// pattern inside a quoted token still expands at the cmd layer (no escape
// exists for cmd quoted context) — unmatched % passes through intact.
// Standalone by design (see docs/SPLIT.md): zero local imports, cycle-free.
// Escape hatch for exactly one release: CREWBUS_SHELL_LEGACY=1 restores the
// pre-refactor `shell: true` behavior at call sites.

const WIN_SHELL = "cmd.exe";
const POSIX_SHELL = "/bin/sh";

// MS CRT / CreateProcess argument quoting, plus the cmd.exe pass layer:
// wrap on whitespace, quotes, AND cmd metacharacters (& | ^ < > %) — bare
// metachars split commands even inside the overall quoted /c line (probes:
// "a&b|c^d" quoted argv arrives intact; bare flexes). Inside the wrap:
// backslashes double before quotes per MS standard, % stays raw (cmd does
// NOT expand unmatched %; a matched %VAR% *does* expand even inside quotes —
// a known cmd limitation, no escape hatch exists — see docs note), ^ is
// literal inside quotes. Bare tokens without any of those pass unwrapped
// (already valid single argv tokens).
function msQuote(s) {
  s = String(s);
  if (s === "") return '""';
  if (!/[\s"&|^<>%]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const c of s) {
    if (c === "\\") { backslashes++; continue; }
    if (c === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + c;
    }
    backslashes = 0;
  }
  // Backslashes before the closing wrap double up too.
  out += "\\".repeat(backslashes * 2);
  return out + '"';
}

// POSIX single-quote joining (' -> '\'').
function shQuote(s) {
  s = String(s);
  // A bare empty token would vanish outright (two words `a ''` parse to
  // [a, ""] — `a ` parses to [a] only), losing the operand.
  if (s === "") return "''";
  return /^[-#%+,.:;=?@_a-zA-Z0-9\/]*$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// { exe, args } one should hand to spawn(..., { shell: false }) to keep the
// old shell:true semantics for (exe, args). Returns null when args is empty
// — callers keep their existing behavior in that case (empty args never hit
// DEP0190).
function shellChildSpec(exe, args, platform = process.platform) {
  const a = (args || []).map(String);
  if (a.length === 0) return null;
  const line = [String(exe), ...a];
  if (platform === "win32") {
    return { exe: WIN_SHELL, args: ["/d", "/s", "/c", `"${line.map(msQuote).join(" ")}"`] };
  }
  return { exe: POSIX_SHELL, args: ["-c", line.map(shQuote).join(" ")] };
}

// Spawn-time options a caller must add when using shellChildSpec output.
function shellChildOptions(platform = process.platform) {
  return platform === "win32" ? { windowsVerbatimArguments: true } : {};
}

export { msQuote, shQuote, shellChildSpec, shellChildOptions };
