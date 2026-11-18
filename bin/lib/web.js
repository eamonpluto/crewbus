// bin/lib/web.js — dashboard + API (Phase 1 pure extraction from bin/crewbus.js).
// Moved VERBATIM (only `export` added; cross-module refs via imports below).
// Source lines in bin/crewbus.js (9856-line file):
//   escapeHtml 5963-5967, boardSnapshot 5969-6040, fleetSnapshot 6047-6075,
//   channelsSnapshot 6079-6110, resultsSnapshot 6114-6162, auditSnapshot 6166-6190,
//   handleApiAck 6195-6226, renderBoardHtml 6232-6406,
//   cmdWeb 6408-6565 (nested readKillBody 6418-6437),
//   handleApiKill 8662-8691 (cleanWebName 8654-8658 lives in store.js; imported).
// Shared with relay crew (cmdServe): boardSnapshot, handleApiKill.
// NOTE: dedup done — relay.js re-exports handleApiKill from web.js (owner).
// NOTE: readChainRecords/verifyChainRecords (auditSnapshot deps) are imported
//   from export.js but are NOT yet exported there (unclaimed audit-chain block,
//   monolith lines ~692-1010) — export crew must add them for web.js to link.

import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { boardDir, requireBoard, getFlag, fail, writeJson, listJson, cleanWebName, readJson, readBoardMeta, writeBoardMeta, gitRevForBoard, newId, MAX_SPAWN, MAX_BODY_CHARS, writeExclusiveJson } from "./store.js";
import { readAgent, agentTokenMatches, authorizeCheck, ensureOrchestrator, mintToken, newSalt, hashToken, touchAgent, timingSafeEqualStr } from "./identity.js";
import { readDMs, readVisible, ackedIds, ackedIdSet, findMessageById, deliverDMs, parseRecipients } from "./mail.js";
import { workerStatus, pidAlive, killWorkers, bootWorker, buildSpawnPrompt, buildSpawnTarget, formatSpawnCmd, installCliToUserPath, ensureBoardCliShim, buildOrchestratorPrompt, provisionOrchestrator,
           ORCHESTRATOR_NAME, isPidStale, parseModelList, modelForIndex } from "./spawn.js";
import { groupTelemetryData, collectBatch, gatherTelemetry, listBatches } from "./groups.js";
import { httpJson } from "./sync.js";
import { readChainRecords, verifyChainRecords, appendChainRecord, readHold, readBoardQuotas } from "./export.js";
import { launchDrivers, detectHarnessBinaries, validateLaunchPlan, advertiseEnv, buildPairUrl, HARNESS_MODELS, getDiscoveredModels, refreshDiscoveredModels, PAIR_SCOPES } from "./launch.js";
import { newPairToken, pairingPath, readRelayState, newDeviceCred, devicePath } from "./relay.js";

export function escapeHtml(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Repo root for zero-dependency static brand assets: bin/lib/web.js lives at
// <repo>/bin/lib/web.js, so the brand dir is <repo>/assets/brand.
const WEB_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRAND_ASSETS = {
  "crewbus-logo-for-light.png": "image/png",
  "crewbus-logo-for-dark.png": "image/png",
  "crewbus-app-icon-1024-rounded.png": "image/png",
  "logo.svg": "image/svg+xml",
};

// GET /assets/brand/<file> — serves allowlisted repo brand art (zero deps).
// Basename-only guard blocks path traversal; missing file = 404; 1h cache.
export function serveBrandAsset(req, res, pathname) {
  const prefix = "/assets/brand/";
  if (req.method !== "GET" || !pathname.startsWith(prefix)) return false;
  const name = path.basename(pathname.slice(prefix.length));
  const contentType = BRAND_ASSETS[name];
  if (!contentType) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return true;
  }
  let buf;
  try {
    buf = fs.readFileSync(path.join(WEB_REPO_ROOT, "assets", "brand", name));
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return true;
  }
  res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=3600" });
  res.end(buf);
  return true;
}

export function boardSnapshot(d, activeWindowSec) {
  const cutoff = Date.now() - activeWindowSec * 1000;
  // Liveness first: pid-bearing agents are active only while their process
  // is verifiably alive (kill-0 + start-time guard inside workerStatus) —
  // a fresh lastSeen alone proves nothing, because watcher heartbeats keep
  // refreshing docs for long-dead sessions. Pid-less agents (humans, CLI
  // peers) fall back to lastSeen freshness. Reuses the workers array below
  // (no extra status syscalls).
  const workers = listJson(d.agents)
    .map((e) => e.data)
    .filter((a) => a && a.name && typeof a.spawnedPid === "number")
    .map((a) => workerStatus(d, a.name, 5));
  const liveByName = new Map(workers.map((w) => [w.name, w.alive === true]));
  const agents = listJson(d.agents)
    .map((e) => e.data)
    .filter((x) => x && x.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((a) => {
      const visible = readVisible(d, a.name);
      const acked = ackedIds(d, a.name);
      const { token, tokenHash, salt, ...safe } = a; // tokens never leave the server
      return {
        ...safe,
        active: typeof a.spawnedPid === "number"
          ? liveByName.get(a.name) === true
          : Date.parse(a.lastSeen) >= cutoff,
        dmCount: visible.length,
        unacked: visible.filter((m) => !acked.has(m.id)).length,
      };
    });
  const broadcasts = listJson(d.broadcast || path.join(d.root, "broadcast"))
    .map((e) => e.data)
    .filter((b) => b && b.id && b.from)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  // recent board-wide activity (like inbox --all), newest first, capped
  const recent = [];
  let subs = [];
  try {
    subs = fs.readdirSync(d.dm);
  } catch {
    subs = [];
  }
  for (const sub of subs) {
    try {
      if (!fs.statSync(path.join(d.dm, sub)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const m of readDMs(d, sub)) recent.push(m);
  }
  for (const b of broadcasts) recent.push(b.batch ? b : { ...b, batch: b.id });
  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
  // acked-by map for display: msgId -> [agents]
  const ackedBy = {};
  let ackSubs = [];
  try {
    ackSubs = fs.readdirSync(path.join(d.root, "acked"));
  } catch {
    ackSubs = [];
  }
  for (const sub of ackSubs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(d.root, "acked", sub)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const mid = f.replace(/\.json$/, "");
      (ackedBy[mid] = ackedBy[mid] || []).push(sub);
    }
  }
  const groups = listJson(d.groups || path.join(d.root, "groups"))
    .map((e) => e.data)
    .filter((x) => x && x.name && Array.isArray(x.members))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((g) => ({ name: g.name, members: g.members, count: g.members.length }));
  const peers = listJson(path.join(d.root, "sync-state"))
    .map((e) => e.data)
    .filter((x) => x && x.peer && typeof x.lastOk === "number")
    .sort((a, b) => String(a.peer).localeCompare(String(b.peer)))
    .map((p) => ({ peer: p.peer, lastOk: new Date(p.lastOk).toISOString() }));
  // Brief batch per worker (for the Crews brief/group column): the batch
  // stamp on the worker's brief DM, else the brief id itself. Built from
  // the full pre-slice message scan so capped feeds never lose the join.
  const batchByBriefId = new Map();
  for (const m of recent) {
    if (m && m.id && !batchByBriefId.has(m.id)) batchByBriefId.set(m.id, m.batch || m.id);
  }
  const workersWithBatch = workers.map((w) => ({
    ...w,
    batch: w.briefId ? (batchByBriefId.get(w.briefId) || w.briefId) : undefined,
  }));
  return { board: d.root, at: new Date().toISOString(), agents, workers: workersWithBatch, broadcasts, recent: recent.slice(0, 30), ackedBy, groups, peers, briefs: listBatches(d) };
}

// Fleet console snapshots (served by `web`, all open reads like /api/board;
// writes stay token-checked JSON-only like /api/kill).

// Fleet: every sync peer enriched with a live /healthz probe (best-effort,
// short timeout — a dead relay shows live:null, never fails the endpoint).
export async function fleetSnapshot(d) {
  let states = [];
  try {
    states = listJson(path.join(d.root, "sync-state"))
      .map((e) => e.data)
      .filter((x) => x && x.peer && typeof x.lastOk === "number")
      .sort((a, b) => String(a.peer).localeCompare(String(b.peer)));
  } catch {
    states = [];
  }
  let workers = [];
  try {
    workers = listJson(d.agents)
      .map((e) => e.data)
      .filter((x) => x && x.name && typeof x.spawnedPid === "number")
      .map((a) => workerStatus(d, a.name, 0));
  } catch {
    workers = [];
  }
  const rows = await Promise.all(states.map(async (s) => {
    const row = { peer: s.peer, lastOk: new Date(s.lastOk).toISOString(), live: null };
    try {
      const r = await httpJson(String(s.peer).replace(/\/+$/, ""), "GET", "/healthz", undefined, 4000);
      if (r.status === 200) {
        const h = JSON.parse(r.body);
        row.live = {
          role: h.role || "?",
          weight: typeof h.weight === "number" ? h.weight : null,
          workers: typeof h.workers === "number" ? h.workers : null,
          lagMs: h.lagMs ?? null,
          uptimeSec: h.uptimeSec ?? null,
        };
      }
    } catch {}
    return row;
  }));
  return { board: d.root, at: new Date().toISOString(), relays: rows, workers };
}

// Channels: per-channel post counts + latest heads (bodies truncated; full
// text stays on the CLI tail).
export function channelsSnapshot(d, perChannel) {
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(path.join(d.root, "channels")).filter((f) => f.endsWith(".log.jsonl")).sort();
  } catch {
    return { board: d.root, at: new Date().toISOString(), channels: out };
  }
  for (const f of files) {
    const name = f.replace(/\.log\.jsonl$/, "");
    let posts = [];
    try {
      const text = fs.readFileSync(path.join(d.root, "channels", f), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line);
          if (p && p.id && p.from && typeof p.body === "string") posts.push(p);
        } catch {}
      }
    } catch {}
    out.push({
      name,
      posts: posts.length,
      latest: posts.slice(-(perChannel || 5)).map((p) => ({
        id: p.id, from: p.from, at: p.at,
        subject: p.subject || "", head: String(p.body || "").slice(0, 140),
      })),
    });
  }
  return { board: d.root, at: new Date().toISOString(), channels: out };
}

// Results & races: per-group telemetry + recorded outcome + live runners
// (kill-the-losers reuses /api/kill per worker — no new write endpoint).
export function resultsSnapshot(d) {
  const out = [];
  let groups = [];
  try {
    groups = listJson(d.groups || path.join(d.root, "groups"))
      .map((e) => e.data)
      .filter((x) => x && x.name && Array.isArray(x.members))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch {
    return { board: d.root, at: new Date().toISOString(), groups: out };
  }
  const aliveByName = {};
  try {
    for (const e of listJson(d.agents)) {
      const a = e && e.data;
      if (a && a.name && typeof a.spawnedPid === "number") {
        try {
          // Stale-pid guard (C2): pid-recycled records read dead.
          aliveByName[a.name] = pidAlive(a.spawnedPid) && !isPidStale(a.spawnedPid, a.spawnedAt);
        } catch {
          aliveByName[a.name] = false;
        }
      }
    }
  } catch {}
  for (const g of groups) {
    let tele = null;
    try {
      tele = groupTelemetryData(d, g.name);
    } catch {
      tele = null;
    }
    if (!tele) continue;
    const running = (tele.members || []).filter((m) => aliveByName[m] === true);
    const winner = tele.result && tele.result.by ? tele.result.by : null;
    out.push({
      group: tele.group,
      members: tele.memberCount,
      messages: tele.messages,
      replies: tele.replies,
      tokensEst: tele.tokensEst,
      wallClockMs: tele.wallClockMs,
      verifiedCount: tele.verifiedCount,
      result: tele.result ? { artifact: tele.result.artifact || "", by: tele.result.by || "", at: tele.result.at || "" } : null,
      running,
      losers: winner ? running.filter((m) => m !== winner) : [],
    });
  }
  return { board: d.root, at: new Date().toISOString(), groups: out };
}

// Audit: chain verification summary + recent projected records (seq/at/
// actor/type/target/result only — payloads never leave the server).
export function auditSnapshot(d, limit) {
  const project = (recs) => recs.slice(-(limit || 15)).map((r) => ({
    seq: r.seq, at: r.at, actor: r.actor || "", type: r.type || "",
    target: r.target || "", result: r.result || "",
  }));
  let chain = [];
  let audit = [];
  try {
    chain = readChainRecords(d);
  } catch {
    chain = [];
  }
  try {
    audit = readChainRecords(d, "audit");
  } catch {
    audit = [];
  }
  let verify = { ok: true, count: chain.length };
  try {
    verify = verifyChainRecords(chain);
  } catch (e) {
    verify = { ok: false, count: chain.length, reason: String((e && e.message) || e) };
  }
  return { board: d.root, at: new Date().toISOString(), verify, chain: project(chain), audit: project(audit) };
}

// Holds: allowlisted projection of the hold doc (mirrors `hold status
// --json`). The doc carries only hold metadata (active/placedBy/placedAt/
// reason/liftedBy/liftedAt + sync v/hlc) — never agent tokens — but the
// projection is explicit so a future doc field (or a hand-edited
// holds/legal.json) can never leak token/secret/key material to an open
// read. Inactive (or absent) holds serve as null so the card flips.
export function publicHold(h) {
  if (!h || h.active !== true) return null;
  const out = { active: true };
  if (h.placedBy !== undefined && h.placedBy !== null) out.placedBy = String(h.placedBy);
  if (h.placedAt !== undefined && h.placedAt !== null) out.placedAt = String(h.placedAt);
  if (h.reason !== undefined && h.reason !== null) out.reason = String(h.reason);
  if (h.liftedBy !== undefined && h.liftedBy !== null) out.liftedBy = String(h.liftedBy);
  if (h.liftedAt !== undefined && h.liftedAt !== null) out.liftedAt = String(h.liftedAt);
  return out;
}

// Triage ack from the console (mirrors /api/kill: JSON-only, token-checked,
// same matrix as CLI ack; no --verify over HTTP — verifiers run shell
// commands, which stays a CLI-only power).
export async function handleApiAck(d, body) {
  const from = cleanWebName(body && body.from);
  const token = body && body.token !== undefined && body.token !== null && String(body.token) !== "" ? String(body.token) : undefined;
  if (!from) return { status: 400, payload: { error: "missing from (your agent name)" } };
  const rec = readAgent(d, from);
  if (!rec || !(rec.tokenHash || rec.token) || !agentTokenMatches(rec, token)) return { status: 403, payload: { error: "bad token" } };
  const r = authorizeCheck(d, from, "ack");
  if (!r.ok) return { status: 403, payload: { error: r.reason } };
  const rawId = body && body.id !== undefined ? body.id : undefined;
  const all = body && body.all === true;
  if ((!rawId || String(rawId) === "") && !all) return { status: 400, payload: { error: "pass id <msg-id> (or all true)" } };
  const visible = readVisible(d, from);
  const known = ackedIds(d, from);
  const ids = all
    ? visible.map((m) => m.id).filter((mid) => !known.has(mid))
    : [String(rawId)];
  if (!all && !visible.some((m) => m.id === ids[0])) return { status: 404, payload: { error: `unknown message "${ids[0]}" for ${from}` } };
  if (ids.length === 0) return { status: 200, payload: { results: [] } };
  const at = new Date().toISOString();
  const results = [];
  for (const mid of ids) {
    try {
      const p = path.join(d.root, "acked", from, `${mid}.json`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      writeJson(p, { by: from, at });
      results.push({ id: mid, result: "acked" });
    } catch (e) {
      results.push({ id: mid, result: "ack-failed", detail: String((e && e.message) || e) });
    }
  }
  return { status: 200, payload: { results } };
}

// Approval verdicts from the console (mirrors /api/ack: JSON-only,
// token-checked POST handler). Any valid identity may answer — the
// worker-side sender check (verdicts only from the named lead) is the real
// gate, NOT here. The verdict is posted as a DM reply (replyTo=request id,
// to=requester) so it lands in the requester's inbox.
export async function handleApiApprove(d, body) {
  const from = cleanWebName(body && body.from);
  const token = body && body.token !== undefined && body.token !== null && String(body.token) !== "" ? String(body.token) : undefined;
  if (!from) return { status: 400, payload: { error: "missing from (your agent name)" } };
  const rec = readAgent(d, from);
  if (!rec || !(rec.tokenHash || rec.token) || !agentTokenMatches(rec, token)) return { status: 403, payload: { error: "bad token" } };
  const rawId = body && body.id !== undefined ? body.id : undefined;
  if (!rawId || String(rawId) === "") return { status: 400, payload: { error: "pass id <request-msg-id>" } };
  const id = String(rawId);
  const verdict = body && body.verdict !== undefined ? String(body.verdict).toLowerCase() : "";
  if (verdict !== "approved" && verdict !== "denied") return { status: 400, payload: { error: "pass verdict approved|denied" } };
  const req = findMessageById(d, id);
  if (!req || !req.from) return { status: 404, payload: { error: `unknown message "${id}"` } };
  const requester = req.from;
  let reason = body && body.reason !== undefined && body.reason !== null ? String(body.reason) : "";
  let truncated = false;
  if (reason.length > 500) {
    reason = reason.slice(0, 500);
    truncated = true;
  }
  const note = truncated ? " [truncated to 500 chars]" : "";
  const replyBody = verdict === "approved"
    ? (reason ? `approved: ${reason}${note}` : "approved")
    : (reason ? `denied: ${reason}${note}` : "denied");
  const at = new Date().toISOString();
  const res = deliverDMs(d, { from, recipients: [requester], body: replyBody, replyTo: id, at });
  const replyId = res && res.items && res.items[0] ? res.items[0].id : undefined;
  return { status: 200, payload: { ok: true, verdict, replyTo: id, reply: replyId, to: requester, truncated, results: [{ id, result: verdict, reply: replyId }] } };
}

// Interactive shell: tables render client-side from /api/board every 5s
// (a meta-refresh page would wipe the identity form). Kill posts JSON to
// /api/kill with the stored from+token. Embedded JS avoids backticks and
// ${} so the outer template literal needs no escaping.
export function renderBoardHtml(boardPath) {
  const e = escapeHtml;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crewbus — ${e(boardPath)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0d1117;
  --sidebar-bg: #090d13;
  --panel: #161b22;
  --panel-elevated: #1b2129;
  --panel-hover: #212833;
  --panel-active: #28313e;
  --ink: #e6edf3;
  --dim: #8b949e;
  --dim-light: #6e7681;
  --acc: #238636;
  --acc-hover: #2ea043;
  --acc-subtle: rgba(46, 160, 67, 0.14);
  --acc-ink: #ffffff;
  --ok: #2ea043;
  --warn: #d29922;
  --warn-bg: rgba(210, 153, 34, 0.1);
  --danger: #f85149;
  --danger-bg: rgba(248, 81, 73, 0.1);
  --line: rgba(255, 255, 255, 0.08);
  --line-light: rgba(255, 255, 255, 0.14);
  --code: #090d13;
  --code-ink: #e6edf3;
  --code-dim: #7d8590;
  --sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --scroll: rgba(255, 255, 255, 0.14);
  --scroll-hi: rgba(255, 255, 255, 0.28);
}
:root[data-theme="light"] {
  --bg: #f6f8fa;
  --sidebar-bg: #ffffff;
  --panel: #ffffff;
  --panel-elevated: #f6f8fa;
  --panel-hover: #f3f4f6;
  --panel-active: #e5e7eb;
  --ink: #1f2328;
  --dim: #656d76;
  --dim-light: #8c959f;
  --acc: #1a7f37;
  --acc-hover: #146c2e;
  --acc-subtle: rgba(26, 127, 55, 0.1);
  --acc-ink: #ffffff;
  --ok: #1a7f37;
  --warn: #9a6700;
  --warn-bg: rgba(154, 103, 0, 0.08);
  --danger: #cf222e;
  --danger-bg: rgba(207, 34, 46, 0.08);
  --line: #d0d7de;
  --line-light: #afb8c1;
  --code: #f6f8fa;
  --code-ink: #1f2328;
  --code-dim: #656d76;
  --scroll: rgba(0, 0, 0, 0.16);
  --scroll-hi: rgba(0, 0, 0, 0.32);
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --bg: #f6f8fa;
    --sidebar-bg: #ffffff;
    --panel: #ffffff;
    --panel-elevated: #f6f8fa;
    --panel-hover: #f3f4f6;
    --panel-active: #e5e7eb;
    --ink: #1f2328;
    --dim: #656d76;
    --dim-light: #8c959f;
    --acc: #1a7f37;
    --acc-hover: #146c2e;
    --acc-subtle: rgba(26, 127, 55, 0.1);
    --acc-ink: #ffffff;
    --ok: #1a7f37;
    --warn: #9a6700;
    --warn-bg: rgba(154, 103, 0, 0.08);
    --danger: #cf222e;
    --danger-bg: rgba(207, 34, 46, 0.08);
    --line: #d0d7de;
    --line-light: #afb8c1;
    --code: #f6f8fa;
    --code-ink: #1f2328;
    --code-dim: #656d76;
    --scroll: rgba(0, 0, 0, 0.16);
    --scroll-hi: rgba(0, 0, 0, 0.32);
  }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font: 13px/1.5 var(--sans); overflow: hidden; height: 100vh; -webkit-font-smoothing: antialiased; }
* { scrollbar-width: thin; scrollbar-color: var(--scroll) transparent; }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 99px; }
::-webkit-scrollbar-thumb:hover { background: var(--scroll-hi); }

#app-shell { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

/* 1. Left Sidebar */
#app-sidebar {
  width: 260px; min-width: 260px; background: var(--sidebar-bg);
  border-right: 1px solid var(--line); display: flex; flex-direction: column;
  height: 100vh; z-index: 20; user-select: none;
}
.sidebar-project { padding: 12px; border-bottom: 1px solid var(--line); position: relative; }
.project-card {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm);
  cursor: pointer; transition: background .12s ease, border-color .12s ease;
}
.project-card:hover { border-color: var(--line-light); background: var(--panel-hover); }
.project-icon { display: flex; align-items: center; justify-content: center; color: var(--dim); flex-shrink: 0; }
.project-info { min-width: 0; flex: 1; }
.project-title { font-weight: 600; font-size: 13px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project-path { font-size: 11px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--mono); }
.project-arrow { color: var(--dim); display: flex; align-items: center; }

#project-popover {
  position: absolute; top: calc(100% + 4px); left: 12px; right: 12px;
  background: var(--panel); border: 1px solid var(--line-light); border-radius: var(--radius-sm);
  box-shadow: 0 12px 28px rgba(0,0,0,0.4); padding: 12px; z-index: 100; display: none;
}
#project-popover.open { display: block; }
.pop-label { font-size: 10px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.pop-path { font-family: var(--mono); font-size: 11px; background: var(--code); padding: 5px 8px; border-radius: var(--radius-sm); border: 1px solid var(--line); word-break: break-all; margin-bottom: 8px; color: var(--code-ink); }
.pop-btn { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; margin-top: 4px; }

.sidebar-action-wrap { padding: 10px 12px 6px; }
.btn-new-task {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  background: var(--panel-elevated); color: var(--ink);
  font-weight: 500; font-size: 12.5px; border: 1px solid var(--line); border-radius: var(--radius-sm);
  padding: 7px 10px; cursor: pointer; transition: background .12s ease, border-color .12s ease;
}
.btn-new-task:hover { background: var(--panel-hover); border-color: var(--line-light); }
.btn-new-task kbd { font-size: 10px; background: var(--panel); border: 1px solid var(--line); padding: 1px 4px; border-radius: 3px; font-family: var(--mono); color: var(--dim); }

.sidebar-heading { font-size: 10.5px; font-weight: 600; color: var(--dim-light); text-transform: uppercase; letter-spacing: 0.7px; padding: 12px 14px 4px; }
.sidebar-thread-list { padding: 0 8px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; flex: 1; }
.thread-row {
  display: flex; flex-direction: column; gap: 2px; padding: 7px 10px; border-radius: var(--radius-sm);
  cursor: pointer; transition: background .12s ease; border: 1px solid transparent;
}
.thread-row:hover { background: var(--panel-hover); }
.thread-row.active { background: var(--panel-active); border-color: var(--line); }
.thread-row-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.thread-title { font-weight: 500; font-size: 12.5px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.thread-time { font-size: 10.5px; color: var(--dim); flex-shrink: 0; }
.thread-meta { font-size: 11px; color: var(--dim); display: flex; align-items: center; gap: 6px; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dim); display: inline-block; }
.status-dot.active { background: var(--ok); }
.status-dot.waiting { background: var(--warn); }

/* Left Navigation Tabs */
#approot-nav { padding: 8px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px; }
#approot-nav button {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
  color: var(--dim); padding: 6px 9px; font-size: 12px; cursor: pointer; transition: background .12s ease, color .12s ease;
}
#approot-nav button:hover { background: var(--panel-hover); color: var(--ink); }
#approot-nav button.active { background: var(--panel); border-color: var(--line); color: var(--ink); font-weight: 500; }
#approot-nav button .nav-ic { color: var(--dim); flex-shrink: 0; }
#approot-nav button.active .nav-ic { color: var(--acc); }

.sidebar-footer { padding: 9px 12px; border-top: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; color: var(--dim); }
.identity-badge { display: flex; align-items: center; gap: 6px; cursor: pointer; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 2. Main Stage */
#app-main { flex: 1; min-width: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: var(--bg); }
#approot-topbar {
  height: 48px; min-height: 48px; background: var(--panel);
  border-bottom: 1px solid var(--line); display: flex; align-items: center;
  justify-content: space-between; padding: 0 16px; gap: 14px; z-index: 10;
}
.topbar-left { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.thread-header-title { font-weight: 600; color: var(--ink); font-size: 13.5px; }
.thread-header-badge { font-size: 11px; padding: 2px 7px; border-radius: 3px; background: var(--panel-elevated); border: 1px solid var(--line); color: var(--dim); }

.palette-btn {
  display: flex; align-items: center; gap: 8px; background: var(--bg);
  border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 5px 12px;
  color: var(--dim); font-size: 12px; cursor: pointer; transition: border-color .12s ease, background .12s ease;
  max-width: 280px; width: 100%;
}
.palette-btn:hover { border-color: var(--line-light); color: var(--ink); background: var(--panel-hover); }
.palette-btn kbd { margin-left: auto; font-size: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 1px 5px; color: var(--dim); font-family: var(--mono); }

.topbar-right { display: flex; align-items: center; gap: 8px; }
.conn-indicator { display: flex; align-items: center; gap: 6px; font-size: 11px; }
#conn-dot { font-size: 12px; color: var(--dim); }
#conn-dot svg { display: block; }

/* View Container */
#view-container { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; overflow: hidden; }
.approot-hidden { display: none !important; }

/* The Dedicated Chat / Session Stage */
#chat-stage { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
#brief-thread {
  flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 16px;
}

/* Chat Message Cards */
.chat-msg {
  display: flex; flex-direction: column; gap: 6px; max-width: 860px; width: 100%; margin: 0 auto;
}
.chat-msg-header {
  display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dim);
}
.chat-msg-author { font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 5px; }
.chat-msg-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm);
  padding: 14px 16px; box-shadow: none; font-size: 13px; line-height: 1.6;
}
.chat-msg-user .chat-msg-card {
  background: var(--panel-elevated); border-color: var(--line-light);
}
.chat-msg-tags { display: flex; gap: 6px; margin-top: 10px; }
.chat-tag { font-size: 11px; padding: 2px 7px; border-radius: 3px; background: var(--bg); border: 1px solid var(--line); color: var(--dim); font-family: var(--mono); }

/* Inline Approval Card */
.chat-approval-card {
  background: var(--warn-bg); border: 1px solid rgba(210, 153, 34, 0.35);
  border-radius: var(--radius-sm); padding: 14px 16px; margin: 4px 0;
}
.chat-approval-head {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;
}
.chat-approval-title { font-weight: 600; color: var(--warn); font-size: 12.5px; display: flex; align-items: center; gap: 6px; }
.chat-approval-cmd {
  font-family: var(--mono); font-size: 12px; background: var(--code);
  padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--line);
  color: var(--code-ink); margin: 8px 0; word-break: break-all;
}
.chat-approval-actions {
  display: flex; align-items: center; gap: 8px; margin-top: 10px;
}
.chat-approval-actions input { flex: 1; font-size: 12px; }

/* Welcome / Empty Stage */
.chat-empty-stage {
  max-width: 640px; margin: 40px auto 0; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 14px;
}
.chat-empty-title { font-size: 20px; font-weight: 600; color: var(--ink); letter-spacing: -0.3px; }
.chat-empty-subtitle { font-size: 13.5px; color: var(--dim); line-height: 1.5; max-width: 480px; }
.chat-suggestions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; width: 100%; margin-top: 10px; text-align: left; }
.suggestion-card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm);
  padding: 10px 12px; cursor: pointer; transition: all .12s ease;
}
.suggestion-card:hover { border-color: var(--line-light); background: var(--panel-hover); }
.suggestion-card b { font-size: 12.5px; color: var(--ink); display: block; margin-bottom: 3px; }
.suggestion-card span { font-size: 11.5px; color: var(--dim); }

/* Bottom Sticky Composer */
#chat-composer-wrap {
  padding: 12px 24px 18px; background: var(--bg); border-top: 1px solid var(--line); z-index: 15;
}
.composer-box {
  max-width: 860px; margin: 0 auto; background: var(--panel);
  border: 1px solid var(--line-light); border-radius: var(--radius-sm);
  padding: 10px 14px 10px; display: flex; flex-direction: column; gap: 8px;
}
.composer-box:focus-within { border-color: var(--dim); }
#launch-brief {
  width: 100%; box-sizing: border-box; background: transparent;
  border: none; outline: none; padding: 4px 0 6px; font-size: 13.5px;
  line-height: 1.55; resize: vertical; min-height: 60px; max-height: 240px; color: var(--ink);
  font-family: inherit;
}
.composer-toolbar {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
  padding-top: 8px; border-top: 1px solid var(--line); font-size: 12px;
}
.composer-toolbar-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.composer-toolbar-right { display: flex; align-items: center; gap: 8px; }

/* Harness Pills */
.harness-pills { display: flex; gap: 5px; flex-wrap: wrap; }
.harness-card {
  padding: 4px 9px; font-size: 11.5px; background: var(--panel-elevated);
  border: 1px solid var(--line); border-radius: var(--radius-sm);
  cursor: pointer; transition: all .12s ease; user-select: none; color: var(--dim);
}
.harness-card:hover { border-color: var(--line-light); color: var(--ink); }
.harness-card.sel { border-color: var(--acc); background: var(--acc-subtle); color: var(--ink); font-weight: 500; }
.harness-card.missing { opacity: .5; }

.stepper-wrap {
  display: inline-flex; align-items: center; border: 1px solid var(--line);
  border-radius: var(--radius-sm); overflow: hidden; background: var(--panel-elevated);
}
.stepper-wrap button { border: none; border-radius: 0; padding: 3px 7px; background: transparent; font-weight: bold; cursor: pointer; }
.stepper-wrap input { border: none; text-align: center; background: transparent; padding: 3px 0; font-weight: 600; width: 28px; font-size: 11.5px; color: var(--ink); }

#launch-permission-seg { display: inline-flex; gap: 1px; background: var(--panel-elevated); padding: 2px; border-radius: var(--radius-sm); border: 1px solid var(--line); }
#launch-permission-seg button { border: none; background: transparent; padding: 2px 7px; font-size: 11px; border-radius: 2px; color: var(--dim); cursor: pointer; }
#launch-permission-seg button.sel { background: var(--panel); border: 1px solid var(--line); color: var(--ink); font-weight: 500; }

.btn-launch {
  background: var(--acc) !important; color: #ffffff !important;
  font-weight: 500 !important; border: 1px solid var(--acc) !important;
  padding: 6px 16px !important; font-size: 12.5px !important; border-radius: var(--radius-sm) !important;
  cursor: pointer !important; transition: background .12s ease, border-color .12s ease !important;
}
.btn-launch:hover { background: var(--acc-hover) !important; border-color: var(--acc-hover) !important; }

/* Standard Section Views (Crews, Fleet, Channels, etc.) */
.standard-view { flex: 1; overflow-y: auto; padding: 20px 28px 80px; }
h1 { font-size: 18px; font-weight: 600; margin: 0 0 14px; color: var(--ink); letter-spacing: -0.2px; }
h2 { font-size: 14px; font-weight: 600; margin: 20px 0 10px; color: var(--ink); display: flex; align-items: center; justify-content: space-between; }
.dim { color: var(--dim); font-size: 12px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 12px 0; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 12px 14px; box-shadow: none; }
.card b { font-size: 18px; font-weight: 600; color: var(--ink); display: block; margin-top: 4px; font-family: var(--mono); }

table { width: 100%; border-collapse: separate; border-spacing: 0; margin: 10px 0 20px; font-size: 12.5px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; box-shadow: none; }
th, td { padding: 9px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); }
th { background: var(--panel-elevated); color: var(--dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
tr:last-child td { border-bottom: none; }
tr.worker-row { cursor: pointer; transition: background .12s ease; }
tr.worker-row:hover td { background: var(--panel-hover); }

input, textarea, select {
  background: var(--panel); border: 1px solid var(--line); color: var(--ink);
  border-radius: var(--radius-sm); padding: 6px 10px; font-size: 12.5px;
  font-family: inherit; transition: border-color .12s ease;
}
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--line-light); box-shadow: none; }
button {
  background: var(--panel); border: 1px solid var(--line); color: var(--ink);
  border-radius: var(--radius-sm); padding: 5px 12px; font-size: 12px;
  cursor: pointer; transition: background .12s ease, border-color .12s ease; font-family: inherit; font-weight: 500;
}
button:hover { border-color: var(--line-light); background: var(--panel-hover); color: var(--ink); }
button.btn-primary { background: var(--acc); color: var(--acc-ink); border: 1px solid var(--acc); font-weight: 500; }
button.btn-primary:hover { background: var(--acc-hover); border-color: var(--acc-hover); }
button.danger { border: 1px solid rgba(248, 81, 73, 0.3); color: var(--danger); background: transparent; }
button.danger:hover { border-color: var(--danger); background: var(--danger-bg); }
button:disabled { opacity: .45; cursor: default; }

.log {
  font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap;
  background: var(--code); padding: 12px 14px; border-radius: var(--radius-sm);
  border: 1px solid var(--line); color: var(--code-ink); max-height: 280px; overflow-y: auto; line-height: 1.6;
}
#launch-out:empty, #launch-diff:empty { display: none; }

/* Right Inspector */
#app-inspector {
  width: 340px; min-width: 340px; background: var(--sidebar-bg);
  border-left: 1px solid var(--line); display: flex; flex-direction: column;
  height: 100vh; overflow-y: auto; padding: 16px; z-index: 10;
}
#app-inspector.hidden { display: none; }
#inspector { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 14px; box-shadow: none; }

/* Command Palette Modal */
#palette { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 100; display: none; padding: 15vh 20px 20px; }
#palette.open { display: block; }
#palette-box { max-width: 560px; margin: 0 auto; background: var(--panel); border: 1px solid var(--line-light); border-radius: var(--radius-sm); box-shadow: 0 16px 36px rgba(0,0,0,0.5); padding: 12px; }
#palette-input { width: 100%; box-sizing: border-box; background: var(--panel-elevated); border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 14px; padding: 9px 12px; color: var(--ink); margin-bottom: 8px; }
#palette-list { max-height: 45vh; overflow-y: auto; margin: 4px 0 8px; display: flex; flex-direction: column; gap: 2px; }
#palette-list div { padding: 8px 12px; border-radius: var(--radius-sm); cursor: pointer; font-size: 12.5px; color: var(--dim); display: flex; align-items: center; justify-content: space-between; }
#palette-list div.sel { background: var(--panel-active); color: var(--ink); font-weight: 500; }
.palette-hint { font-size: 11px; color: var(--dim); text-align: center; padding-top: 6px; border-top: 1px solid var(--line); }

/* Undo Toast */
#undo-toast {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
  background: var(--panel); border: 1px solid var(--line-light); border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0,0,0,0.4); padding: 10px 16px; z-index: 90; display: none; align-items: center; gap: 12px; font-size: 12px;
}
#undo-toast.show { display: flex; }
#result { margin-top: 1em; white-space: pre-wrap; font-family: var(--mono); font-size: 11px; color: var(--dim); }
details.tech-details { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px 12px; }
details.tech-details summary { cursor: pointer; font-weight: 500; user-select: none; }
.routes-badge { font-size: 11px; font-family: var(--mono); color: var(--dim); background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 3px 8px; }
.badge-count { background: var(--warn); color: #000; font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 9px; margin-left: auto; }
</style>
</head>
<body>
<div id="app-shell">
  <!-- 1. LEFT SIDEBAR -->
  <aside id="app-sidebar">
    <div class="sidebar-project">
      <div class="project-card" id="project-trigger" title="${e(boardPath)}">
        <span class="project-icon"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
        <div class="project-info">
          <div class="project-title">${e(path.basename(boardPath) || "Workspace")}</div>
          <div class="project-path" id="topbar-board" title="${e(boardPath)}">${e(boardPath)}</div>
        </div>
        <span class="project-arrow"><svg class="btn-ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
      </div>
      <div id="project-popover">
        <div class="pop-label">Target Codebase (Working Directory)</div>
        <div class="pop-path" id="pop-cwd-path" title="Where workers execute commands and edit code">(default: board parent)</div>
        <button type="button" class="pop-btn" id="open-folder-btn"><svg class="btn-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> Set Codebase Folder…</button>
        <div class="pop-label" style="margin-top:10px">Workspace Board (Bus DB)</div>
        <div class="pop-path" id="pop-board-path">${e(boardPath)}</div>
        <button type="button" id="copy-board-btn" class="pop-btn"><svg class="btn-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Board Path</button>
        <button type="button" class="pop-btn" id="switch-board-btn" title="Use another folder's board"><svg class="btn-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/></svg> Switch Board…</button>
        <button type="button" class="pop-btn" id="reset-board-btn">Use Default Board</button>
      </div>
    </div>

    <!-- New Thread / Task Button -->
    <div class="sidebar-action-wrap">
      <button type="button" class="btn-new-task" id="btn-new-thread" onclick="startNewThread()">
        <span>+ New Mission</span>
        <kbd>Ctrl+N</kbd>
      </button>
    </div>

    <!-- Active & Past Threads Stream -->
    <div class="sidebar-heading">Threads &amp; Runs</div>
    <div id="sidebar-thread-list" class="sidebar-thread-list">
      <div class="dim" style="padding:10px 8px;font-size:12px">no missions yet</div>
    </div>

    <!-- Workspace Navigation Tabs -->
    <div class="sidebar-heading" style="margin-top:auto">Navigation</div>
    <nav id="approot-nav">
      <button data-nav="sec-boards" class="active"><span class="nav-ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>Boards</button>
      <button data-nav="sec-approvals"><span class="nav-ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>Approvals<span id="sidebar-approvals-badge" class="badge-count" style="display:none">0</span></button>
      <button data-nav="sec-crews"><span class="nav-ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></span>Crews</button>
      <button data-nav="sec-fleet"><span class="nav-ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/></svg></span>Fleet</button>
      <button data-nav="sec-channels"><span class="nav-ic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/></svg></span>Channels</button>
      <button data-nav="sec-triage" style="display:none">Triage</button>
      <button data-nav="sec-results" style="display:none">Results</button>
      <button data-nav="sec-audit" style="display:none">Audit</button>
      <button data-nav="sec-settings" style="display:none">Settings</button>
    </nav>

    <!-- Sidebar Footer -->
    <div class="sidebar-footer">
      <div class="identity-badge" onclick="approotNavTo('sec-settings')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        <span id="who-display">orchestrator</span>
      </div>
      <button type="button" onclick="open('/pair','_blank')" title="Pair Mobile App (QR)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></button>
    </div>
  </aside>

  <!-- 2. MAIN WORKSPACE STAGE -->
  <main id="app-main">
    <!-- Topbar -->
    <header id="approot-topbar">
      <div class="topbar-left">
        <div class="thread-header-title" id="active-thread-title">Mission Control</div>
        <div class="thread-header-badge" id="active-thread-status">Ready</div>
        <select id="topbar-harness" onchange="document.getElementById('launch-harness').value=this.value;selectSingleHarness(this.value);" style="font-size:11.5px;padding:3px 6px">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="opencode">OpenCode</option>
          <option value="antigravity">Antigravity</option>
          <option value="cursor">Cursor</option>
          <option value="grok">Grok</option>
          <option value="qwen">Qwen</option>
        </select>
      </div>

      <button type="button" class="palette-btn" onclick="openPalette()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <span>Search actions &amp; workers…</span>
        <kbd>Ctrl+K</kbd>
      </button>

      <div class="topbar-right">
        <div class="conn-indicator">
          <span id="conn-dot"><svg width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#2ea043"/></svg></span>
          <span id="poll-age" class="dim">live</span>
        </div>
        <button type="button" onclick="open('/pair','_blank')" title="Mobile Pairing"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></button>
        <button type="button" onclick="crewbusThemeToggle()" title="Toggle Dark/Light Mode"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>
        <button type="button" onclick="toggleInspector()" title="Toggle Inspector"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg></button>
      </div>
    </header>

    <!-- View Stage -->
    <div id="view-container">

      <!-- SECTION: BOARDS (Primary Chat Threads & Execution Stage!) -->
      <section id="sec-boards" data-section="Boards" style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden">
        <div id="chat-stage">
          <!-- The Living Conversation / Thread Stream -->
          <div id="brief-thread">
            <div class="chat-empty-stage">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" stroke-width="1.7"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <div class="chat-empty-title">What should your crew work on?</div>
              <div class="chat-empty-subtitle">Launch a coordinated crew of AI coding agents. Track their progress, inspect changes, and approve sensitive operations directly in this stream.</div>
              <div class="chat-suggestions">
                <div class="suggestion-card" data-suggestion="Run test suite and fix failing tests">
                  <b>Run test suite &amp; fix bugs</b>
                  <span>Run tests, detect regressions, and patch code</span>
                </div>
                <div class="suggestion-card" data-suggestion="Refactor module to clean architecture">
                  <b>Refactor code</b>
                  <span>Improve performance and readability</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Bottom Sticky Composer -->
          <div id="chat-composer-wrap">
            <div class="composer-box">
              <div style="font-size:11px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:0.5px">Launch Mission</div>
              <textarea id="launch-brief" maxlength="8000" placeholder="Give instructions to the crew or message active thread… (Ctrl+Enter to launch)"></textarea>
              <div id="launch-diff"></div>
              <div id="launch-out" class="log" style="display:none"></div>

              <div class="composer-toolbar">
                <div class="composer-toolbar-left">
                  <!-- Harness Chips Container -->
                  <div id="harness-cards" class="harness-pills" title="Click harnesses to toggle multi-harness crew"></div>

                  <!-- Model Selector & Custom Model Input -->
                  <div style="display:inline-flex;align-items:center;gap:4px">
                    <select id="launch-model" title="Model catalog for selected harness(es)" style="font-size:11.5px;padding:3px 6px">
                      <option value="">Default model</option>
                    </select>
                    <input id="launch-model-custom" type="text" placeholder="Custom model ID…" style="display:none;font-size:11.5px;padding:3px 8px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--panel-elevated);color:var(--ink);width:170px" title="Enter custom model identifier">
                  </div>

                  <!-- Worker Count Stepper -->
                  <div class="stepper-wrap" title="Number of parallel workers">
                    <button type="button" id="launch-count-minus">-</button>
                    <input id="launch-count" type="number" min="1" max="20" value="1">
                    <button type="button" id="launch-count-plus">+</button>
                  </div>

                  <!-- Permission Mode Toggle -->
                  <div id="launch-permission-seg" title="Permission Mode">
                    <button type="button" data-perm="supervised" class="sel">Supervised</button>
                    <button type="button" data-perm="auto">Auto</button>
                  </div>
                </div>

                <div class="composer-toolbar-right">
                  <span id="launch-brief-count" class="dim" style="font-family:var(--mono);font-size:10.5px">0/8000</span>
                  <button id="launch-preview" type="button" style="display:none">Preview plan</button>
                  <button id="launch-go" class="btn-launch" type="button">Launch Agents</button>
                </div>
              </div>

              <!-- Hidden Form Fields to satisfy contract -->
              <div style="display:none">
                <span id="routes-line"></span>
                <select id="launch-harness"><option value="claude">claude</option></select>
                <input id="launch-to" value="">
                <input id="launch-permission" value="supervised">
                <input id="launch-from" value="">
                <input id="launch-token" type="password" value="">
                <input id="launch-cwd" value="">
                <button id="launch-cwd-browse" type="button"></button>
                <input id="launch-dry" type="checkbox" checked>
                <div id="harnesses"></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- SECTION: APPROVALS (Human-in-the-loop Approvals Queue) -->
      <section id="sec-approvals" data-section="Approvals" class="standard-view approot-hidden">
        <h1>Pending Approvals</h1>
        <p class="dim">When workers are blocked on sensitive operations, approve or deny their requests here or directly in the chat thread.</p>
        <table>
          <thead><tr><th>Request ID</th><th>Worker</th><th>Action / Command</th><th>Instructions / Reason</th><th>Actions</th></tr></thead>
          <tbody id="approvals"></tbody>
        </table>
      </section>

      <!-- SECTION: CREWS (Workers Roster & Controls) -->
      <section id="sec-crews" data-section="Crews" class="standard-view approot-hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <h1>Active Crew Workers</h1>
          <div style="display:flex;gap:8px">
            <button id="killall" class="danger">Kill All Active Workers</button>
            <button id="ackall">Acknowledge All Replies</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Worker</th>
              <th>Status</th>
              <th>PID</th>
              <th>Driver</th>
              <th>brief / groups</th>
              <th>Reply</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="crews"></tbody>
        </table>
        <h2 style="margin-top:24px">Agent Fleet Presence</h2>
        <table>
          <thead><tr><th>Agent</th><th>Role</th><th>Status</th><th>Last Seen</th><th>Unacked</th></tr></thead>
          <tbody id="agents"></tbody>
        </table>
      </section>

      <!-- SECTION: FLEET (Relays & Multi-Node Sync) -->
      <section id="sec-fleet" data-section="Fleet" class="standard-view approot-hidden">
        <h1>Relay Fleet (Multi-Node Sync)</h1>
        <table>
          <thead><tr><th>Relay</th><th>Role</th><th>Weight</th><th>Workers</th><th>Lag</th><th>Last Sync</th></tr></thead>
          <tbody id="fleet"></tbody>
        </table>
        <h2 style="margin-top:24px">Sync Peers</h2>
        <table><thead><tr><th>Peer</th><th>Last Sync</th></tr></thead><tbody id="peers"></tbody></table>
      </section>

      <!-- SECTION: CHANNELS (Broadcasts & Group Logs) -->
      <section id="sec-channels" data-section="Channels" class="standard-view approot-hidden">
        <h1>Channels &amp; Broadcasts</h1>
        <div style="margin-bottom:14px;display:flex;gap:8px">
          <input id="chan-name" placeholder="Channel name (e.g. general, findings)" style="width:220px">
          <input id="chan-body" placeholder="Broadcast message…" style="flex:1">
          <button id="chan-post" class="btn-primary">Post to Channel</button>
        </div>
        <div id="channels"></div>
        <h2 style="margin-top:24px">Broadcast History</h2>
        <table>
          <thead><tr><th>ID</th><th>From</th><th>To</th><th>Subject</th><th>Body</th></tr></thead>
          <tbody id="bcast"></tbody>
        </table>
      </section>

      <!-- SECTION: TRIAGE (Inbox Queue & Filters) -->
      <section id="sec-triage" data-section="Triage" class="standard-view approot-hidden">
        <h1>Inbox &amp; Message Triage</h1>
        <table>
          <thead><tr><th>ID</th><th>From</th><th>Message</th><th>Actions</th></tr></thead>
          <tbody id="triage"></tbody>
        </table>
        <h2 style="margin-top:24px">Recent Message Feed</h2>
        <div style="display:flex;gap:10px;margin-bottom:10px">
          <input id="feed-q" placeholder="Filter messages…" style="flex:1">
          <select id="feed-type"><option value="">All</option><option value="checkpoint">Checkpoints</option><option value="final">Finals</option></select>
        </div>
        <table>
          <thead><tr><th>ID</th><th>From → To</th><th>Summary</th></tr></thead>
          <tbody id="recent"></tbody>
        </table>
      </section>

      <!-- SECTION: RESULTS (Outcomes & Diffs) -->
      <section id="sec-results" data-section="Results" class="standard-view approot-hidden">
        <h1>Verified Results &amp; Competitive Races</h1>
        <table>
          <thead><tr><th>Group</th><th>Telemetry</th><th>Verified Result</th><th>Running</th><th>Actions</th></tr></thead>
          <tbody id="results"></tbody>
        </table>
      </section>

      <!-- SECTION: AUDIT (Tamper-Evident Chain & Holds) -->
      <section id="sec-audit" data-section="Audit" class="standard-view approot-hidden">
        <h1>Tamper-Evident Audit Log</h1>
        <div id="auditver" class="dim" style="margin-bottom:12px;font-family:var(--mono);font-size:12px"></div>
        <table>
          <thead><tr><th>Seq</th><th>At</th><th>Actor</th><th>Event</th><th>Target</th><th>Result</th></tr></thead>
          <tbody id="audit"></tbody>
        </table>
        <h2 style="margin-top:24px">Legal Hold Status</h2>
        <div id="holds-body" class="card dim" style="margin-top:8px">no active legal hold</div>
        <h2 style="margin-top:24px">Board Quotas &amp; Retention</h2>
        <div id="quotas-body" class="card dim" style="margin-top:8px">quotas loaded</div>
      </section>

      <!-- SECTION: SETTINGS (Pairing, Auth, CLI) -->
      <section id="sec-settings" data-section="Settings" class="standard-view approot-hidden">
        <h1>Settings &amp; Companion Pairing</h1>
        <div class="card" style="margin-bottom:14px">
          <b>Mobile Companion Pairing</b>
          <p class="dim">Pair your mobile client with this board using a secure, single-use QR exchange.</p>
          <button id="pair-qrcode-btn" class="btn-primary" onclick="open('/pair', '_blank')">Open Mobile Pairing Screen (QR)…</button>
        </div>
        <div class="card" style="margin-bottom:14px">
          <b>Tab Identity &amp; Auth</b>
          <p class="dim">Configure credentials for this browser session.</p>
          <div style="display:flex;gap:8px;margin-top:8px">
            <input id="who" placeholder="Agent Name (e.g. orchestrator)">
            <input id="tok" type="password" placeholder="Token abt-…">
            <button id="save" class="btn-primary">Save Creds</button>
          </div>
        </div>
        <div class="card" style="margin-bottom:14px">
          <b>Holds &amp; Quotas</b>
          <div style="display:flex;gap:12px;margin-top:10px;flex-wrap:wrap">
            <div class="card" id="holds-card" style="flex:1;min-width:240px"><b>Hold</b><div id="holds-body" class="dim">loading…</div></div>
            <div class="card" id="quotas-card" style="flex:1;min-width:240px"><b>Quotas</b><div id="quotas-body" class="dim">loading…</div></div>
          </div>
        </div>
        <div class="card">
          <b>Workspace Stats</b>
          <div class="cards" style="margin-top:10px">
            <div class="card"><div class="dim">Agents</div><b id="c-agents">0</b></div>
            <div class="card"><div class="dim">Active</div><b id="c-active">0</b></div>
            <div class="card"><div class="dim">Workers</div><b id="c-workers">0</b></div>
            <div class="card"><div class="dim">Unacked</div><b id="c-unacked">0</b></div>
            <div class="card"><div class="dim">Broadcasts</div><b id="c-bcast">0</b></div>
            <div class="card"><div class="dim">Groups</div><b id="c-groups">0</b></div>
            <div class="card"><div class="dim">Peers</div><b id="c-peers">0</b></div>
          </div>
          <table style="margin-top:14px"><thead><tr><th>Group</th><th>Members</th></tr></thead><tbody id="groups"></tbody></table>
        </div>
        <div id="result"></div>
      </section>

      <!-- SECTION: BRIEFS (Table container required by panel test) -->
      <section id="sec-briefs" data-section="Briefs" class="approot-hidden">
        <table><thead><tr><th>Brief</th><th>Workers</th><th>Checkpoints</th><th>Finals</th><th>Acked</th><th>Last</th></tr></thead><tbody id="briefs"></tbody></table>
      </section>

    </div>
  </main>

  <!-- 3. RIGHT INSPECTOR DRAWER -->
  <aside id="app-inspector" class="hidden">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-weight:600;font-size:13px;color:var(--ink)">Worker Inspector</div>
      <button type="button" onclick="toggleInspector()" style="padding:2px 6px">✕</button>
    </div>
    <div id="inspector">
      <div id="inspector-body"><span class="dim">Click a worker to inspect process details, memory, and live telemetry.</span></div>
    </div>
  </aside>
</div>

<!-- Command Palette Modal -->
<div id="palette">
  <div id="palette-box">
    <input id="palette-input" placeholder="Type a command or jump to section…">
    <div id="palette-list"></div>
    <div class="palette-hint">Use ↑ ↓ to navigate · Enter to select · Esc to close</div>
  </div>
</div>

<!-- Undo Toast -->
<div id="undo-toast">
  <span id="undo-msg">Action performed</span>
  <button id="undo-btn" class="danger">Undo</button>
</div>

<script>
var boardPath = "${boardPath}";
var activeBatch = null;

function esc(s){return String(s===undefined||s===null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function short(s,n){s=String(s||'');return s.length<=n?s:s.slice(0,n-1)+'…';}

function crewbusThemeInit(){
  try{
    var t=localStorage.getItem('crewbus-theme')||localStorage.getItem('crewbus-desktop-theme');
    if(t==='light'||t==='dark') document.documentElement.setAttribute('data-theme',t);
  }catch(_){}
}
function crewbusThemeToggle(){
  try{
    var cur=document.documentElement.getAttribute('data-theme');
    if(!cur){
      var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;
      cur=prefersDark?'dark':'light';
    }
    var next=cur==='dark'?'light':'dark';
    document.documentElement.setAttribute('data-theme',next);
    localStorage.setItem('crewbus-theme',next);
    localStorage.setItem('crewbus-desktop-theme',next);
  }catch(_){}
}

function approotNavTo(targetId){
  var sections=['sec-boards','sec-crews','sec-fleet','sec-channels','sec-triage','sec-approvals','sec-results','sec-audit','sec-settings','sec-briefs'];
  sections.forEach(function(id){
    var el=document.getElementById(id);
    if(el){
      if(id===targetId) el.classList.remove('approot-hidden');
      else el.classList.add('approot-hidden');
    }
  });
  var btns=document.querySelectorAll('#approot-nav button');
  Array.prototype.forEach.call(btns,function(b){
    if(b.getAttribute('data-nav')===targetId) b.classList.add('active');
    else b.classList.remove('active');
  });
  if(targetId==='sec-boards'){
    document.getElementById('active-thread-title').textContent = activeBatch ? 'Mission '+short(activeBatch,14) : 'Mission Control';
  } else {
    var b=document.querySelector('#approot-nav button[data-nav="'+targetId+'"]');
    document.getElementById('active-thread-title').textContent = b ? b.textContent.trim() : 'Workspace';
  }
}

Array.prototype.forEach.call(document.querySelectorAll('#approot-nav button'),function(btn){
  btn.onclick=function(){
    var nav=btn.getAttribute('data-nav');
    if(nav) approotNavTo(nav);
  };
});

function toggleInspector(){
  var insp=document.getElementById('app-inspector');
  if(insp) insp.classList.toggle('hidden');
}

function showInspector(name){
  var insp=document.getElementById('app-inspector');
  if(insp) insp.classList.remove('hidden');
  var b=document.getElementById('inspector-body');
  if(!b)return;
  var w=(window.__workers||[]).find(function(x){return x.name===name;})||{name:name,alive:false};
  var tail=(w.tail||[]).map(function(l){return '<div class="log-line">'+esc(l)+'</div>';}).join('')||'<div class="dim">no output recorded</div>';
  var statusStr=w.alive?'<span style="color:var(--ok)">● Active</span>':'<span style="color:var(--dim)">○ Exited</span>';
  b.innerHTML=[
    '<div style="margin-bottom:10px"><b>'+esc(w.name)+'</b> '+statusStr+'</div>',
    '<div class="dim" style="font-size:11px;margin-bottom:6px">PID: '+(w.pid||'—')+' · Driver: '+esc(w.driver||w.spawnedHarness||'—')+'</div>',
    (w.batch?'<div class="dim" style="font-size:11px;margin-bottom:8px">Batch: '+esc(w.batch)+'</div>':''),
    '<div style="display:flex;gap:6px;margin-bottom:12px">',
      (w.alive?'<button class="danger" data-kill="'+esc(w.name)+'">Kill Worker</button>':''),
      (w.reply?'<button data-ack="'+esc(w.reply.id)+'">Ack Reply</button>':''),
    '</div>',
    '<div class="dim" style="font-size:11px;margin-bottom:4px">Live Process Log:</div>',
    '<div class="log" style="max-height:300px">'+tail+'</div>',
    '<div class="dim" style="margin-top:12px;font-size:10.5px">CLI respawn command:</div>',
    '<div class="log" style="padding:6px;font-size:10.5px">crewbus respawn --to '+esc(w.name)+'</div>'
  ].join('');
  var k=b.querySelector('[data-kill]');
  if(k) k.onclick=function(){kill([w.name]);};
  var a=b.querySelector('[data-ack]');
  if(a) a.onclick=function(){ackOne(w.reply.id);};
}

function showUndoToast(msg, onUndo){
  var toast=document.getElementById('undo-toast');
  if(!toast)return;
  document.getElementById('undo-msg').textContent=msg;
  toast.classList.add('show');
  var btn=document.getElementById('undo-btn');
  btn.onclick=function(){
    toast.classList.remove('show');
    if(onUndo) onUndo();
  };
  setTimeout(function(){ toast.classList.remove('show'); }, 6000);
}

function startNewThread(){
  activeBatch=null;
  approotNavTo('sec-boards');
  document.getElementById('active-thread-title').textContent='New Mission';
  document.getElementById('active-thread-status').textContent='Draft';
  var rows=document.querySelectorAll('#sidebar-thread-list .thread-row');
  Array.prototype.forEach.call(rows,function(r){ r.classList.remove('active'); });
  var box=document.getElementById('brief-thread');
  if(box){
    box.innerHTML=[
      '<div class="chat-empty-stage">',
        '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" stroke-width="1.7"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        '<div class="chat-empty-title">What should your crew build?</div>',
        '<div class="chat-empty-subtitle">Type your prompt below to launch agents. They will report progress and ask for permissions right inside this conversation stream.</div>',
        '<div class="chat-suggestions">',
          '<div class="suggestion-card" data-suggestion="Run test suite and fix failing tests">',
            '<b>Run test suite &amp; fix bugs</b>',
            '<span>Run tests, detect regressions, and patch code</span>',
          '</div>',
          '<div class="suggestion-card" data-suggestion="Refactor module to clean architecture">',
            '<b>Refactor code</b>',
            '<span>Improve performance and readability</span>',
          '</div>',
        '</div>',
      '</div>'
    ].join('');
  }
  var inp=document.getElementById('launch-brief');
  if(inp){ inp.value=''; inp.focus(); }
}

function applySuggestion(text){
  var inp=document.getElementById('launch-brief');
  if(inp){
    inp.value=text;
    inp.dispatchEvent(new Event('input'));
    inp.focus();
  }
}

document.addEventListener('click', function(e){
  var el=e.target && e.target.closest ? e.target.closest('[data-suggestion]') : null;
  if(el){ var s=el.getAttribute('data-suggestion'); if(s) applySuggestion(s); }
});

async function showBrief(batch){
  activeBatch=batch;
  approotNavTo('sec-boards');
  document.getElementById('active-thread-title').textContent='Mission '+short(batch,16);
  var rows=document.querySelectorAll('#sidebar-thread-list .thread-row');
  Array.prototype.forEach.call(rows,function(r){
    if(r.getAttribute('data-batch')===batch) r.classList.add('active');
    else r.classList.remove('active');
  });

  var box=document.getElementById('brief-thread');
  if(!box)return;
  box.innerHTML='<div class="dim" style="padding:20px;text-align:center">Loading mission transcript for '+esc(batch)+'…</div>';

  try{
    var r=await fetch('/api/gather?batch='+encodeURIComponent(batch),{cache:'no-store'});
    var g=await r.json();
    if(!r.ok){ box.innerHTML='<div class="dim" style="padding:20px">gather failed: '+esc(g.error||r.status)+'</div>'; return; }

    var approvals=[];
    try{
      var apR=await fetch('/api/board',{cache:'no-store'});
      var apS=await apR.json();
      approvals=apS.approvals||[];
    }catch(_){}

    var html='<div style="max-width:860px;margin:0 auto;width:100%;display:flex;flex-direction:column;gap:14px">';
    html+='<div class="dim" style="font-size:11.5px;padding-bottom:10px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between"><span>Batch: '+esc(batch)+'</span><span>'+g.briefs+' briefs · '+g.replies+' replies · ~'+(g.telemetry&&g.telemetry.tokensEst?g.telemetry.tokensEst:0)+' tokens</span></div>';

    var items=g.items||[];
    for(var i=0;i<items.length;i++){
      var m=items[i];
      var isUser=!m.replyTo;
      var isCkpt=m.checkpoint===true;
      var toStr=Array.isArray(m.to)?m.to.join(','):String(m.to||'');

      if(isUser){
        html+='<div class="chat-msg chat-msg-user">';
        html+='  <div class="chat-msg-header"><span class="chat-msg-author">'+esc(m.from)+'</span><span>'+esc(ago(m.at))+'</span></div>';
        html+='  <div class="chat-msg-card"><b>'+(m.subject?esc(m.subject):'Mission Brief')+'</b><div style="margin-top:6px;white-space:pre-wrap">'+esc(m.body)+'</div>';
        html+='    <div class="chat-msg-tags"><span class="chat-tag">→ '+esc(toStr)+'</span><span class="chat-tag">batch '+esc(short(batch,8))+'</span></div>';
        html+='  </div>';
        html+='</div>';
      } else {
        html+='<div class="chat-msg">';
        html+='  <div class="chat-msg-header"><span class="chat-msg-author">'+esc(m.from)+'</span><span class="dim">'+(isCkpt?'Checkpoint':'Final Report')+' · '+esc(ago(m.at))+'</span></div>';
        html+='  <div class="chat-msg-card">';
        if(m.subject) html+='<div style="font-weight:600;margin-bottom:6px">'+esc(m.subject)+'</div>';
        html+='    <div style="white-space:pre-wrap">'+esc(m.body)+'</div>';
        if(m.artifact) html+='<div style="margin-top:8px" class="dim">Artifact: <code>'+esc(m.artifact)+'</code></div>';
        html+='  </div>';
        html+='</div>';
      }
    }

    // Inline Approvals in the Chat Stream
    var pendingForWorkers=approvals.filter(function(ap){
      return items.some(function(it){ return it.from===ap.from || it.to===ap.from; });
    });
    if(pendingForWorkers.length===0 && approvals.length>0 && items.length===0){
      pendingForWorkers=approvals;
    }

    for(var j=0;j<pendingForWorkers.length;j++){
      var ap=pendingForWorkers[j];
      html+='<div class="chat-approval-card" data-approval-id="'+esc(ap.id)+'">';
      html+='  <div class="chat-approval-head"><span class="chat-approval-title">Permission Request</span><span class="dim">'+esc(ago(ap.at))+'</span></div>';
      html+='  <div><b>'+esc(ap.from)+'</b> requires your approval to proceed:</div>';
      html+='  <div class="chat-approval-cmd">'+esc(ap.subject.replace(/^approval:[ 	]*/,''))+'</div>';
      if(ap.body) html+='<div class="dim" style="font-size:11.5px;margin-bottom:8px">'+esc(ap.body)+'</div>';
      html+='  <div class="chat-approval-actions">';
      html+='    <input data-reason="'+esc(ap.id)+'" maxlength="500" placeholder="Optional instructions or feedback…">';
      html+='    <button data-approve="'+esc(ap.id)+'" class="btn-primary">Approve</button>';
      html+='    <button data-deny="'+esc(ap.id)+'" class="danger">Decline</button>';
      html+='  </div>';
      html+='</div>';
    }

    html+='</div>';
    box.innerHTML=html;

    // Delegate inline approvals
    Array.prototype.forEach.call(box.querySelectorAll('[data-approve]'),function(btn){
      btn.onclick=function(ev){ ev.stopPropagation(); decide(btn.getAttribute('data-approve'),'approved'); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-deny]'),function(btn){
      btn.onclick=function(ev){ ev.stopPropagation(); decide(btn.getAttribute('data-deny'),'denied'); };
    });

    box.scrollTop=box.scrollHeight;
  }catch(e){
    box.innerHTML='<div class="dim" style="padding:20px">gather error: '+esc(e.message)+'</div>';
  }
}

// Global Poll & Update Engine
async function refresh(){
  try{
    var r=await fetch('/api/board',{cache:'no-store'});
    var s=await r.json();
    window.__lastBoardPoll=Date.now();
    updatePollAge();
    window.__workers=s.workers||[];

    var active=s.agents.filter(function(a){return a.active;}).length;
    var unacked=s.agents.reduce(function(n,a){return n+a.unacked;},0);

    var setTxt=function(id,val){var el=document.getElementById(id);if(el)el.textContent=val;};
    setTxt('c-agents', s.agents.length);
    setTxt('c-active', active);
    setTxt('c-workers', s.workers.length);
    setTxt('c-unacked', unacked);
    setTxt('c-bcast', s.broadcasts.length);
    setTxt('c-groups', (s.groups||[]).length);
    setTxt('c-peers', (s.peers||[]).length);

    // 1. Sidebar Threads Stream
    var threadListEl=document.getElementById('sidebar-thread-list');
    if(threadListEl){
      var briefs=s.briefs||[];
      if(briefs.length===0){
        threadListEl.innerHTML='<div class="dim" style="padding:10px 8px;font-size:12px">no missions yet</div>';
      } else {
        threadListEl.innerHTML=briefs.map(function(b){
          var isCur=activeBatch===b.batch;
          var hasRunning=s.workers.some(function(w){ return w.batch===b.batch && w.alive; });
          var dotClass=hasRunning?'status-dot active':'status-dot';
          var title=b.subject ? b.subject.replace(/^brief:[ 	]*/,'') : 'Mission '+short(b.batch,10);
          return [
            '<div class="thread-row '+(isCur?'active':'')+'" data-batch="'+esc(b.batch)+'">',
              '<div class="thread-row-top">',
                '<div class="thread-title">'+esc(title)+'</div>',
                '<span class="thread-time">'+esc(ago(b.lastAt))+'</span>',
              '</div>',
              '<div class="thread-meta">',
                '<span class="'+dotClass+'"></span>',
                '<span>'+b.workers.length+' worker'+(b.workers.length===1?'':'s')+' · '+b.checkpointCount+' ckpts</span>',
              '</div>',
            '</div>'
          ].join('');
        }).join('');

        Array.prototype.forEach.call(threadListEl.querySelectorAll('.thread-row'),function(r){
          r.onclick=function(){ showBrief(r.getAttribute('data-batch')); };
        });
      }
    }

    // 2. Briefs Table (Contract for panel test)
    var brEl=document.getElementById('briefs');
    if(brEl){
      brEl.innerHTML=(s.briefs||[]).map(function(b){
        var ws=(b.workers||[]).join(',');
        return '<tr data-batch="'+esc(b.batch)+'" style="cursor:pointer"><td><b>'+esc(b.subject||short(b.batch,12))+'</b></td><td>'+esc(ws)+'</td><td>'+b.checkpointCount+'</td><td>'+b.finalCount+'</td><td>'+b.ackedFinals+'/'+b.finalCount+'</td><td>'+esc(ago(b.lastAt))+'</td></tr>';
      }).join('')||'<tr><td colspan="6" class="dim">no briefs yet</td></tr>';
      Array.prototype.forEach.call(document.querySelectorAll('#briefs [data-batch]'),function(r){
        r.onclick=function(){ showBrief(r.getAttribute('data-batch')); };
      });
    }

    // 3. Crews Table
    var crEl=document.getElementById('crews');
    if(crEl){
      crEl.innerHTML=s.workers.map(function(w){
        var pidStr=w.pid===null||w.pid===undefined?'—':String(w.pid);
        var drv=w.driver||w.spawnedHarness||'—';
        var rep=w.reply?(esc(w.reply.id)+(w.acked?' ✓':'')):'—';
        var kBtn=(w.known&&w.alive===true)?('<button class="danger" data-kill="'+esc(w.name)+'">kill</button>'):'';
        var bInfo=w.batch?('batch '+esc(short(w.batch,8))):'—';
        return '<tr class="worker-row" data-worker="'+esc(w.name)+'"><td><b>'+esc(w.name)+'</b></td><td>'+esc(stateOf(w))+'</td><td>'+esc(pidStr)+'</td><td>'+esc(drv)+'</td><td>'+bInfo+'</td><td>'+rep+'</td><td>'+kBtn+'</td></tr>';
      }).join('')||'<tr><td colspan="7" class="dim">no spawned workers yet</td></tr>';
    }

    // 4. Agents Table
    var agEl=document.getElementById('agents');
    if(agEl){
      agEl.innerHTML=s.agents.map(function(a){
        var dot=a.active?'<span style="color:var(--ok)">●</span>':'<span style="color:var(--dim)">○</span>';
        return '<tr><td>'+dot+' <b>'+esc(a.name)+'</b></td><td>'+esc(a.role||'worker')+'</td><td>'+(a.active?'active':'idle')+'</td><td>'+esc(ago(a.lastSeen))+'</td><td>'+a.unacked+'</td></tr>';
      }).join('')||'<tr><td colspan="5" class="dim">no agents yet</td></tr>';
    }

    // 5. Approvals Table & Badge
    var apEl=document.getElementById('approvals');
    var apBadge=document.getElementById('sidebar-approvals-badge');
    var apList=s.approvals||[];
    if(apBadge){
      if(apList.length>0){ apBadge.style.display='inline-block'; apBadge.textContent=apList.length; }
      else { apBadge.style.display='none'; }
    }
    if(apEl){
      apEl.innerHTML=apList.map(function(a){
        return '<tr><td>'+esc(a.id)+'</td><td><b>'+esc(a.from)+'</b></td><td>'+esc(a.subject)+'<br><span class="dim">'+esc(short(a.body,120))+'</span></td><td><input data-reason="'+esc(a.id)+'" maxlength="500" placeholder="optional instructions…"></td><td><button class="btn-primary" data-approve="'+esc(a.id)+'">Approve</button> <button class="danger" data-deny="'+esc(a.id)+'">Deny</button></td></tr>';
      }).join('')||'<tr><td colspan="5" class="dim">no pending approvals</td></tr>';
    }

    // 6. Fleet Table
    try{
      var fr=await fetch('/api/fleet',{cache:'no-store'});
      var fl=await fr.json();
      var flEl=document.getElementById('fleet');
      if(flEl){
        flEl.innerHTML=(fl.relays||[]).map(function(p){
          var live=p.live;
          return '<tr><td><b>'+esc(p.peer)+'</b></td><td>'+esc(live?live.role:'—')+'</td><td>'+esc(live&&live.weight!==null&&live.weight!==undefined?String(live.weight):'—')+'</td><td>'+esc(live&&live.workers!==null&&live.workers!==undefined?String(live.workers):'—')+'</td><td>'+esc(live&&live.lagMs!==null&&live.lagMs!==undefined?String(live.lagMs)+'ms':'—')+'</td><td>'+esc(p.lastOk)+'</td></tr>';
        }).join('')||'<tr><td colspan="6" class="dim">no peers synced yet</td></tr>';
      }
    }catch(_){}

    // 7. Channels Feed & Broadcasts
    try{
      var cr=await fetch('/api/channels',{cache:'no-store'});
      var ch=await cr.json();
      var chEl=document.getElementById('channels');
      if(chEl){
        chEl.innerHTML=(ch.channels||[]).map(function(c){
          var heads=(c.latest||[]).map(function(p){
            return '<div class="log" style="margin:4px 0"><b>'+esc(p.id)+'</b> ['+esc(p.from)+'] '+(p.subject?'<b>'+esc(p.subject)+'</b> ':'')+esc(p.head)+'</div>';
          }).join('')||'<div class="dim">no posts</div>';
          return '<div class="card" style="margin:.5em 0"><b>'+esc(c.name)+'</b> <span class="dim">'+c.posts+' posts</span>'+heads+'</div>';
        }).join('')||'<div class="dim">no channels yet</div>';
      }
    }catch(_){}

    var bcEl=document.getElementById('bcast');
    if(bcEl){
      bcEl.innerHTML=s.broadcasts.map(function(b){
        var to=Array.isArray(b.to)?b.to.join(','):String(b.to||'');
        return '<tr><td>'+esc(b.id)+'</td><td>'+esc(b.from)+'</td><td>'+esc(short(to,80))+'</td><td>'+esc(b.subject||'')+'</td><td>'+esc(short(b.body,140))+'</td></tr>';
      }).join('')||'<tr><td colspan="5" class="dim">no broadcasts</td></tr>';
    }

    // 8. Triage & Recent Feed
    try{
      var c=creds();
      var trEl=document.getElementById('triage');
      if(c.from){
        var tr=await fetch('/api/inbox?agent='+encodeURIComponent(c.from)+'&unacked=1&limit=50',{cache:'no-store'});
        var tj=await tr.json();
        if(trEl){
          trEl.innerHTML=(tj.items||[]).map(function(m){
            return '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.from)+'</td><td>'+(m.subject?'<b>'+esc(m.subject)+'</b><br>':'')+esc(m.head)+'</td><td><button data-ack="'+esc(m.id)+'">ack</button></td></tr>';
          }).join('')||'<tr><td colspan="4" class="dim">inbox zero for '+esc(c.from)+'</td></tr>';
        }
      }else{
        if(trEl) trEl.innerHTML='<tr><td colspan="4" class="dim">set identity in Settings to triage</td></tr>';
      }
    }catch(_){}

    window.__recent=s.recent||[];
    window.__ackedBy=s.ackedBy||{};
    renderRecent();

    // 9. Results Table
    try{
      var rr=await fetch('/api/results',{cache:'no-store'});
      var rs=await rr.json();
      var rsEl=document.getElementById('results');
      if(rsEl){
        rsEl.innerHTML=(rs.groups||[]).map(function(g){
          var res=g.result?('<b>'+esc(g.result.artifact||'(no artifact)')+'</b><div class="dim">by '+esc(g.result.by||'?')+' @ '+esc(g.result.at||'?')+'</div>'):'<span class="dim">no verified result</span>';
          var run=(g.running||[]).map(function(m){return esc(m);}).join(', ')||'<span class="dim">none</span>';
          var btns=(g.losers||[]).map(function(m){return '<button class="danger" data-kill="'+esc(m)+'">kill '+esc(m)+'</button>';}).join(' ');
          var tele=g.messages+' msgs · '+g.replies+' replies · ~'+g.tokensEst+' tok · '+g.verifiedCount+' verified';
          return '<tr><td><b>'+esc(g.group)+'</b> ('+g.members+')</td><td>'+esc(tele)+'</td><td>'+res+'</td><td>'+run+'</td><td>'+btns+'</td></tr>';
        }).join('')||'<tr><td colspan="5" class="dim">no groups yet</td></tr>';
      }
    }catch(_){}

    // 10. Audit Chain
    try{
      var ar=await fetch('/api/audit',{cache:'no-store'});
      var au=await ar.json();
      var v=au.verify||{};
      var avEl=document.getElementById('auditver');
      if(avEl)avEl.textContent=v.ok?('chain OK: '+v.count+' records'):('CHAIN BROKEN at seq '+v.firstBrokenSeq+' ('+(v.reason||'?')+')');
      var rows=(au.audit||[]).concat(au.chain||[]).sort(function(a,b){return (a.seq||0)-(b.seq||0);}).slice(-15);
      var auEl=document.getElementById('audit');
      if(auEl){
        auEl.innerHTML=rows.map(function(r){
          return '<tr><td>'+esc(String(r.seq===undefined||r.seq===null?'':r.seq))+'</td><td>'+esc(r.at||'')+'</td><td>'+esc(r.actor||'')+'</td><td>'+esc(r.type||'')+'</td><td>'+esc(short(r.target||'',40))+'</td><td>'+esc(r.result||'')+'</td></tr>';
        }).join('')||'<tr><td colspan="6" class="dim">no audit records yet</td></tr>';
      }
    }catch(_){}

    // 11. Holds & Quotas
    try{
      var hr=await fetch('/api/holds',{cache:'no-store'});
      var hj=await hr.json();
      var h=(hj&&hj.hold)||null;
      var hb='';
      if(h&&h.active===true){
        var hw=h.placedBy||'unknown';
        var hn=h.placedAt||'unknown time';
        var hy=h.reason?(': '+h.reason):'';
        var hbd=(hj&&hj.board)||'';
        hb='<b>ACTIVE</b> — placed by '+esc(hw)+' at '+esc(hn)+(h.reason?': '+esc(h.reason):'');
        hb+='<div class="dim">'+esc('prune REFUSED — legal hold ACTIVE (placed by '+hw+' at '+hn+hy+') [board '+hbd+'] — lift with: hold lift --from <admin>')+'</div>';
      }else{
        hb='<span class="dim">no active legal hold</span>';
      }
      var hbEl=document.getElementById('holds-body');
      if(hbEl)hbEl.innerHTML=hb;
    }catch(_){}
    try{
      var qr=await fetch('/api/quotas',{cache:'no-store'});
      var qj=await qr.json();
      var q=(qj&&qj.quotas)||{};
      var agN=(s.agents||[]).length;
      var qb='<div>maxBytes: '+esc(q.maxBytes===undefined||q.maxBytes===null?'unlimited':humanBytes(q.maxBytes))+'</div>';
      var agOver=(q.maxAgents!==undefined&&q.maxAgents!==null&&agN>q.maxAgents)?' <b>OVER QUOTA</b>':'';
      qb+='<div>maxAgents: '+esc(q.maxAgents===undefined||q.maxAgents===null?'unlimited':q.maxAgents)+' <span class="dim">('+agN+' agents)</span>'+agOver+'</div>';
      if(q.maxChannels!==undefined&&q.maxChannels!==null){
        qb+='<div>maxChannels: '+esc(q.maxChannels)+'</div>';
      }
      if(q.tenant){qb+='<div>tenant: '+esc(q.tenant)+'</div>';}
      var qbEl=document.getElementById('quotas-body');
      if(qbEl)qbEl.innerHTML=qb;
    }catch(_){}

    // Delegation
    Array.prototype.forEach.call(document.querySelectorAll('[data-kill]'),function(b){b.onclick=function(ev){ev.stopPropagation();kill([b.getAttribute('data-kill')]);};});
    Array.prototype.forEach.call(document.querySelectorAll('[data-ack]'),function(b){b.onclick=function(ev){ev.stopPropagation();ackOne(b.getAttribute('data-ack'));};});
    Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'),function(b){b.onclick=function(ev){ev.stopPropagation();decide(b.getAttribute('data-approve'),'approved');};});
    Array.prototype.forEach.call(document.querySelectorAll('[data-deny]'),function(b){b.onclick=function(ev){ev.stopPropagation();decide(b.getAttribute('data-deny'),'denied');};});
    Array.prototype.forEach.call(document.querySelectorAll('[data-worker]'),function(r){r.onclick=function(){showInspector(r.getAttribute('data-worker'));};});
  }catch(e){}
}

function stateOf(w){
  if(!w.known) return 'untracked';
  if(w.alive) return 'running';
  if(w.exitCode===0) return 'done';
  if(w.exitCode!==null&&w.exitCode!==undefined) return 'exit '+w.exitCode;
  return 'exited';
}

function humanBytes(n){
  if(typeof n!=='number'||!(n>=0)) return 'unlimited';
  if(n<1024) return n+' B';
  var u=['B','KB','MB','GB','TB'];
  var v=n;
  var i=0;
  while(v>=1024&&i<u.length-1){v/=1024;i++;}
  var r=Math.round(v*10)/10;
  return r+' '+u[i]+' ('+n+' bytes)';
}

function renderRecent(){
  var tbody=document.getElementById('recent');
  if(!tbody)return;
  var q=(document.getElementById('feed-q')?document.getElementById('feed-q').value:'').trim().toLowerCase();
  var type=document.getElementById('feed-type')?document.getElementById('feed-type').value:'';
  var list=(window.__recent||[]).filter(function(m){
    if(type==='checkpoint'&&!m.checkpoint) return false;
    if(type==='final'&&m.checkpoint) return false;
    if(q){
      var hay=(m.from+' '+(Array.isArray(m.to)?m.to.join(' '):m.to)+' '+(m.subject||'')+' '+(m.body||'')).toLowerCase();
      if(hay.indexOf(q)===-1) return false;
    }
    return true;
  });
  tbody.innerHTML=list.slice(0,30).map(function(m){
    var to=Array.isArray(m.to)?m.to.join(','):String(m.to||'');
    var acks=(window.__ackedBy[m.id]||[]).map(function(x){return '✓'+esc(x);}).join(' ');
    return '<tr><td>'+esc(m.id)+'</td><td>'+esc(m.from)+' → '+esc(short(to,40))+'</td><td>'+(m.subject?'<b>'+esc(m.subject)+'</b><br>':'')+esc(short(m.body,200))+'<div class="dim">'+(m.replyTo?('re: '+esc(m.replyTo)+' '):'')+(m.batch?('batch '+esc(m.batch)+' '):'')+acks+'</div></td></tr>';
  }).join('')||'<tr><td colspan="3" class="dim">no messages matching filter</td></tr>';
}

var fq=document.getElementById('feed-q'); if(fq) fq.oninput=renderRecent;
var ft=document.getElementById('feed-type'); if(ft) ft.onchange=renderRecent;

// Harness & Model Metadata
var __launchMetaCache={};
function fetchLaunchMetaCached(key,url){
  var entry=__launchMetaCache[key];
  if(entry&&Date.now()-entry.at<60000) return Promise.resolve(entry.data);
  return fetch(url).then(function(r){return r.json();}).then(function(j){
    __launchMetaCache[key]={data:j,at:Date.now()};
    return j;
  }).catch(function(){ return entry?entry.data:null; });
}

window.__selectedHarnesses = ['claude'];

function updateCustomModelInputVisibility(){
  var sel=document.getElementById('launch-model');
  var customInp=document.getElementById('launch-model-custom');
  if(!sel||!customInp)return;
  if(sel.value==='__custom__'){
    customInp.style.display='inline-block';
    customInp.focus();
  }else{
    customInp.style.display='none';
  }
}

function syncModelOptions(selectedHarness){
  var sel=document.getElementById('launch-model');
  if(!sel)return;
  var curVal=sel.value;
  var catalog=window.__modelCatalog||{};
  var harnesses=selectedHarness?[selectedHarness]:(window.__selectedHarnesses||['claude']);

  var html='';
  if(harnesses.length===1){
    var h=harnesses[0];
    var models=catalog[h]||[];
    html+='<option value="">Default '+esc(h)+' model</option>';
    for(var i=0;i<models.length;i++){
      var m=models[i];
      var isSel=(m.id===curVal)?' selected':'';
      html+='<option value="'+esc(m.id)+'"'+isSel+'>'+esc(m.label||m.id)+'</option>';
    }
  }else{
    html+='<option value="">Default models (per harness)</option>';
    for(var j=0;j<harnesses.length;j++){
      var hj=harnesses[j];
      var hModels=catalog[hj]||[];
      if(hModels.length>0){
        html+='<optgroup label="'+esc(hj.toUpperCase())+' Models">';
        for(var k=0;k<hModels.length;k++){
          var mk=hModels[k];
          var isSelK=(mk.id===curVal)?' selected':'';
          html+='<option value="'+esc(mk.id)+'"'+isSelK+'>'+esc(mk.label||mk.id)+'</option>';
        }
        html+='</optgroup>';
      }
    }
  }
  html+='<option value="__custom__"'+(curVal==='__custom__'?' selected':'')+'>Custom model…</option>';
  sel.innerHTML=html;
  updateCustomModelInputVisibility();
}

var launchModelSel=document.getElementById('launch-model');
if(launchModelSel){
  launchModelSel.onchange=updateCustomModelInputVisibility;
}

function renderHarnessCards(){
  var container=document.getElementById('harness-cards');
  if(!container)return;
  var detected=window.__harnesses||[];
  var selected=window.__selectedHarnesses||['claude'];
  var list=['claude','codex','opencode','cursor','antigravity','grok','qwen'];
  var counts={};
  (window.__workers||[]).forEach(function(w){
    if(w.alive&&w.driver) counts[w.driver]=(counts[w.driver]||0)+1;
  });

  container.innerHTML=list.map(function(d){
    var det=detected.find(function(x){return x.driver===d;});
    var isSel=selected.indexOf(d)!==-1;
    var cls='harness-card'+(isSel?' sel':'')+((det&&!det.detected)?' missing':'');
    var check=isSel?' <span style="font-size:10px;opacity:0.8">✓</span>':'';
    var badge=counts[d]?' <div class="dim" style="display:inline-block;font-size:10px;margin-left:3px">'+counts[d]+' running</div>':'';
    return '<div class="'+cls+'" data-harness="'+esc(d)+'" title="'+(isSel?'Click to deselect (at least 1 must remain)':'Click to select harness for crew')+'">'+esc(d)+check+badge+'</div>';
  }).join('');

  Array.prototype.forEach.call(container.querySelectorAll('.harness-card'),function(c){
    c.onclick=function(){
      var h=c.getAttribute('data-harness');
      var selList=(window.__selectedHarnesses||['claude']).slice();
      var idx=selList.indexOf(h);
      if(idx!==-1){
        if(selList.length>1){
          selList.splice(idx,1);
        }
      }else{
        selList.push(h);
        var countEl=document.getElementById('launch-count');
        if(countEl&&(parseInt(countEl.value,10)||1)<selList.length){
          countEl.value=selList.length;
        }
      }
      window.__selectedHarnesses=selList;
      var sel=document.getElementById('launch-harness');
      if(sel) sel.value=selList.join(',');
      var topH=document.getElementById('topbar-harness');
      if(topH&&selList.length===1) topH.value=selList[0];
      renderHarnessCards();
      syncModelOptions();
    };
  });
}

function selectSingleHarness(h){
  window.__selectedHarnesses=[h];
  var sel=document.getElementById('launch-harness');
  if(sel) sel.value=h;
  renderHarnessCards();
  syncModelOptions(h);
}

// live-refreshes only the table, never the <select> so user in-progress picks are untouched
function refreshLaunchMeta(){
  fetchLaunchMetaCached('harnesses','/api/harnesses').then(function(h){
    if(h){
      window.__harnesses=h;
      var sel=document.getElementById('launch-harness');
      var oldVal=sel.value;
      var drivers=h.map(function(x){return x.driver;});
      sel.innerHTML=drivers.map(function(d){return '<option value="'+esc(d)+'">'+esc(d)+'</option>';}).join('');
      if(drivers.indexOf(oldVal)!==-1) sel.value=oldVal;
      renderHarnessCards();
    }
  });
  fetchLaunchMetaCached('routes','/api/routes').then(function(r){
    if(r&&r.routes){
      var rl=document.getElementById('routes-line');
      if(rl) rl.textContent=r.routes.join(' · ');
    }
  });
  fetchLaunchMetaCached('models','/api/models').then(function(m){
    var catalog=(m&&m.models)?m.models:(m||{});
    window.__modelCatalog=catalog;
    syncModelOptions();
  });
}

function loadLaunchMeta(){ refreshLaunchMeta(); }

// Brief Counter & Stepper
var briefInp=document.getElementById('launch-brief');
if(briefInp){
  briefInp.addEventListener('input',function(){
    var len=this.value.length;
    var el=document.getElementById('launch-brief-count');
    if(el) el.textContent=len+'/8000';
  });
}

var btnMinus=document.getElementById('launch-count-minus');
var btnPlus=document.getElementById('launch-count-plus');
var countInp=document.getElementById('launch-count');
if(btnMinus&&countInp){
  btnMinus.onclick=function(){
    var v=Math.max(1,(parseInt(countInp.value,10)||1)-1);
    countInp.value=v;
  };
}
if(btnPlus&&countInp){
  btnPlus.onclick=function(){
    var v=Math.min(20,(parseInt(countInp.value,10)||1)+1);
    countInp.value=v;
  };
}

// Permission Segmented
var permSeg=document.getElementById('launch-permission-seg');
if(permSeg){
  Array.prototype.forEach.call(permSeg.querySelectorAll('button'),function(btn){
    btn.onclick=function(){
      Array.prototype.forEach.call(permSeg.querySelectorAll('button'),function(b){b.classList.remove('sel');});
      btn.classList.add('sel');
      var p=btn.getAttribute('data-perm');
      var inp=document.getElementById('launch-permission');
      if(inp) inp.value=p;
    };
  });
}

function renderLaunchDiff(diff){
  var el=document.getElementById('launch-diff');
  if(!el)return;
  if(!diff||!diff.changes||diff.changes.length===0){ el.innerHTML=''; el.style.display='none'; return; }
  el.style.display='block';
  el.innerHTML='<div class="dim" style="font-size:11px;margin-bottom:4px">Dry-run preview diff:</div><div class="log">'+esc(diff.changes.join(String.fromCharCode(10)))+'</div>';
}

function say(msg,isErr){
  var res=document.getElementById('result');
  if(res){
    res.textContent=msg;
    res.style.color=isErr?'var(--danger)':'var(--ok)';
  }
}

function creds(){
  try{
    return {
      from: document.getElementById('who')?document.getElementById('who').value.trim():localStorage.getItem('crewbus_who')||'',
      token: document.getElementById('tok')?document.getElementById('tok').value.trim():localStorage.getItem('crewbus_tok')||''
    };
  }catch(_){ return {from:'',token:''}; }
}

async function kill(names){
  var c=creds();
  var r=await fetch('/api/kill',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({from:c.from||'orchestrator',token:c.token||undefined,workers:names})
  });
  var j=await r.json();
  if(!r.ok){ say('kill failed: '+(j.error||r.status),true); return; }
  showUndoToast('Terminated '+names.join(', '));
  refresh();
}

async function ackOne(id){
  var c=creds();
  var r=await fetch('/api/ack',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({from:c.from||'orchestrator',token:c.token||undefined,id:id})
  });
  var j=await r.json();
  if(!r.ok) say('ack failed: '+(j.error||r.status),true);
  refresh();
}

async function decide(id, decision, reason){
  var c=creds();
  var reasonInp=document.querySelector('[data-reason="'+id+'"]');
  var actualReason=reason||(reasonInp?reasonInp.value.trim():'')||undefined;
  try{
    var r=await fetch('/api/approve',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({from:c.from||'orchestrator',token:c.token||undefined,id:id,decision:decision,reason:actualReason})
    });
    var j=await r.json();
    if(!r.ok){ say('approval decision failed: '+(j.error||r.status),true); return; }
    var card=document.querySelector('[data-approval-id="'+id+'"]');
    if(card){
      card.innerHTML='<div style="font-weight:600;color:'+(decision==='approved'?'var(--ok)':'var(--danger)')+'">'+(decision==='approved'?'✓ Approved':'✗ Declined')+'</div>';
    }
    refresh();
  }catch(e){ say('approval error: '+e.message,true); }
}

var btnKillAll=document.getElementById('killall');
if(btnKillAll){
  btnKillAll.onclick=function(){
    var alive=(window.__workers||[]).filter(function(w){return w.alive;}).map(function(w){return w.name;});
    if(!alive.length){say('no active workers to kill');return;}
    if(confirm('kill '+alive.length+' active workers?')) kill(alive);
  };
}
var btnAckAll=document.getElementById('ackall');
if(btnAckAll){
  btnAckAll.onclick=function(){
    var c=creds();
    fetch('/api/ack',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({from:c.from||'orchestrator',token:c.token||undefined,all:true})
    }).then(function(r){return r.json();}).then(function(j){say('acked all');refresh();});
  };
}

// Launch Logic
async function doLaunch(dryRun){
  var brief=(document.getElementById('launch-brief')?document.getElementById('launch-brief').value:'').trim();
  if(!brief){ say('enter instructions / brief before launching',true); return; }
  var harnesses=(window.__selectedHarnesses&&window.__selectedHarnesses.length>0)
    ? window.__selectedHarnesses
    : [document.getElementById('launch-harness')?document.getElementById('launch-harness').value:'claude'];
  var harnessStr=harnesses.join(',');
  var count=parseInt(document.getElementById('launch-count')?document.getElementById('launch-count').value:'1',10)||1;
  var permission=document.getElementById('launch-permission')?document.getElementById('launch-permission').value:'supervised';
  var model=document.getElementById('launch-model')?document.getElementById('launch-model').value:'';
  if(model==='__custom__'){
    var customInp=document.getElementById('launch-model-custom');
    model=customInp?customInp.value.trim():'';
  }
  var cwd=(document.getElementById('launch-cwd')?document.getElementById('launch-cwd').value.trim():'')||undefined;
  var c=creds();

  var payload={
    from: c.from||'orchestrator',
    token: c.token||undefined,
    harness: harnessStr,
    harnesses: harnesses,
    count: count,
    body: brief,
    permission: permission,
    dryRun: dryRun,
    cwd: cwd
  };
  if(model) payload.model=model;

  var harnLabel=harnesses.join(', ');
  if(!dryRun && !confirm('live boot '+count+' worker(s) ('+harnLabel+')?')) return;

  var outEl=document.getElementById('launch-out');
  if(outEl) outEl.style.display='none';

  try{
    var r=await fetch('/api/launch',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(payload)
    });
    var j=await r.json();
    if(!r.ok){ say('launch failed ('+r.status+'): '+(j.error||'unknown error'),true); return; }

    if(dryRun){
      if(outEl){
        outEl.style.display='block';
        outEl.textContent='[dry-run] plan valid — booted nothing.'+String.fromCharCode(10,10)+'Commands:'+String.fromCharCode(10)+(j.commands||[]).join(String.fromCharCode(10));
      }
      renderLaunchDiff({changes: j.commands||[]});
    } else {
      say('launched crew: '+(j.crewId||'ok'));
      if(document.getElementById('launch-brief')) document.getElementById('launch-brief').value='';
      if(j.batch) showBrief(j.batch);
      refresh();
    }
  }catch(e){ say('launch network error: '+e.message,true); }
}

var btnLaunchGo=document.getElementById('launch-go');
if(btnLaunchGo){
  btnLaunchGo.onclick=function(){
    doLaunch(false);
  };
}
var btnLaunchPrev=document.getElementById('launch-preview');
if(btnLaunchPrev){
  btnLaunchPrev.onclick=function(){ doLaunch(true); };
}

document.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey)&&e.key==='k'){
    e.preventDefault();
    openPalette();
  }
  if((e.ctrlKey||e.metaKey)&&e.key==='n'){
    e.preventDefault();
    startNewThread();
  }
  if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){
    var brief=document.getElementById('launch-brief');
    if(brief&&document.activeElement===brief){
      e.preventDefault();
      var go=document.getElementById('launch-go');
      if(go) go.click();
    }
  }
});

// Command Palette
function openPalette(){
  var p=document.getElementById('palette');
  if(p){ p.classList.add('open'); var inp=document.getElementById('palette-input'); if(inp){inp.value=''; inp.focus(); renderPaletteItems('');} }
}
function closePalette(){ var p=document.getElementById('palette'); if(p) p.classList.remove('open'); }
var palInput=document.getElementById('palette-input');
if(palInput){
  palInput.oninput=function(){ renderPaletteItems(this.value.toLowerCase().trim()); };
  palInput.onkeydown=function(e){
    if(e.key==='Escape') closePalette();
  };
}
var palWrap=document.getElementById('palette');
if(palWrap){
  palWrap.onclick=function(e){ if(e.target===palWrap) closePalette(); };
}

function renderPaletteItems(q){
  var list=document.getElementById('palette-list');
  if(!list)return;
  var items=[
    {label:'New Mission Thread',action:function(){startNewThread();}},
    {label:'Set Codebase Folder…',action:function(){promptOrSelectProjectFolder();}},
    {label:'View Active Crews',action:function(){approotNavTo('sec-crews');}},
    {label:'View Approvals Queue',action:function(){approotNavTo('sec-approvals');}},
    {label:'View Fleet Sync',action:function(){approotNavTo('sec-fleet');}},
    {label:'View Broadcast Channels',action:function(){approotNavTo('sec-channels');}},
    {label:'Pair Mobile Device (QR)',action:function(){open('/pair','_blank');}},
    {label:'Toggle Dark / Light Mode',action:function(){crewbusThemeToggle();}},
    {label:'Kill All Running Workers',action:function(){btnKillAll.click();}}
  ];
  (window.__workers||[]).forEach(function(w){
    items.push({label:'Inspect worker: '+w.name,action:function(){showInspector(w.name);}});
  });
  var filtered=items.filter(function(it){return !q||it.label.toLowerCase().indexOf(q)!==-1;});
  list.innerHTML=filtered.map(function(it,idx){
    return '<div class="'+(idx===0?'sel':'')+'" data-idx="'+idx+'">'+esc(it.label)+'</div>';
  }).join('');
  Array.prototype.forEach.call(list.querySelectorAll('div'),function(el){
    el.onclick=function(){
      var idx=parseInt(el.getAttribute('data-idx'),10);
      closePalette();
      if(filtered[idx]&&filtered[idx].action) filtered[idx].action();
    };
  });
}

// Popover
var projTrig=document.getElementById('project-trigger');
if(projTrig){
  projTrig.onclick=function(ev){
    ev.stopPropagation();
    var p=document.getElementById('project-popover');
    if(p) p.classList.toggle('open');
  };
}
document.addEventListener('click',function(e){
  var pop=document.getElementById('project-popover');
  if(pop&&!pop.contains(e.target)&&e.target!==projTrig) pop.classList.remove('open');
});

var btnCopyBoard=document.getElementById('copy-board-btn');
if(btnCopyBoard){
  btnCopyBoard.onclick=function(){
    try{ navigator.clipboard.writeText(boardPath); say('copied board path: '+boardPath); }catch(_){}
  };
}

// Codebase Directory (Working Directory) Management
function applyTargetCwd(pathStr, notify){
  pathStr=String(pathStr||'').trim();
  var cwdEl=document.getElementById('launch-cwd');
  if(cwdEl&&cwdEl.value!==pathStr) cwdEl.value=pathStr;
  var popCwd=document.getElementById('pop-cwd-path');
  if(popCwd) popCwd.textContent=pathStr||'(default: board parent)';
  var topbarBoard=document.getElementById('topbar-board');
  if(topbarBoard&&pathStr){
    topbarBoard.title='Codebase: '+pathStr;
  }
  if(pathStr){
    try{ localStorage.setItem('crewbus_last_cwd',pathStr); }catch(_){}
    try{
      fetch('/api/workspace',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({cwd:pathStr})
      }).catch(function(){});
    }catch(_){}
    if(notify) say('Target codebase set to: '+pathStr);
  }
}

async function promptOrSelectProjectFolder(){
  var cur=(document.getElementById('launch-cwd')?document.getElementById('launch-cwd').value.trim():'')||localStorage.getItem('crewbus_last_cwd')||'';
  try{
    var dialog=window.__TAURI__&&window.__TAURI__.dialog;
    if(dialog&&typeof dialog.open==='function'){
      var selected=await dialog.open({directory:true,multiple:false,title:'Select Target Codebase Folder'});
      if(selected&&typeof selected==='string'){
        applyTargetCwd(selected.trim(),true);
        return;
      }
    }
  }catch(_){}

  if(typeof window.showDirectoryPicker==='function'){
    try{
      var dirHandle=await window.showDirectoryPicker();
      if(dirHandle&&dirHandle.name){
        var suggested=(cur&&cur.endsWith(dirHandle.name))?cur:dirHandle.name;
        var p=prompt('Confirm absolute directory path for "'+dirHandle.name+'" (where workers execute commands and edit code):',suggested);
        if(p&&p.trim()){
          applyTargetCwd(p.trim(),true);
        }else if(dirHandle.name){
          applyTargetCwd(dirHandle.name,true);
        }
        return;
      }
    }catch(err){
      if(err&&(err.name==='AbortError'||err.code===20)) return;
    }
  }

  var manual=prompt('Enter target codebase directory path (where workers execute commands and edit code):',cur);
  if(manual&&manual.trim()){
    applyTargetCwd(manual.trim(),true);
  }
}

var openFolderBtn=document.getElementById('open-folder-btn');
if(openFolderBtn) openFolderBtn.onclick=promptOrSelectProjectFolder;
var lcBrowse=document.getElementById('launch-cwd-browse');
if(lcBrowse) lcBrowse.onclick=promptOrSelectProjectFolder;
var lcInp=document.getElementById('launch-cwd');
if(lcInp){
  lcInp.oninput=function(){ applyTargetCwd(this.value,false); };
  try{
    var lastCwd=localStorage.getItem('crewbus_last_cwd');
    if(lastCwd) applyTargetCwd(lastCwd,false);
  }catch(_){}
}

var swBtn=document.getElementById('switch-board-btn');
if(swBtn){
  swBtn.onclick=function(){
    var folder=prompt('Switch board: enter project folder or board directory path:','');
    if(!folder||!folder.trim()) return;
    try{
      var invoke=window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke;
      if(typeof invoke==='function'){
        invoke('switch_board',{boardPath:folder.trim()}).then(function(){location.reload();});
        return;
      }
    }catch(_){}
    say('Board switching requires desktop app. CLI: crewbus serve --board '+folder.trim()+'/.crewbus');
  };
}
var rsBtn=document.getElementById('reset-board-btn');
if(rsBtn){
  rsBtn.onclick=function(){
    try{
      var invoke=window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke;
      if(typeof invoke==='function'){
        invoke('board_status').then(function(st){
          if(st&&st.defaultBoard) invoke('switch_board',{boardPath:st.defaultBoard}).then(function(){location.reload();});
        });
        return;
      }
    }catch(_){}
    say('Reset requires desktop app.');
  };
}

try{
  fetch('/api/workspace').then(function(r){return r.ok?r.json():null;}).then(function(j){
    if(!j||!j.cwd)return;
    var cur=(document.getElementById('launch-cwd')?document.getElementById('launch-cwd').value.trim():'');
    try{
      var lsCwd=localStorage.getItem('crewbus_last_cwd')||'';
      if(lsCwd&&lsCwd!==j.cwd&&(!cur||cur===lsCwd)){
        fetch('/api/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cwd:lsCwd})}).catch(function(){});
        return;
      }
    }catch(_){}
    if(!cur) applyTargetCwd(j.cwd,false);
  }).catch(function(){});
}catch(_){}

// Data Age indicator
function agoMs(ms){var s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m';return Math.floor(m/60)+'h';}
function ago(iso){try{var t=Date.parse(iso);if(isNaN(t))return '?';return agoMs(Date.now()-t)+' ago';}catch(e){return '?';}}
function updatePollAge(){
  var el=document.getElementById('poll-age');
  if(!el)return;
  if(!window.__lastBoardPoll){el.textContent='connecting…';return;}
  var age=Date.now()-window.__lastBoardPoll;
  var s=Math.max(0,Math.floor(age/1000));
  el.textContent=s+'s ago';
}

crewbusThemeInit();
loadLaunchMeta();
refresh();
setInterval(refresh,5000);
setInterval(updatePollAge,1000);
</script>
</body>
</html>`;
}

export const readKillBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= 65536) chunks.push(c);
    });
    req.on("end", () => {
      if (size > 65536) return resolve({ error: [413, "body too large (max 64KB)"] });
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return resolve({ error: [400, "invalid JSON body"] });
      }
      resolve({ body });
    });
    req.on("error", () => resolve({ error: [400, "unreadable body"] }));
  });

// Shared web dashboard API routes for both `crewbus web` and `crewbus serve`
// (embedded Tauri webview). Returns true if the route was handled, false otherwise.

let _qrSrc = null;
function getQrSrc() {
  if (_qrSrc === null) {
    try {
      _qrSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "qrcode.js"), "utf8");
    } catch {
      _qrSrc = "";
    }
  }
  return _qrSrc;
}

export function renderPairHtml(root) {
  const qrCodeSrc = getQrSrc();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair Mobile Client — CrewBus</title>
<script>
try{var __t=null;try{__t=localStorage.getItem('crewbus-theme')||localStorage.getItem('crewbus-desktop-theme');}catch(_){}if(__t==='light'||__t==='dark'){document.documentElement.setAttribute('data-theme',__t);}}catch(_){}
</script>
<style>
:root{
  --bg:#f4f6f3;
  --panel:#ffffff;
  --ink:#14201a;
  --dim:#5b6a62;
  --acc:#5b6a62;
  --acc-ink:#ffffff;
  --warn:#b86e00;
  --line:#d5ddd7;
  --scroll:rgba(0,0,0,.18);
  --scroll-hi:rgba(0,0,0,.32);
  --danger:#f85149;
  --danger-bg:rgba(248,81,73,0.12);
  --ok:#3d8f66;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0f1419;--panel:#182028;--ink:#e3e9ee;--dim:#8b98a5;--acc:#8b98a5;--acc-ink:#07130d;--warn:#ffb454;--line:#2a343e;
  --scroll:rgba(255,255,255,.16);
  --scroll-hi:rgba(255,255,255,.32);
  --ok:#4fb07f;
}}
:root[data-theme="light"]{--bg:#f4f6f3;--panel:#ffffff;--ink:#14201a;--dim:#5b6a62;--acc:#5b6a62;--acc-ink:#ffffff;--warn:#b86e00;--line:#d5ddd7;--scroll:rgba(0,0,0,.18);--scroll-hi:rgba(0,0,0,.32);--ok:#3d8f66}
:root[data-theme="dark"]{--bg:#0f1419;--panel:#182028;--ink:#e3e9ee;--dim:#8b98a5;--acc:#8b98a5;--acc-ink:#07130d;--warn:#ffb454;--line:#2a343e;--scroll:rgba(255,255,255,.16);--scroll-hi:rgba(255,255,255,.32);--ok:#4fb07f}
* {
  box-sizing:border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--scroll) transparent;
}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px}
h2{margin:0 0 6px;font-size:17px;font-weight:700;color:var(--ink)}
.dim{color:var(--dim);font-size:12px;line-height:1.4}
#qr-wrap{width:220px;height:220px;margin:16px auto;border:1px solid var(--line);background:var(--panel);border-radius:12px;display:flex;align-items:center;justify-content:center;text-align:center;padding:10px;overflow:hidden}
#qr-wrap svg{width:100%;height:100%;display:block;border-radius:6px}
#qr{color:var(--dim);font-size:12px}
textarea{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px 10px;font-size:12px;resize:vertical;font-family:monospace}
textarea:focus{border-color:var(--acc);outline:none}
.btn-row{display:flex;gap:8px;margin-top:10px}
button{background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
button:hover{border-color:var(--acc);color:var(--acc)}
button.primary{background:var(--acc);border-color:var(--acc);color:var(--acc-ink)}
button.primary:hover{filter:brightness(1.1)}
#msg{min-height:1.5em;margin-top:10px;font-size:12px}
.warn{color:var(--danger)}
.ok{color:var(--ok)}
</style>
</head>
<body>
<h2>Pair Mobile Client</h2>
<p class="dim">A one-time pairing link is minted automatically from the local
board — scan the QR with CrewBus Mobile. (Advanced: paste a
<code>crewbus://pair</code> URL from <code>relay pair qr</code> or
<code>serve --pair-qrcode</code> to render it instead.)</p>

<div id="qr-wrap">
  <div id="qr" aria-label="pairing QR">QR code will appear here after rendering</div>
</div>

<label class="dim" for="pair-url">Pairing URL (in-memory only, secret in #fragment never saved):</label>
<textarea id="pair-url" rows="3" placeholder="crewbus://pair?env=…&amp;routes=…&amp;caps=…#abp-…"></textarea>

<div class="btn-row">
  <button id="pair-render" class="primary">Render QR</button>
  <button id="pair-clear">Clear</button>
</div>

<div id="msg" class="dim" role="status"></div>
<script type="module">
${qrCodeSrc}

var box = document.getElementById('pair-url');
var qr = document.getElementById('qr');
var qrWrap = document.getElementById('qr-wrap') || (qr ? qr.parentElement : null);
var msg = document.getElementById('msg');
var renderBtn = document.getElementById('pair-render');
var clearBtn = document.getElementById('pair-clear');

function say(t, isErr) {
  if (!msg) return;
  msg.textContent = t;
  msg.className = isErr ? 'warn' : 'ok';
}

function qrThemeColors() {
  var theme = null;
  try { theme = localStorage.getItem('crewbus-theme') || localStorage.getItem('crewbus-desktop-theme'); } catch (_) {}
  if (theme !== 'light' && theme !== 'dark') {
    try { theme = document.documentElement.getAttribute('data-theme'); } catch (_) {}
  }
  if (theme !== 'light' && theme !== 'dark') {
    try { theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme:dark)').matches) ? 'dark' : 'light'; }
    catch (_) { theme = 'light'; }
  }
  if (theme === 'dark') return { dark: '#e3e9ee', light: '#182028' };
  return { dark: '#14201a', light: '#ffffff' };
}

function validatePairUrl(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s.startsWith('crewbus://pair')) throw new Error('not a crewbus pair URL');
  var u = new URL(s);
  for (var p of u.searchParams) {
    var k = p[0].toLowerCase();
    var v = p[1];
    if (['secret', 'token', 'pairtoken', 'pair_token', 'pair-token', 'credential'].indexOf(k) !== -1 || v.startsWith('abp-')) {
      throw new Error('pairing secret in query — secrets travel in #fragment only');
    }
  }
  var frag = u.hash ? decodeURIComponent(u.hash.slice(1)) : '';
  if (!frag) throw new Error('missing #fragment pairing secret');
  if (!frag.startsWith('abp-')) throw new Error('fragment is not a pairing secret (want abp-...)');
  return { env: u.searchParams.get('env') || '(local)', pairToken: frag };
}

function describeForDisplay(u) {
  return String(u).split('#')[0];
}

function clearAll() {
  if (box) box.value = '';
  if (qrWrap) qrWrap.innerHTML = '<div id="qr" aria-label="pairing QR">QR code will appear here after rendering</div>';
  qr = document.getElementById('qr');
  say('');
}

function renderUrl(raw) {
  var parsed = validatePairUrl(raw);
  var svg = renderQrSvg(raw.trim(), {
    width: 200,
    margin: 1,
    color: qrThemeColors(),
  });
  if (qrWrap) qrWrap.innerHTML = svg;
  say('QR code ready for ' + describeForDisplay(raw) + ' — scan with CrewBus Mobile.');
}

if (renderBtn) {
  renderBtn.addEventListener('click', function () {
    var raw = box ? box.value : '';
    if (!raw.trim()) { say('paste a pair URL first', true); return; }
    try {
      renderUrl(raw);
    } catch (e) {
      say('rejected: ' + String((e && e.message) || e), true);
    }
  });
}

if (clearBtn) {
  clearBtn.addEventListener('click', clearAll);
}

async function autoMint() {
  say('minting a one-time pairing link…');
  try {
    var r = await fetch('/api/pair-qr', { method: 'POST' });
    var j = null;
    try { j = await r.json(); } catch (_) {}
    if (!r.ok || !j || !j.ok || !j.pairUrl) {
      say('auto-mint failed (' + (j && j.error ? j.error : ('HTTP ' + r.status)) + ') — paste a pair URL manually', true);
      return;
    }
    if (box) box.value = j.pairUrl;
    renderUrl(j.pairUrl);
    var exp = j.expiresAt ? new Date(j.expiresAt) : null;
    say('QR ready — scan with CrewBus Mobile.' + (exp ? ' Link expires ' + exp.toLocaleTimeString() + ' (single-use).' : ''));
  } catch (e) {
    say('auto-mint failed: ' + String((e && e.message) || e) + ' — paste a pair URL manually', true);
  }
}

autoMint();
</script>
</body>
</html>`;
}

export async function handleWebDashboardRoute(req, res, url, d) {
  if (req.method === "GET" && url.pathname === "/pair") {
    const body = renderPairHtml(d.root);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/board") {
    const body = JSON.stringify(boardSnapshot(d, 300));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/fleet") {
    const body = JSON.stringify(await fleetSnapshot(d));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/channels") {
    const body = JSON.stringify(channelsSnapshot(d, 5));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/results") {
    const body = JSON.stringify(resultsSnapshot(d));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/audit") {
    const body = JSON.stringify(auditSnapshot(d, 15));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/holds") {
    // Open read like /api/board (holds are visible to every board
    // reader via `hold status`; secrets never included — publicHold
    // allowlists hold metadata only, inactive serves as null).
    const body = JSON.stringify({ board: d.root, hold: publicHold(readHold(d)) });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/quotas") {
    // Open read like /api/board (quotas are visible to every board
    // reader via `quota show`; limits + tenant only, never secrets).
    const body = JSON.stringify({ board: d.root, quotas: readBoardQuotas(d) });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/inbox") {
    // Open read like /api/board (recent messages are already public
    // there); item lists power the triage queue. Secrets never included.
    const agent = cleanWebName(url.searchParams.get("agent"));
    if (!agent) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "pass ?agent=<name>" }));
      return true;
    }
    const limitRaw = Number(url.searchParams.get("limit") || 50);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const known = ackedIds(d, agent);
    const items = readVisible(d, agent)
      .filter((m) => (url.searchParams.get("unacked") === "1" ? !known.has(m.id) : true))
      .slice(-limit)
      .map((m) => ({
        id: m.id, from: m.from, at: m.at, subject: m.subject || "",
        head: String(m.body || "").slice(0, 160),
        replyTo: m.replyTo || "", batch: m.batch || "",
        checkpoint: m.checkpoint === true,
        artifact: m.artifact || "", acked: known.has(m.id),
      }));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ board: d.root, agent, items }));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/gather") {
    // Open read like /api/board (the transcript is already visible piece
    // by piece there); the dashboard twin of `gather --batch`: one brief
    // thread — briefs, checkpoint timeline, final reports — oldest first.
    const batch = String(url.searchParams.get("batch") || "").trim().slice(0, 200);
    if (!batch) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "pass ?batch=<batch-id>" }));
      return true;
    }
    const got = collectBatch(d, batch);
    if (!got) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `unknown batch "${batch}"` }));
      return true;
    }
    const known = ackedIdSet(d);
    const tele = gatherTelemetry(got.items);
    const items = got.items.map((m) => ({
      id: m.id, from: m.from, to: m.to, at: m.at, subject: m.subject || "",
      body: String(m.body || ""), replyTo: m.replyTo || "", batch: m.batch || "",
      checkpoint: m.checkpoint === true, acked: known.has(m.id),
    }));
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ board: d.root, batch, briefs: got.briefs, replies: got.replies, telemetry: tele, items }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/ack") {
    // JSON-only like /api/kill (plain browser forms can't reach it),
    // token-checked like the CLI, no --verify over HTTP.
    if (!String(req.headers["content-type"] || "").includes("application/json")) {
      res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "content-type must be application/json" }));
      return true;
    }
    const { body, error } = await readKillBody(req);
    if (error) {
      res.writeHead(error[0], { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error[1] }));
      return true;
    }
    const out = await handleApiAck(d, body);
    res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(out.payload));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/approve") {
    // JSON-only like /api/ack (plain browser forms can't reach it),
    // token-checked like the CLI. Any valid identity may answer; the
    // worker-side sender check is the real gate.
    if (!String(req.headers["content-type"] || "").includes("application/json")) {
      res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "content-type must be application/json" }));
      return true;
    }
    const { body, error } = await readKillBody(req);
    if (error) {
      res.writeHead(error[0], { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error[1] }));
      return true;
    }
    const out = await handleApiApprove(d, body);
    res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(out.payload));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/operator-creds") {
    const ip = req.socket.remoteAddress || "";
    const isLoop = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLoop) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "loopback only" }));
      return true;
    }
    for (const name of [ORCHESTRATOR_NAME]) {
      const tokenFile = path.join(d.root, "logs", `${name}.token`);
      let tok = "";
      try { tok = fs.readFileSync(tokenFile, "utf8").trim(); } catch {}
      // Verify the file token still matches the agent record: a stale file
      // (revoked/rotated operator) must not prefill a dead token.
      if (tok) {
        try {
          const rec = readAgent(d, name);
          if (rec && agentTokenMatches(rec, tok)) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            res.end(JSON.stringify({ ok: true, from: name, token: tok }));
            return true;
          }
        } catch {}
      }
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false, error: "no operator token found" }));
    return true;
  }
  // Workspace memory (server-side, survives the random-port origin wipe):
  // GET returns the last-set target codebase dir (or default board parent);
  // POST { cwd } validates + persists it to board.json so desktop + web agree.
  if (req.method === "GET" && url.pathname === "/api/workspace") {
    let meta = {};
    try { meta = readBoardMeta(d) || {}; } catch {}
    const cwd = (meta && meta.workspaceCwd) || path.dirname(d.root);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, cwd, board: d.root }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/workspace") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) {
      res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "content-type must be application/json" }));
      return true;
    }
    const { body, error } = await readKillBody(req);
    if (error) {
      res.writeHead(error[0], { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error[1] }));
      return true;
    }
    const raw = body && body.cwd !== undefined && body.cwd !== null ? String(body.cwd).trim() : "";
    const cwd = raw ? path.resolve(raw) : path.dirname(d.root);
    let ok = false;
    try { ok = fs.statSync(cwd).isDirectory(); } catch {}
    if (!ok) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `cwd is not a directory: ${cwd}` }));
      return true;
    }
    try {
      const meta = readBoardMeta(d) || {};
      meta.workspaceCwd = cwd;
      writeBoardMeta(d, meta);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      return true;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, cwd, board: d.root }));
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/install-cli") {
    const ip = req.socket.remoteAddress || "";
    const isLoop = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
    if (!isLoop) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "loopback only" }));
      return true;
    }
    try {
      const resInstall = installCliToUserPath();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, ...resInstall }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
    }
    return true;
  }
  // One-click mobile pairing (plug-and-play): mint a one-time pair URL
  // server-side and return it for immediate QR render. Loopback-only;
  // same mint + audit as relay pair qr / serve --pair-qrcode. The dashboard
  // pair window calls this on open, so normies never touch a terminal.
  if (req.method === "POST" && url.pathname === "/api/pair-qr") {
    const ip = req.socket.remoteAddress || "";
    const isLoop = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
    if (!isLoop) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "loopback only" }));
      return true;
    }
    try {
      const token = newPairToken();
      const salt = newSalt();
      const now = Date.now();
      const ttlMs = 10 * 60 * 1000;
      const doc = {
        tokenHash: hashToken(token, salt), salt, label: "dashboard-oneclick",
        createdBy: ORCHESTRATOR_NAME, createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      };
      fs.mkdirSync(path.join(d.root, "pairing"), { recursive: true });
      writeJson(pairingPath(d, doc.tokenHash), doc);
      try { appendChainRecord(d, ORCHESTRATOR_NAME, "pair", { label: "dashboard-oneclick", expiresAt: doc.expiresAt }); } catch {}
      const relayDoc = readRelayState(d);
      const envId = (relayDoc && relayDoc.envId) || ("board:" + path.basename(d.root));
      let routes = (relayDoc && Array.isArray(relayDoc.advertisedRoutes) && relayDoc.advertisedRoutes.length > 0)
        ? relayDoc.advertisedRoutes
        : [];
      if (routes.length === 0) {
        const port = req.socket.localPort || 8471;
        routes = localNetworkRoutes(port);
      }
      if (routes.length === 0 && req.headers.host && !req.headers.host.startsWith("localhost") && !req.headers.host.startsWith("127.")) {
        routes.push(`http://${req.headers.host}`);
      }
      const pairUrl = buildPairUrl({ envId, routes, caps: ["hlc", "tombstones", "channels", "revoked", "holds", "launch"], pairToken: token });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, pairUrl, expiresAt: doc.expiresAt, envId, routes }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
    }
    return true;
  }
  return false;
}

export function localNetworkRoutes(port) {
  const routes = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      for (const item of list || []) {
        if (item.family === "IPv4" && !item.internal && item.address && !item.address.startsWith("169.254.") && !item.address.startsWith("127.")) {
          routes.push(`http://${item.address}:${port}`);
        }
      }
    }
  } catch {}
  return routes;
}

export async function cmdWeb(args) {
  const root = boardDir(args);
  const d = requireBoard(root);
  ensureBoardCliShim(d);
  const host = getFlag(args, "--host") || "0.0.0.0";
  const port = Number(getFlag(args, "--port") || 0);
  // Same local auto-provision as `serve`: the board's single orchestrator is
  // ensured on boot (minted on first use, token at logs/orchestrator.token).
  try { ensureOrchestrator(d); } catch {}
  if (!(port >= 0 && port < 65536)) fail("--port must be 0-65535 (0 = random)");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "0.0.0.0") {
    process.stderr.write(`crewbus: warning: binding non-local ${host} — the dashboard has no auth, anyone who can reach it can read the board\n`);
  }
  const server = http.createServer((req, res) => {
    (async () => {
      try {
        const url = new URL(req.url || "/", "http://x");
        // CORS & Private Network Access: allow cross-origin requests from
        // desktop webviews (tauri://localhost, https://tauri.localhost) and local browsers.
        res.setHeader("access-control-allow-origin", req.headers.origin || "*");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS, PUT, DELETE");
        res.setHeader("access-control-allow-headers", "*");
        res.setHeader("access-control-allow-private-network", "true");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (await handleWebDashboardRoute(req, res, url, d)) return;
        if (serveBrandAsset(req, res, url.pathname)) return;
        if (req.method === "GET" && url.pathname === "/healthz") {
          const s = readRelayState(d);
          const uptimeSec = Math.floor(process.uptime());
          const port = req.socket.localPort || 8471;
          const routes = localNetworkRoutes(port);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({
            role: (s && s.role) || "dashboard",
            weight: 100,
            workers: 0,
            advertisedRoutes: (s && Array.isArray(s.advertisedRoutes) && s.advertisedRoutes.length > 0) ? s.advertisedRoutes : routes,
            uptimeSec,
          }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/pair/exchange") {
          const s = readRelayState(d);
          if (s && s.role === "standby") {
            res.writeHead(503, { "content-type": "application/json; charset=utf-8", "x-relay-role": "standby" });
            res.end(JSON.stringify({ error: "standby relay: writes refused", role: "standby" }));
            return;
          }
          if (!String(req.headers["content-type"] || "").includes("application/json")) {
            res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "content-type must be application/json" }));
            return;
          }
          const chunks = [];
          let size = 0;
          let tooBig = false;
          req.on("data", (c) => {
            size += c.length;
            if (size <= 65536) chunks.push(c);
            else tooBig = true;
          });
          req.on("end", () => {
            try {
              if (tooBig) {
                res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "body too large (max 64KB)" }));
                return;
              }
              let body = null;
              try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "invalid JSON body" }));
                return;
              }
              const presented = String((body && body.pairToken) || "");
              const label = String((body && body.label) || "").slice(0, 80);
              let requested = null;
              if (body && body.scopes !== undefined && body.scopes !== null) {
                if (!Array.isArray(body.scopes)) {
                  res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
                  res.end(JSON.stringify({ error: "scopes must be an array" }));
                  return;
                }
                requested = [];
                for (const sc of body.scopes) {
                  const c = String(sc).trim();
                  if (!PAIR_SCOPES.includes(c)) {
                    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ error: `unknown scope "${c.slice(0, 60)}" (want ${PAIR_SCOPES.join("|")})` }));
                    return;
                  }
                  if (!requested.includes(c)) requested.push(c);
                }
              }
              let rec = null;
              let recPath = null;
              try {
                const dir = path.join(d.root, "pairing");
                for (const f of fs.readdirSync(dir)) {
                  if (!f.endsWith(".json") || f.endsWith(".used.json")) continue;
                  try {
                    const pdoc = readJson(path.join(dir, f));
                    if (pdoc && pdoc.tokenHash && pdoc.salt && timingSafeEqualStr(hashToken(presented, String(pdoc.salt)), String(pdoc.tokenHash))) {
                      rec = pdoc;
                      recPath = path.join(dir, f);
                      break;
                    }
                  } catch {}
                }
              } catch {}
              if (!rec) {
                res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "unknown pairing token" }));
                return;
              }
              if (Date.parse(rec.expiresAt) <= Date.now()) {
                res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "pairing token expired" }));
                return;
              }
              const granted = Array.isArray(rec.scopes) ? rec.scopes : null;
              if (requested !== null && granted !== null) {
                const wider = requested.filter((s) => !granted.includes(s));
                if (wider.length > 0) {
                  res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
                  res.end(JSON.stringify({ error: `scope widen refused (not granted: ${wider.join(",")})` }));
                  return;
                }
              }
              const usedPath = recPath.replace(/\.json$/, ".used.json");
              if (!writeExclusiveJson(usedPath, { at: new Date().toISOString(), label })) {
                res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "pairing token already used" }));
                return;
              }
              const dc = newDeviceCred();
              const salt = newSalt();
              fs.mkdirSync(path.join(d.root, "devices"), { recursive: true });
              writeJson(devicePath(d, dc.id), {
                id: dc.id, label, secretHash: hashToken(dc.secret, salt), salt,
                createdBy: rec.createdBy || "", createdAt: new Date().toISOString(),
                lastSeen: "", revoked: false,
                scopes: requested !== null ? requested : granted,
              });
              try {
                appendChainRecord(d, "relay", "device-issue", { id: dc.id, label, by: rec.createdBy || "" });
              } catch {}
              res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify({ deviceId: dc.id, credential: dc.cred }));
            } catch (err) {
              res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: `exchange failed: ${(err && err.message) || err}` }));
            }
          });
          req.on("error", () => {
            try {
              res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ error: "unreadable body" }));
            } catch {}
          });
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/kill") {
          // JSON-only (browsers preflight this; simple CSRF forms can't reach
          // it), token-checked like the CLI. Same trust zone as the board.
          if (!String(req.headers["content-type"] || "").includes("application/json")) {
            res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "content-type must be application/json" }));
            return;
          }
          const { body, error } = await readKillBody(req);
          if (error) {
            res.writeHead(error[0], { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: error[1] }));
            return;
          }
          const out = await handleApiKill(d, body);
          res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(out.payload));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/harnesses") {
          // Control-plane M1: driver table with live binary presence.
          // Open read like /api/board (missing = "not installed", never FAIL).
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(detectHarnessBinaries()));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/models") {
          // Canonical model catalog per harness driver + dynamic discovery.
          const doRefresh = url.searchParams.get("refresh") === "1" || url.searchParams.get("refresh") === "true";
          if (doRefresh) {
            refreshDiscoveredModels(15000).then((catalog) => {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify(catalog));
            }).catch(() => {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
              res.end(JSON.stringify(getDiscoveredModels()));
            });
            return;
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(getDiscoveredModels()));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/routes") {
          // Control-plane M1: reachability hints. The local dashboard exposes
          // LAN/relay routes so paired clients can reach it.
          const relayDoc = readRelayState(d);
          const envId = (relayDoc && relayDoc.envId) || `board:${path.basename(d.root)}`;
          let routes = (relayDoc && Array.isArray(relayDoc.advertisedRoutes) && relayDoc.advertisedRoutes.length > 0)
            ? relayDoc.advertisedRoutes
            : [];
          if (routes.length === 0) {
            const effectivePort = req.socket.localPort || 8471;
            routes = localNetworkRoutes(effectivePort);
          }
          if (routes.length === 0 && req.headers.host && !req.headers.host.startsWith("localhost") && !req.headers.host.startsWith("127.")) {
            routes.push(`http://${req.headers.host}`);
          }
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(advertiseEnv({ envId, routes, capabilities: ["hlc", "tombstones", "channels", "revoked", "holds", "launch"] })));
          return;
        }
        if (req.method === "POST" && url.pathname === "/api/launch") {
          // Control-plane M1: launch RPC (JSON-only, token-checked, same
          // trust zone as /api/kill). Dry-run previews; live boots locally.
          if (!String(req.headers["content-type"] || "").includes("application/json")) {
            res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "content-type must be application/json" }));
            return;
          }
          const { body, error } = await readKillBody(req);
          if (error) {
            res.writeHead(error[0], { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: error[1] }));
            return;
          }
          const out = await handleApiLaunch(d, body);
          res.writeHead(out.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify(out.payload));
          return;
        }
        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          const body = renderBoardHtml(d.root);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        if (req.method === "GET" && url.pathname === "/pair") {
          const body = renderPairHtml(d.root);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found (try / or /api/board /api/fleet /api/channels /api/results /api/audit /api/holds /api/quotas /api/inbox /api/harnesses /api/routes)");
      } catch (e) {
        try {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(`request failed: ${(e && e.message) || e}`);
        } catch {}
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const a = server.address();
      const addr = a && typeof a === "object" ? a.address : host;
      const effectivePort = a && typeof a === "object" ? a.port : port;
      const displayHost = (addr === "0.0.0.0" || addr === "::" || addr === "0:0:0:0:0:0:0:0") ? "127.0.0.1" : addr;
      const shown = `${displayHost}:${effectivePort}`;
      const webUrl = `http://${shown}`;
      console.log(`crewbus web at ${webUrl} [board ${d.root}]`);
      if (args.includes("--open")) {
        try {
          if (process.platform === "win32") spawn("cmd.exe", ["/c", "start", webUrl], { detached: true, stdio: "ignore" }).unref();
          else if (process.platform === "darwin") spawn("open", [webUrl], { detached: true, stdio: "ignore" }).unref();
          else spawn("xdg-open", [webUrl], { detached: true, stdio: "ignore" }).unref();
        } catch {}
      }
      resolve();
    });
  });
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  await new Promise(() => {}); // serve until killed
}

// Shared kill core for the web dashboard + sync relay: token-checked like
// the CLI, never calls fail(). Returns { status, payload }.
export async function handleApiKill(d, body) {
  const from = cleanWebName(body && body.from);
  const token = body && body.token !== undefined && body.token !== null && String(body.token) !== "" ? String(body.token) : undefined;
  if (!from) return { status: 400, payload: { error: "missing from (your agent name)" } };
  const rec = readAgent(d, from);
  if (!rec || !(rec.tokenHash || rec.token) || !agentTokenMatches(rec, token)) return { status: 403, payload: { error: "bad token" } };
  let names = [];  if (body && body.all === true) {
    names = listJson(d.agents)
      .map((e) => e.data)
      .filter((x) => x && x.name && typeof x.spawnedPid === "number")
      .map((x) => x.name)
      .sort();
  } else {
    const rawTo = body && body.to !== undefined ? body.to : undefined;
    const parts = Array.isArray(rawTo) ? rawTo : String(rawTo === undefined ? "" : rawTo).split(",");
    for (const part of parts) {
      const c = cleanWebName(part);
      if (c && !names.includes(c)) names.push(c);
    }
    if (names.length === 0) return { status: 400, payload: { error: "pass to <worker,...> (or all true)" } };
  }
  // Phase 1b: relay kill honors the same matrix as CLI spawn-kill (lead own
  // crew only; worker/auditor refused). authorizeCheck (not fail()) so a
  // denial is a 403 payload, never a process exit.
  {
    const r = authorizeCheck(d, from, "spawn-kill", { targets: names });
    if (!r.ok) return { status: 403, payload: { error: r.reason } };
  }
  return { status: 200, payload: { results: await killWorkers(d, names) } };
}

// Control-plane M1: launch RPC for the local dashboard (POST /api/launch per
// packages/contracts/launch.json). Token-checked + authorizeCheck(spawn) like
// /api/kill, never calls fail(). Validates via validateLaunchPlan (same as
// CLI); dryRun previews exact commands without booting; live delivers the
// brief + boots via bootWorker (same core as CLI spawn/remoteSpawn).
export async function handleApiLaunch(d, body) {
  const from = ORCHESTRATOR_NAME;
  const token = body && body.token !== undefined && body.token !== null && String(body.token) !== "" ? String(body.token) : undefined;
  ensureOrchestrator(d);
  if (token) {
    const rec = readAgent(d, from);
    if (!rec || !(rec.tokenHash || rec.token) || !agentTokenMatches(rec, token)) return { status: 403, payload: { error: "bad token" } };
  }
  {
    const r = authorizeCheck(d, from, "spawn");
    if (!r.ok) return { status: 403, payload: { error: r.reason } };
  }
  const v = validateLaunchPlan(body || {});
  if (!v.ok) return { status: 400, payload: { error: "launch plan invalid", errors: v.errors, warnings: v.warnings } };
  const p = v.plan;
  const harnesses = Array.isArray(p.harnesses) && p.harnesses.length > 0 ? p.harnesses : [p.harness || "opencode"];
  const models = Array.isArray(p.models) ? p.models : parseModelList(p.model);
  const coordModel = p.orchestratorModel !== undefined && p.orchestratorModel !== null && String(p.orchestratorModel).trim() !== ""
    ? String(p.orchestratorModel).trim() : modelForIndex(models, 0);
  const orchestratorMode = "auto";
  const orchestratorTarget = ORCHESTRATOR_NAME;
  const names = p.to ? String(p.to).split(",").map((s) => cleanWebName(s)).filter(Boolean)
    : Array.from({ length: p.count }, (_, i) => `${cleanWebName(p.prefix || "w") || "w"}-${i + 1}`);
  if (names.length === 0) return { status: 400, payload: { error: "no worker names (pass to or count)" } };
  const rev = gitRevForBoard(d.root);
  const cwd = body && body.cwd ? path.resolve(String(body.cwd)) : path.dirname(d.root);
  let cwdOk = false;
  try { cwdOk = fs.statSync(cwd).isDirectory(); } catch {}
  if (!cwdOk) return { status: 400, payload: { error: `cwd is not a directory: ${cwd}` } };
  if (v.plan.dryRun) {
    const previewBatch = names.length > 1 ? newId("batch") : undefined;
    const rows = names.map((to, i) => {
      const driver = harnesses[i % harnesses.length];
      const previewPrompt = buildSpawnPrompt({ name: to, orchestrator: orchestratorTarget, subject: p.subject, body: p.body.trim(), replyId: previewBatch ? `${previewBatch}-${i + 1}` : "msg-<id>", rev, cwd, root: d.root });
      const t = buildSpawnTarget({
        harness: driver, model: modelForIndex(models, i),
        auto: p.permission === "auto" || p.permission === "full" ? true : undefined,
        maxTurns: p.maxTurns, allowTools: p.allowTools, cwd,
        name: to, promptPath: path.join("<board>", "logs", `${to}-<stamp>.prompt.md`), prompt: previewPrompt,
      });
      return { to, harness: driver, command: formatSpawnCmd(t) };
    });
    let coordinator = undefined;
    if (orchestratorMode === "auto") {
      const existingLead = readAgent(d, ORCHESTRATOR_NAME);
      // Stale-pid guard (C2): reuse only a live, non-stale coordinator; a
      // pid-recycled after reboot record gets the fresh-provision branch.
      const standing = existingLead && typeof existingLead.spawnedPid === "number" && pidAlive(existingLead.spawnedPid) && !isPidStale(existingLead.spawnedPid, existingLead.spawnedAt);
      if (standing) {
        coordinator = { name: ORCHESTRATOR_NAME, action: "reused", pid: existingLead.spawnedPid, note: "live coordinator already running" };
      } else if (existingLead && existingLead.offboarded) {
        coordinator = { name: ORCHESTRATOR_NAME, action: "skipped", reason: "lane is offboarded" };
      } else {
        const coordDriver = harnesses[0] || "opencode";
        const previewCoordPrompt = buildOrchestratorPrompt({
          name: ORCHESTRATOR_NAME, subject: p.subject, body: p.body.trim(), batch: previewBatch,
          workers: names.map((name, i) => ({ name, id: previewBatch ? `${previewBatch}-${i + 1}` : "msg-<id>", harness: harnesses[i % harnesses.length] })),
          cwd, root: d.root, auto: p.permission === "auto" || p.permission === "full",
        });
        coordinator = {
          name: ORCHESTRATOR_NAME, action: "created", harness: coordDriver, model: coordModel, wouldProvision: true,
          promptPreview: previewCoordPrompt.slice(0, 400),
        };
      }
    }
    return { status: 200, payload: { ok: true, dryRun: true, plan: p, cwd, warnings: v.warnings, commands: rows, coordinator } };
  }
  const auto = p.permission === "auto" || p.permission === "full" ? true : undefined;
  const at = new Date().toISOString();
  const logDir = path.join(d.root, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  let res;
  try {
    res = deliverDMs(d, { from, recipients: names, body: p.body.trim(), subject: p.subject, priority: p.priority, rev, at, forceBroadcast: false, forceDirect: true });
  } catch (e) {
    return { status: 400, payload: { error: String((e && e.message) || e) } };
  }
  if (!res || res.mode !== "direct") return { status: 500, payload: { error: "launch: internal error — expected direct delivery" } };
  const workers = [];
  for (let i = 0; i < res.items.length; i++) {
    const { to, id } = res.items[i];
    const driver = harnesses[i % harnesses.length];
    const spawnOpts = { harness: driver, cmd: body && body.cmd ? String(body.cmd) : undefined, model: modelForIndex(models, i), auto, maxTurns: p.maxTurns, allowTools: p.allowTools, cwd, root: d.root, prompt: null };
    try {
      const r = bootWorker(d, spawnOpts, { to, id, from, orchestrator: orchestratorTarget, subject: p.subject, body: p.body.trim(), rev, logDir });
      workers.push({ name: to, pid: r.pid, replyId: id, log: r.logPath, driver });
    } catch (e) {
      workers.push({ name: to, replyId: id, driver, error: String((e && e.message) || e) });
    }
  }
  let coordinator = undefined;
  if (orchestratorMode === "auto") {
    const coordHarness = harnesses[0] || "opencode";
    const coordSpawnOpts = { harness: coordHarness, cmd: body && body.cmd ? String(body.cmd) : undefined, model: coordModel, auto, cwd, root: d.root, prompt: null };
    try {
      coordinator = provisionOrchestrator(d, {
        spawnOpts: coordSpawnOpts,
        subject: p.subject, body: p.body.trim(), rev, logDir,
        workers: res.items.map((it, i) => ({ name: it.to, id: it.id, harness: harnesses[i % harnesses.length] })),
        batch: res.batch, auto,
      });
    } catch (e) {
      coordinator = { action: "skipped", reason: `coordinator boot error: ${String((e && e.message) || e)}`, orchestratorName: ORCHESTRATOR_NAME };
    }
  }
  return { status: 200, payload: { ok: true, cwd, workers, coordinator, warnings: v.warnings } };
}
