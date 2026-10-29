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
  const rec = readAgent(d, agent);
  if (!rec) {
    const sentinel = reservedNameReason(agent);
    if (sentinel) fail(sentinel);
    if (isBoardFrozen(d)) fail(`board is frozen — new registrations refused (ask the orchestrator to register --from orchestrator --for ${agent})`);
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
  if (s === ORCHESTRATOR_NAME) {
    return `"${agent}" is reserved for the board orchestrator (auto-provisioned by spawn; do not register it)`;
  }
  return RESERVED_SENTINELS.includes(s)
    ? `"${agent}" is a reserved sentinel name (amnesia-throwaway) - identity lost? run: crewbus recover, then re-register/claim your real name`
    : null;
}

// ---------------------------------------------------------------------------
// RBAC: two roles only.
//
//   orchestrator — the board's single control-plane identity. Reads and writes
//                  everything: spawn/respawn/kill, approvals, groups, channels,
//                  ACLs, pairing, admin operations. The board bootstraps exactly
//                  one, named `orchestrator` (see ensureOrchestrator).
//   worker       — the data plane. send/inbox/ack/redeliver/lock, artifacts,
//                  lessons, member-scoped channel posts. No control-plane acts.
//
// Records with any other/missing role are treated as workers (safe fallback:
// an unknown role can never gain orchestrator powers).
// Reads that are not routed through authorize() stay default-open.
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_NAME = "orchestrator";
export const VALID_ROLES = ["orchestrator", "worker"];

// Worker-allowed write/read actions. Everything else is orchestrator-only.
const WORKER_ACTIONS = new Set([
  "send", "inbox", "ack", "redeliver", "lock", "artifact-write", "lesson-write",
  "hold-status",
]);

export function cleanRole(raw) { // line 472
  const r = String(raw || "").trim().toLowerCase();
  if (!VALID_ROLES.includes(r)) fail(`invalid --role "${raw}" (want orchestrator|worker)`);
  return r;
}

export function roleOfRecord(rec) { // line 478
  if (rec && typeof rec.role === "string" && VALID_ROLES.includes(String(rec.role).toLowerCase())) {
    return String(rec.role).toLowerCase();
  }
  return "worker"; // unknown/missing role: never grant control-plane powers
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
  return { defaultRole: "worker", frozen: acl.frozen === true };
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

// Every self-registering identity is a worker. The orchestrator is minted only
// by ensureOrchestrator (spawn/bootstrap) or an explicit orchestrator grant.
export function defaultRoleForNew(d) { // line 529
  return "worker";
}

// Core RBAC decision: returns { ok, reason }. Never exits (CLI authorize()
// turns !ok into fail(); relay/MCP turn it into 403/throw). Restricted-group
// scope is checked here too when scope.toGroups is present.
export function authorizeCheck(d, agent, action, scope) { // line 537
  const role = getRole(d, agent);
  const act = String(action || "");
  if (role === "orchestrator") {
    // Full control plane.
  } else if (role === "worker") {
    if (act === "channel-post") {
      // Member-scoped: a worker may post only to a group channel it belongs to.
      const targetGroup = scope && scope.channelGroup ? String(scope.channelGroup) : undefined;
      if (!targetGroup) {
        return { ok: false, reason: `role "worker" may post only to a group channel it belongs to (board channels are orchestrator-only)` };
      }
      const gdoc = readGroup(d, targetGroup);
      if (!gdoc) return { ok: false, reason: `channel group "${targetGroup}" not found (board channels are orchestrator-only)` };
      const members = Array.isArray(gdoc.members) ? gdoc.members : [];
      if (!members.includes(agent)) return { ok: false, reason: `group channel "${targetGroup}" — members only` };
    } else if (!WORKER_ACTIONS.has(act)) {
      return { ok: false, reason: `role "worker" cannot ${act} (orchestrator only)` };
    }
  } else {
    return { ok: false, reason: `unknown role "${role}" (want orchestrator|worker)` };
  }
  // Group-scoped sends: restricted groups need the orchestrator or membership.
  const toGroups = (scope && Array.isArray(scope.toGroups)) ? scope.toGroups : [];
  if ((act === "send" || act === "spawn" || act === "pool") && toGroups.length > 0) {
    for (const g of toGroups) {
      const doc = readGroup(d, g);
      if (doc && doc.restricted === true) {
        const members = Array.isArray(doc.members) ? doc.members : [];
        if (role !== "orchestrator" && !members.includes(agent)) {
          return { ok: false, reason: `group "${g}" is restricted (member or orchestrator only)` };
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

// One standing control-plane identity per board. Called by spawn and by the
// local web/serve servers. Reads the existing token file when it still matches
// the record; otherwise mints (or rotates) and persists logs/orchestrator.token.
// Never fails for bookkeeping reasons; returns { from, token, created }.
export function ensureOrchestrator(d) {
  const name = ORCHESTRATOR_NAME;
  const tokenPath = path.join(d.root, "logs", `${name}.token`);
  const readTokenFile = () => {
    try {
      const t = fs.readFileSync(tokenPath, "utf8").trim();
      return t || null;
    } catch { return null; }
  };
  const writeTokenFile = (token) => {
    try {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, token + "\n", "utf8");
      try { fs.chmodSync(tokenPath, 0o600); } catch {}
    } catch {}
  };
  let prev = null;
  try { prev = readAgent(d, name); } catch { prev = null; }
  if (prev && prev.tokenHash) {
    const tok = readTokenFile();
    if (tok && agentTokenMatches(prev, tok)) return { from: name, token: tok, created: false };
  }
  const fresh = mintToken();
  const salt = newSalt();
  const now = new Date().toISOString();
  const { v, hlc } = stampSyncDoc(prev);
  const doc = mergeAgentDoc(prev, {
    name,
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
    tokenHash: hashToken(fresh, salt),
    salt,
    revokedAt: undefined,
    offboarded: undefined,
    role: "orchestrator",
    v, hlc,
  });
  // Fresh record: atomic first claim. Existing record (or lost race): rewrite
  // only when the token file is missing/stale, otherwise reuse the winner.
  if (!prev) {
    let won = false;
    try { won = writeExclusiveJson(path.join(d.agents, `${name}.json`), doc); } catch { won = false; }
    if (!won) {
      const again = readAgent(d, name);
      const tok = readTokenFile();
      if (again && again.tokenHash && tok && agentTokenMatches(again, tok)) {
        return { from: name, token: tok, created: false };
      }
    }
  } else {
    writeAgentFile(d, name, doc);
  }
  writeTokenFile(fresh);
  return { from: name, token: fresh, created: true };
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
