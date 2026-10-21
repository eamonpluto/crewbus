// Phase 1 pure extraction from bin/crewbus.js — tokens + RBAC.
// Verbatim copies (only `export` + imports added). Do NOT edit the monolith yet;
// Phase 2 will cut the originals and wire imports.
// Source: bin/crewbus.js (see line numbers in comments).
// External refs left unresolved (stay in monolith for Phase 2):
//   readGroup (authorizeCheck), webErr (authorizeThrow), stampSyncDoc (touchAgent).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, writeJson, writeExclusiveJson, chmodAgentFile, getFlag, fail, BOARD_VERSION, stampSyncDoc, webErr } from "./store.js";
import { readGroup } from "./groups.js";

// Identity: first claim wins, token after that. Tokens stop CLI-level
// --from spoofing; they do NOT stop local file tampering (anyone with shell
// access can edit .crewbus/ directly) — separate boards per trust zone.
// §4.4: agent files store ONLY a salted hash ({tokenHash, salt}, never
// plaintext). Plaintext is printed once at mint. Legacy files with a
// plaintext `token` field are accepted once, then migrated to a hash.
// Sync NEVER replicates token/tokenHash/salt (see sanitizeAgentForSync).
export function mintToken() { // line 224
  return `abt-${crypto.randomBytes(18).toString("hex")}`;
}

export function newSalt() { // line 228
  return crypto.randomBytes(16).toString("hex");
}

export function hashToken(token, salt) { // line 232
  return crypto.createHash("sha256").update(String(salt) + String(token)).digest("hex");
}

export function timingSafeEqualStr(a, b) { // line 236
  const sa = String(a), sb = String(b);
  const ba = Buffer.from(sa), bb = Buffer.from(sb);
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return sa === sb;
  }
}

export function writeAgentFile(d, name, doc) { // line 254
  const p = path.join(d.agents, `${name}.json`);
  writeJson(p, doc);
  chmodAgentFile(p);
  return doc;
}

// After minting over an EXISTING record (legacy takeover, post-revoke
// re-claim, admin grant), confirm our token won the file. Parallel minters
// must fail loudly instead of printing a dead token. Fresh claims use
// exclusive create instead (see ensureSender / cmdRegister).
export function assertMintWon(d, name, tokenHash) { // line 265
  const check = readAgent(d, name);
  if (!check || check.tokenHash !== tokenHash) {
    fail(`name "${name}" is claimed (concurrent registration raced — retry)`);
  }
}

// True when the presented token matches the record (hash or legacy plaintext).
export function agentTokenMatches(rec, token) { // line 273
  if (!rec || token === undefined || token === null || String(token) === "") return false;
  const t = String(token);
  if (rec.tokenHash && rec.salt) {
    try {
      return timingSafeEqualStr(hashToken(t, String(rec.salt)), String(rec.tokenHash));
    } catch {
      return false;
    }
  }
  return false;
}

export function stripAgentSecrets(doc) { // line 287
  if (!doc || typeof doc !== "object") return doc;
  const { token, tokenHash, salt, ...rest } = doc;
  return rest;
}

// Sync-safe agent doc: secrets stripped, presence/cursor/spawn fields kept.
// Incoming synced docs are merged the same way (local secrets win).
export function sanitizeAgentForSync(doc) { // line 295
  return stripAgentSecrets(doc);
}

export function mergeSyncedAgent(local, incoming) { // line 299
  const clean = sanitizeAgentForSync(incoming);
  if (!local) return clean;
  const merged = { ...clean };
  if (local.tokenHash !== undefined) merged.tokenHash = local.tokenHash;
  if (local.salt !== undefined) merged.salt = local.salt;
  return merged;
}

export function resolveToken(args) { // line 310
  const flag = getFlag(args, "--token");
  if (flag !== undefined) return flag;
  const env = process.env.CREWBUS_TOKEN;
  return env === undefined || env === "" ? undefined : env;
}

export function readAgent(d, name) { // line 317
  try {
    return readJson(path.join(d.agents, `${name}.json`));
  } catch {
    return null;
  }
}

// Phase 1a: per-identity token lifecycle (expiry, revocation, service,
// offboarding). Agent docs may carry expiresAt (ISO|null), rotatedAt (ISO),
// service (bool), offboarded (bool), revokedAt (ISO). Secrets stay local:
// sync replicates the flags, never token/tokenHash/salt (see sanitize).
export function revokedPathForHash(d, tokenHash) { // line 329
  const prefix = String(tokenHash).slice(0, 16) || "unknown";
  return path.join(d.revoked || path.join(d.root, "revoked"), `${prefix}.json`);
}

export function isHashRevoked(d, tokenHash) { // line 334
  if (!tokenHash) return null;
  try {
    const dir = d.revoked || path.join(d.root, "revoked");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const doc = readJson(path.join(dir, f));
        if (doc && doc.tokenHash === String(tokenHash)) return doc;
        // Prefix-named file without full hash inside (legacy): match by name.
        if (doc && !doc.tokenHash && f.replace(/\.json$/, "") === String(tokenHash).slice(0, 16)) return doc;
      } catch {}
    }
  } catch {}
  return null;
}

export function tokenExpired(rec) { // line 351
  if (!rec || rec.expiresAt === undefined || rec.expiresAt === null) return false;
  const t = Date.parse(rec.expiresAt);
  return !Number.isNaN(t) && t <= Date.now();
}

// Acting as a KNOWN agent requires its token. Unknown names fail here —
// claim them with send (first send mints the token) or register.
// Legacy plaintext `token` files are accepted once, then re-hashed and the
// plaintext is dropped (migration).
export function checkToken(d, agent, token) { // line 361
  const rec = readAgent(d, agent);
  if (!rec) fail(`unknown agent "${agent}" — claim it first: register --from ${agent} (or just send --from ${agent}, first send mints its token)`);
  if (rec.offboarded) fail(`agent "${agent}" is offboarded — sends as that name are refused (inbox preserved for audit; ask an admin to re-onboard)`);
  if (tokenExpired(rec)) fail(`token for "${agent}" expired at ${rec.expiresAt} — re-register to renew: register --from ${agent} --token <old-or-new> --expires-in <dur>`);
  if (rec.revokedAt || (rec.tokenHash && isHashRevoked(d, rec.tokenHash))) fail(`token for "${agent}" is revoked — re-register to mint a fresh one: register --from ${agent}`);
  if (rec.tokenHash && rec.salt) {
    if (!agentTokenMatches(rec, token)) fail(`bad token for "${agent}" (pass --token or set CREWBUS_TOKEN)`);
    return rec;
  }
  fail(`bad/missing token hash for "${agent}" — re-register to claim it: register --from ${agent}`);
}

// First send as a new name mints its record + token (same first-claim-wins
// as register, zero extra round-trip). Returns { created } so callers can
// print the token exactly once — it is never shown again via send.
export function ensureSender(d, agent, token) { // line 387
  const sentinel = reservedNameReason(agent);
  if (sentinel) fail(sentinel);
  const rec = readAgent(d, agent);
  if (!rec) {
    if (isBoardFrozen(d)) fail(`board is frozen — new registrations refused (ask an admin to register --from <admin> --for ${agent})`);
    const fresh = mintToken();
    const salt = newSalt();
    // Fresh claims race (parallel first sends): exactly one may win, via
    // atomic exclusive create. Losers re-read and authenticate normally.
    const p = path.join(d.agents, `${agent}.json`);
    const claimed = writeExclusiveJson(p, {
      name: agent, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
      lastDir: process.cwd(), tokenHash: hashToken(fresh, salt), salt,
      role: defaultRoleForNew(d),
    });
    if (!claimed) {
      const again = readAgent(d, agent);
      if (!again || (!again.token && !again.tokenHash) || !agentTokenMatches(again, token)) {
        fail(`bad token for "${agent}" (pass --token or set CREWBUS_TOKEN)`);
      }
      return { created: false };
    }
    chmodAgentFile(p);
    return { created: true, token: fresh };
  }
  if (!rec.tokenHash && !rec.token) {
    if (rec.offboarded) fail(`agent "${agent}" is offboarded — sends as that name are refused (inbox preserved for audit)`);
    if (rec.revokedAt) fail(`token for "${agent}" is revoked — re-register to mint a fresh one: register --from ${agent}`);
    const fresh = mintToken();
    const salt = newSalt();
    rec.tokenHash = hashToken(fresh, salt);
    rec.salt = salt;
    rec.lastSeen = new Date().toISOString();
    if (!rec.role) rec.role = defaultRoleForNew(d);
    writeAgentFile(d, agent, rec);
    assertMintWon(d, agent, rec.tokenHash);
    return { created: true, token: fresh };
  }
  if (!rec.tokenHash) fail(`bad/missing token hash for "${agent}" — re-register to claim: register --from ${agent}`);
  if (!agentTokenMatches(rec, token)) fail(`bad token for "${agent}" (pass --token or set CREWBUS_TOKEN)`);
  if (rec.offboarded) fail(`agent "${agent}" is offboarded — sends as that name are refused (inbox preserved for audit)`);
  if (tokenExpired(rec)) fail(`token for "${agent}" expired at ${rec.expiresAt} — re-register to renew: register --from ${agent} --token <old-or-new> --expires-in <dur>`);
  if (rec.revokedAt || (rec.tokenHash && isHashRevoked(d, rec.tokenHash))) fail(`token for "${agent}" is revoked — re-register to mint a fresh one: register --from ${agent}`);
  return { created: false };
}

// ---------------------------------------------------------------------------
// Identity recovery (C1): an agent that survives compaction/restart amnesia
// loses its name. The compaction hooks rehydrate from a session map; when
// even that is lost the harness texts used to mint throwaway identities
// (logs/unknown.token) that nobody owns. Two fixes: reserved sentinel names
// never mint, and a read-only recovery cross-check finds the real identity
// from what the board still knows.
// ---------------------------------------------------------------------------

// Scan logs/<name>.token: { name -> token | null } (best-effort; a missing
// or unreadable file is just "no evidence").
function listTokenFiles(d) {
  const out = new Map();
  try {
    for (const f of fs.readdirSync(path.join(d.root, "logs"))) {
      const m = /^([A-Za-z0-9_-]+)\.token$/.exec(f);
      if (!m) continue;
      try {
        const t = fs.readFileSync(path.join(d.root, "logs", f), "utf8").trim();
        if (t) out.set(m[1], t);
      } catch {}
    }
  } catch {}
  return out;
}

// { name, role, sessionId, lastDir, lastSeen, tokenHash, salt } for the scan.
function findAgentRecords(d) {
  const records = [];
  try {
    for (const f of fs.readdirSync(d.agents)) {
      if (!f.endsWith(".json")) continue;
      try {
        const doc = readJson(path.join(d.agents, f));
        if (!doc || !doc.name || doc.offboarded) continue;
        records.push({
          name: String(doc.name),
          role: roleOfRecord(doc),
          sessionId: doc.sessionId || undefined,
          lastDir: doc.lastDir || undefined,
          lastSeen: doc.lastSeen || undefined,
          tokenHash: doc.tokenHash || undefined,
          salt: doc.salt || undefined,
        });
      } catch {}
    }
  } catch {}
  return records;
}

// Rank identity candidates for an amnesiac agent. Read-only, never throws.
// opts: { sessionID, cwd, hashToken?, loadTokenFile? } (injectors let the
// CLI do the token-file↔tokenHash cross-check; plugin copies ship a lite
// variant without hash-verify).
// Returns [{ name, role, score, proven, why }] best-first.
export function recoverIdentity(d, opts = {}) {
  const records = findAgentRecords(d);
  const tokens = listTokenFiles(d);
  const cwd = opts.cwd ? String(opts.cwd) : undefined;
  const sessionID = opts.sessionID ? String(opts.sessionID) : undefined;
  const canVerify = typeof opts.hashToken === "function" && typeof opts.loadTokenFile === "function";
  const cands = [];
  for (const rec of records) {
    let score = 0;
    let proven = false;
    const why = [];
    // Register-time session binding (register --session <id>) is the
    // strongest cross-check: it names THIS harness session explicitly.
    if (sessionID && rec.sessionId && rec.sessionId === sessionID) {
      score += 4;
      why.push("session id matches register binding");
    }
    // Token-file evidence: existence is a hint; a real cross-check against
    // the stored hash is proof (hashToken(token, salt) === tokenHash).
    if (tokens.has(rec.name)) {
      score += 1;
      why.push("token file exists for this name");
      if (canVerify && rec.tokenHash && rec.salt) {
        try {
          const t = opts.loadTokenFile(d.root, rec.name);
          if (t && opts.hashToken(t, rec.salt) === rec.tokenHash) {
            proven = true;
            score += 3;
            why.push("token file cross-checks the stored hash");
          }
        } catch {}
      }
    }
    if (cwd && rec.lastDir && arePathsSameDir(rec.lastDir, cwd)) {
      score += 1;
      why.push("worked from this directory");
    }
    if (score <= 0) continue;
    cands.push({ name: rec.name, role: rec.role, score, proven, why: why.join("; ") });
  }
  cands.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
  return cands;
}

// Case-insensitive directory comparison for Windows case-insensitivity +
// symlink noise tolerance (best-effort: trailing slashes, backslashes).
function arePathsSameDir(a, b) {
  const norm = (p) => String(p).replace(/[\\/]+$/, "").toLowerCase();
  if (norm(a) === norm(b)) return true;
  // Partial tolerance: a registered cwd may be a subpath of the board root.
  const aN = norm(a).split(/[\\/]/);
  const bN = norm(b).split(/[\\/]/);
  return aN.length !== bN.length && (aN.join("/").includes(bN.join("/")) || bN.join("/").includes(aN.join("/")));
}

// Reserved sentinel names never mint — they come from amnesia bugs, and
// minting them loses real identity data forever (the 10.0.9-run "lead"
// lockout came from exactly this).
export const RESERVED_SENTINELS = ["unknown", "me", "you"];

export function reservedNameReason(agent) {
  const s = String(agent || "").trim().toLowerCase();
  return RESERVED_SENTINELS.includes(s)
    ? `"${agent}" is a reserved sentinel name (amnesia-throwaway) — identity lost? run: crewbus recover, then re-register/claim your real name`
    : null;
}

// ---------------------------------------------------------------------------
// Phase 1b RBAC + per-board ACLs + group-scoped send permissions.
//
// Composes with the token crew: call authorize() AFTER checkToken() passes
// (never before, never instead). checkToken proves WHO you are; authorize
// decides WHAT your role may do. Do not merge into checkToken.
//
// Roles (agent record `role` in {admin, lead, worker, auditor}):
//   - first-registered agent on a board becomes admin, everyone else gets
//     acl.defaultRole (default "worker"). `register --role` is only honored
//     when the caller is admin, else ignored-with-warning.
//   - legacy records without `role` map to `lead` so existing crews keep
//     working (documented in docs/RBAC.md).
// Permission matrix (minimal):
//   - admin: all, incl. role grants / offboard / prune / acl set /
//     group restrict / serve --allow-remote-spawn.
//   - lead: send / spawn / respawn / pool / spawn-kill (OWN crew only:
//     target.spawnedBy must equal caller, or target never spawned;
//     respawn --force reuses the spawn-kill scope check) / group manage /
//     result record / race close / channel post / lock / inbox / ack /
//     redeliver + all reads.
//   - worker: send / inbox / ack / redeliver / lock (scoped: release still
//     requires ownership) / channel tail (read) + all reads. No spawn,
//     no kills, no group mgmt, no channel post, no result/race writes.
//   - auditor: read-only everything (inbox / gather / thread / log /
//     channel tail / group show / result show / spawn-status, ...). Zero
//     writes: send/spawn/kill/prune/ack/lock/channel-post all refused.
// Reads not listed above default-allow (fail-closed only for writes).
// ---------------------------------------------------------------------------

export const VALID_ROLES = ["admin", "lead", "worker", "auditor"]; // line 470

export function cleanRole(raw) { // line 472
  const r = String(raw || "").trim().toLowerCase();
  if (!VALID_ROLES.includes(r)) fail(`invalid --role "${raw}" (want admin|lead|worker|auditor)`);
  return r;
}

export function roleOfRecord(rec) { // line 478
  if (rec && typeof rec.role === "string" && VALID_ROLES.includes(String(rec.role).toLowerCase())) {
    return String(rec.role).toLowerCase();
  }
  return "lead"; // back-compat: boards/agents predating roles act as lead
}

export function getRole(d, agent) { // line 485
  return roleOfRecord(readAgent(d, agent));
}

export function countAgentRecords(d) { // line 489
  try {
    return fs.readdirSync(d.agents).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function readBoardAcl(d) { // line 497
  let meta = null;
  try {
    meta = readJson(path.join(d.root, "board.json"));
  } catch {
    meta = null;
  }
  const acl = (meta && typeof meta.acl === "object" && meta.acl) || {};
  const def = typeof acl.defaultRole === "string" && VALID_ROLES.includes(String(acl.defaultRole).toLowerCase())
    ? String(acl.defaultRole).toLowerCase()
    : "worker";
  return { defaultRole: def, frozen: acl.frozen === true };
}

export function writeBoardAcl(d, acl) { // line 511
  const p = path.join(d.root, "board.json");
  let meta = {};
  try {
    meta = readJson(p);
  } catch {
    meta = { name: "board", version: BOARD_VERSION, createdAt: new Date().toISOString() };
  }
  meta.acl = acl;
  writeJson(p, meta);
}

export function isBoardFrozen(d) { // line 523
  return readBoardAcl(d).frozen === true;
}

// Role for a brand-new agent record: first agent on the board becomes admin,
// everyone else gets acl.defaultRole (default "worker").
export function defaultRoleForNew(d) { // line 529
  return countAgentRecords(d) === 0 ? "admin" : readBoardAcl(d).defaultRole;
}

// Core RBAC decision: returns { ok, reason }. Never exits (CLI authorize()
// turns !ok into fail(); relay/MCP turn it into 403/throw). Restricted-group
// scope is checked here too when scope.toGroups is present: a send/spawn
// addressing a restricted group is allowed only for admin/lead or a member.
export function authorizeCheck(d, agent, action, scope) { // line 537
  const role = getRole(d, agent);
  const act = String(action || "");
  const ADMIN_ONLY = new Set(["prune", "acl-set", "role-grant", "offboard", "group-restrict", "serve-remote", "import", "snapshot-schedule", "quota-set", "hold-place", "hold-lift", "pairing"]);
  const LEAD_PLUS = new Set(["spawn", "respawn", "pool", "group-manage", "result-record", "race-close"]);
  const WORKER_WRITES = new Set(["send", "ack", "redeliver", "lock", "artifact-write", "lesson-write"]);
  const EXPORT_ROLES = new Set(["admin", "auditor"]);
  if (act === "export") {
    if (!EXPORT_ROLES.has(role)) return { ok: false, reason: `role "${role}" cannot export (need admin|auditor)` };
  } else if (role === "admin") {
    // admins still honor restricted groups? No: admin/lead bypass membership.
  } else if (ADMIN_ONLY.has(act)) {
    return { ok: false, reason: `role "${role}" cannot ${act} (need admin)` };
  } else if (LEAD_PLUS.has(act)) {
    if (role !== "lead") return { ok: false, reason: `role "${role}" cannot ${act} (need lead|admin)` };
  } else if (act === "channel-post") {
    // Member-scoped channel posting (C4, default-on): workers may post to the
    // channels of groups they are a MEMBER of (scope.channelGroup); lead/admin
    // post anywhere (board channels + every group channel). Everyone else,
    // and workers targeting a foreign group's channel or a board channel with
    // no member mapping, are refused.
    if (role === "admin" || role === "lead") {
      // board-wide + group channels
    } else if (role !== "worker") {
      return { ok: false, reason: `role "${role}" cannot ${act} (member-posting is scoped to group members; need lead|admin)` };
    } else {
      const targetGroup = scope && scope.channelGroup ? String(scope.channelGroup) : undefined;
      if (!targetGroup) {
        return { ok: false, reason: `role "worker" may post only to a group channel it belongs to (${targetGroup === undefined ? "board channels are lead|admin" : "need lead|admin"})` };
      }
      const gdoc = readGroup(d, targetGroup);
      if (!gdoc) return { ok: false, reason: `channel group "${targetGroup}" not found (groups register their channels — board channels are lead|admin)` };
      const members = Array.isArray(gdoc.members) ? gdoc.members : [];
      if (!members.includes(agent)) return { ok: false, reason: `group channel "${targetGroup}" — members only (member or lead|admin)` };
    }
  } else if (act === "spawn-kill") {
    if (role !== "lead") return { ok: false, reason: `role "${role}" cannot spawn-kill (need lead|admin)` };
    const targets = (scope && Array.isArray(scope.targets)) ? scope.targets : [];
    for (const t of targets) {
      const rec = readAgent(d, t);
      if (rec && rec.spawnedBy && rec.spawnedBy !== agent) {
        return { ok: false, reason: `lead "${agent}" cannot kill "${t}" (spawned by ${rec.spawnedBy}; own crew only)` };
      }
    }
  } else if (WORKER_WRITES.has(act)) {
    if (role !== "lead" && role !== "worker") return { ok: false, reason: `role "${role}" cannot ${act} (auditor is read-only)` };
  } else {
    // reads (inbox/gather/thread/log/channel-tail/group-show/result-show/
    // race-start/spawn-status/agents/...) default-allow for all roles.
  }
  // Group-scoped sends: restricted groups need admin/lead or membership.
  const toGroups = (scope && Array.isArray(scope.toGroups)) ? scope.toGroups : [];
  if ((act === "send" || act === "spawn" || act === "pool") && toGroups.length > 0) {
    for (const g of toGroups) {
      const doc = readGroup(d, g);
      if (doc && doc.restricted === true) {
        const members = Array.isArray(doc.members) ? doc.members : [];
        if (role !== "admin" && role !== "lead" && !members.includes(agent)) {
          return { ok: false, reason: `group "${g}" is restricted (member or lead|admin only)` };
        }
      }
    }
  }
  return { ok: true, role };
}

// CLI chokepoint: call AFTER checkToken passes. Exits via fail() on denial.
export function authorize(d, agent, action, scope) { // line 584
  const r = authorizeCheck(d, agent, action, scope);
  if (!r.ok) fail(r.reason + ` [board ${d.root}]`);
  return r;
}

// Throwing twin for request handlers (relay /api/*) that must never exit.
export function authorizeThrow(d, agent, action, scope) { // line 591
  const r = authorizeCheck(d, agent, action, scope);
  if (!r.ok) throw webErr(403, r.reason);
  return r;
}

// Canonical agent-doc merge: every writer starts from prev and applies
// only its patch, so parallel writers (register, heartbeat, the dm-send
// tool, the dm-watch plugin) can never drop fields they don't own (spawn
// bookkeeping, tokens, roles). A patch key wins on any defined value —
// including false/0/"" — so callers MUST pass undefined for no-change.
// New agent-doc writers must use this or spread prev; never enumerate.
export function mergeAgentDoc(prev, patch) {
  const base = (prev && typeof prev === "object") ? { ...prev } : {};
  const p = (patch && typeof patch === "object") ? patch : {};
  for (const k of Object.keys(p)) {
    if (p[k] === undefined) delete base[k];
    else base[k] = p[k];
  }
  for (const k of Object.keys(base)) {
    if (base[k] === undefined) delete base[k];
  }
  return base;
}

// Loopback operator auto-provision (desktop plug-and-play):
// `serve`/`web` on 127.0.0.1 auto-creates an operator identity on first boot so
// the dashboard can launch without any terminal step. First agent on the
// board becomes admin (see defaultRoleForNew), so this is the board owner.
// Under the 3-lane model (boss / lead / peers), fresh boards mint `boss` as the
// desktop human operator, allowing crew bursts to auto-provision `lead` as the
// autonomous coordinator. Existing boards that already claimed `lead` (or `boss`)
// are kept without disruption.
// CLI boards are untouched: this only fires when operator is missing AND the
// bind is loopback. Returns { from, token } or null when not applicable.
export function ensureLoopbackOperator(d, host) {
  const loop = String(host || "127.0.0.1");
  if (loop !== "127.0.0.1" && loop !== "localhost" && loop !== "::1") return null;
  let recBoss = null, recLead = null;
  try { recBoss = readAgent(d, "boss"); } catch { recBoss = null; }
  try { recLead = readAgent(d, "lead"); } catch { recLead = null; }
  if (recBoss && (recBoss.tokenHash || recBoss.token)) return null; // already provisioned
  if (recLead && recLead.tokenHash) return null; // already provisioned (legacy board)
  if (countAgentRecords(d) > 0) return null; // board already has registered agents
  const fresh = mintToken();
  const salt = newSalt();
  const now = new Date().toISOString();
  let prev = null;
  try { prev = readJson(path.join(d.agents, "boss.json")); } catch { prev = null; }
  const { v, hlc } = stampSyncDoc(prev);
  const doc = mergeAgentDoc(prev, {
    name: "boss",
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
    tokenHash: hashToken(fresh, salt),
    salt,
    revokedAt: undefined,
    offboarded: undefined,
    role: "admin",
    v, hlc,
  });
  // Atomic first-claim: exactly one boot may win. Losers re-read below.
  let won = false;
  try {
    if (!prev) {
      won = writeExclusiveJson(path.join(d.agents, "boss.json"), doc);
    } else {
      writeAgentFile(d, "boss", doc);
      won = true;
    }
  } catch { won = false; }
  if (!won && !prev) {
    // Lost the race (parallel boot): read the winner, no token to return.
    return null;
  }
  if (won) {
    try { chmodAgentFile(path.join(d.agents, "boss.json")); } catch {}
    try {
      fs.mkdirSync(path.join(d.root, "logs"), { recursive: true });
      fs.writeFileSync(path.join(d.root, "logs", "boss.token"), fresh + "\n", "utf8");
      try { fs.chmodSync(path.join(d.root, "logs", "boss.token"), 0o600); } catch {}
    } catch {}
  }
  return won ? { from: "boss", token: fresh } : null;
}

export function touchAgent(d, name, extra) { // line 2647
  const p = path.join(d.agents, `${name}.json`);
  const now = new Date().toISOString();
  let prev = null;
  try {
    prev = readJson(p);
  } catch {}
  const { v, hlc } = stampSyncDoc(prev);
  const doc = mergeAgentDoc(prev, {
    name,
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
    ...(extra || {}),
    v, hlc,
  });
  writeAgentFile(d, name, doc);
  return doc;
}
