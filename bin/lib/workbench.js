// bin/lib/workbench.js — Artifacts + lessons: the compound-memory layer.
// Purpose: make worker output load-bearing for teammates instead of
// DM-status-only (feed-forward, the Minecraft-paper lever set):
//   artifacts = board objects with depends-on edges; adoption + verification
//   are recorded ON the object, so a later crew can see what was reused and
//   what held up (artifact publish|list|show|adopt|verify).
//   lessons = scoped one-liners auto-injected into later spawn briefs
//   (lesson post|list), so a lesson learned once is paid forward without
//   anyone re-deriving it.
// Zero-dependency Node 18+ ESM. Side-effect-free at top level. Storage:
//   artifacts/<id>.json  {id, from, at, path, summary?, deps[], adoptedBy[], verifiedBy[]}
//   lessons/<id>.json    {id, from, scope, text, at}
import fs from "node:fs";
import path from "node:path";
import { fail, readJson, writeJson, listJson, newId } from "./store.js";

// Artifact ids minted via newId("art"): art-<YYMMDD>-<HHMMSS>-<8hex>.
export const ARTIFACT_ID_RE = /\bart-[0-9]{6}-[0-9]{6}-[0-9a-f]{8}\b/g;

export function artifactPath(d, id) {
  return path.join(d.artifacts, `${id}.json`);
}

export function readArtifactById(d, id) {
  if (!id) return null;
  try {
    const a = readJson(artifactPath(d, id));
    return a && a.id === id ? a : null;
  } catch {
    return null;
  }
}

// Newest first (board reads answer "what exists lately", not history).
export function listArtifacts(d, { limit } = {}) {
  const items = listJson(d.artifacts)
    .map((e) => e && e.data)
    .filter((a) => a && a.id && a.path);
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(b.id).localeCompare(String(a.id)));
  return typeof limit === "number" ? items.slice(0, Math.max(0, limit)) : items;
}

export function cleanArtifactId(raw, flag) {
  const f = flag || "--id";
  if (raw === undefined || raw === null || String(raw).trim() === "") fail(`missing ${f} <artifact-id>`);
  const c = String(raw).trim().toLowerCase();
  if (!/^art-[0-9]{6}-[0-9]{6}-[0-9a-f]{8}$/.test(c)) fail(`invalid ${f} "${raw}" (want an art-<id> from artifact list)`);
  return c;
}

// Lesson scopes: freeform short names like groups; missing reads as
// "global" so one-off lessons still reach every later brief.
export function cleanLessonScope(raw, flag) {
  const f = flag || "--scope";
  if (raw === undefined || raw === null || String(raw).trim() === "") return "global";
  const c = String(raw).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 60);
  if (!c) fail(`invalid ${f} "${raw}"`);
  return c;
}

export function parseArtifactDeps(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return [];
  return String(raw).split(",").map((s) => cleanArtifactId(s, "--deps")).filter((x, i, a) => a.indexOf(x) === i);
}

export function publishArtifact(d, { from, ref, summary, deps, at }) {
  const cleanRef = String(ref === undefined || ref === null ? "" : ref).trim();
  if (!cleanRef) fail('missing --path <path-or-url> (where the artifact lives; reference, never inline secrets)');
  const doc = {
    id: newId("art"),
    from,
    at,
    path: cleanRef.slice(0, 500),
    summary: String(summary || "").trim().slice(0, 500) || undefined,
    deps: Array.isArray(deps) ? deps : [],
    adoptedBy: [],
    verifiedBy: [],
  };
  for (const dep of doc.deps) {
    if (!readArtifactById(d, dep)) fail(`dep ${dep} not found on this board (publish the dependency first, or drop it)`);
  }
  writeJson(artifactPath(d, doc.id), doc);
  return doc;
}

export function adoptArtifact(d, { id, from, note, at }) {
  const a = readArtifactById(d, id);
  if (!a) fail(`unknown artifact ${id} (artifact list to see what's on the board)`);
  if (!a.adoptedBy.some((e) => e.by === from)) {
    a.adoptedBy.push({ by: from, at, note: String(note || "").trim().slice(0, 200) || undefined });
    writeJson(artifactPath(d, id), a);
  }
  return a;
}

export function verifyArtifact(d, { id, from, note, at }) {
  const a = readArtifactById(d, id);
  if (!a) fail(`unknown artifact ${id} (artifact list to see what's on the board)`);
  if (!a.verifiedBy.some((e) => e.by === from)) {
    a.verifiedBy.push({ by: from, at, note: String(note || "").trim().slice(0, 200) || undefined });
    writeJson(artifactPath(d, id), a);
  }
  return a;
}

export function postLesson(d, { from, scope, text, at }) {
  const t = String(text === undefined || text === null ? "" : text).trim();
  if (!t) fail('missing --text "..." (one or two sentences: what happened + what to do differently)');
  const doc = { id: newId("les"), from, scope: cleanLessonScope(scope), text: t.slice(0, 800), at };
  writeJson(path.join(d.lessons, `${doc.id}.json`), doc);
  return doc;
}

// Oldest first (a lesson list is a history read, unlike artifacts).
export function listLessons(d, { scope } = {}) {
  let items = listJson(d.lessons)
    .map((e) => e && e.data)
    .filter((l) => l && l.id && l.text);
  items.sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)));
  if (scope !== undefined) items = items.filter((l) => l.scope === cleanLessonScope(scope));
  return items;
}

// Brief injection selection: lessons whose scope matches one of this
// spawn's groups (or global), newest last-N reversed so the freshest
// lessons land first in the brief. Cap keeps prompts bounded.
export function selectLessons(d, { scopes = [], limit = 8 } = {}) {
  const scopeSet = new Set(["global", ...(scopes || []).map(String)]);
  const picked = listLessons(d).filter((l) => scopeSet.has(l.scope));
  return picked.slice(-Math.max(0, limit)).reverse();
}

// Pure renderer: the Workbench: block for spawn briefs. Returns bullet
// lines (no header); caller joins under a header. Empty board -> [].
export function renderWorkbenchBlock({ lessons, artifacts, me }) {
  const les = (lessons || []).slice(0, 8);
  const arts = (artifacts || []).slice(0, 6);
  const out = [];
  for (const l of les) out.push(`- lesson [${l.scope}] ${l.text} (from ${l.from})`);
  for (const a of arts) {
    const state = [];
    if (a.adoptedBy && a.adoptedBy.length) state.push(`adopted x${a.adoptedBy.length}`);
    if (a.verifiedBy && a.verifiedBy.length) state.push("verified");
    out.push(`- artifact ${a.id} ${a.path}${a.summary ? ` — ${a.summary}` : ""}${state.length ? ` (${state.join(", ")})` : ""}`);
  }
  if (out.length === 0) return out;
  out.push(`(verify before reuse; publish yours: artifact publish --path <p> [--deps <id,id>] / lesson post --scope <s> --text "..."; reuse a piece: artifact adopt|verify --id <id> --from ${String(me || "you")})`);
  return out;
}

// Gather metrics (pure given a lookup fn): scan transcript messages for
// artifact references (the m.artifact field + art- ids in bodies), then
// score feed-forward: an edge is a message whose sender is NOT the
// artifact's producer — someone downstream actually consumed upstream
// output on the board itself.
export function workbenchMetrics(items, lookup) {
  const seenEdges = new Set();
  const refs = new Map();
  const producers = new Set();
  let feedForward = 0;
  let adopted = 0;
  let verified = 0;
  for (const m of items || []) {
    if (!m) continue;
    const text = `${m.artifact || ""} ${m.body || ""}`;
    const ids = new Set(String(text).match(ARTIFACT_ID_RE) || []);
    for (const id of ids) {
      const a = lookup(id);
      if (!a) continue;
      // Adoption/verification are per-artifact facts; count each artifact
      // once no matter how many transcript messages cite it.
      if (!refs.has(id)) {
        refs.set(id, a);
        producers.add(a.from);
        if (a.adoptedBy && a.adoptedBy.length) adopted++;
        if (a.verifiedBy && a.verifiedBy.length) verified++;
      }
      if (m.from && m.from !== a.from) {
        const key = `${m.id}|${id}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          feedForward++;
        }
      }
    }
  }
  return { artifactRefs: refs.size, producers: producers.size, feedForward, adopted, verified };
}
