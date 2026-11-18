# crewbus Architecture Reference

> **Unified Documentation:** crewbus full interactive documentation with client-side search is available in [`documentation.html`](file:///C:/Users/Surface/Documents/crewbus/documentation.html).

This document serves as the canonical technical architectural reference for crewbus, consolidating control plane design, delivery mechanics, storage topology, multi-agent coordination, and high availability.

---

## 1. System Overview & Core Philosophy

crewbus is a **zero-dependency, local-first direct messaging bus** for mixed-harness AI coding agents (opencode, Claude Code, Codex, Antigravity, grok-build, Cursor, and Qwen Code).

- **No central server or daemon required:** On a single machine, coordination is mediated through a directory of atomic JSON files (`.crewbus/`).
- **Single primitive:** Send an immutable message directly to another agent (`crewbus send --to <recipient>`).
- **Separation of planes:**
  - **Control Plane (`orchestrator`):** Owns worker lifecycles, spawns, respawns, task pools, approvals, ACLs, and relay pairing.
  - **Data Plane (`worker`):** Autonomous execution, sends, reads, acks, artifacts, lessons, and member-scoped channel communication.

---

## 2. Control Plane & Relay Architecture

### 2.1 The Two-Role Model
Every board operates with a two-role security and operational hierarchy:
1. **`orchestrator` (Single instance per board):**
   - Automatically bootstrapped on spawn/launch as the agent named `orchestrator`.
   - Credentials saved at `logs/orchestrator.token`.
   - Authorized for control-plane RPCs: `launch`, `spawn`, `respawn`, `pool`, `spawn-kill`, `prune`, `group manage`, `pairing`.
2. **`worker` (Fleet instances):**
   - Every dynamically registered agent defaults to the `worker` role.
   - May send direct messages, read inboxes, post to authorized member channels (`grp-<group>`), record artifacts, and request approvals.
   - Blocked (fail-closed 403) from executing control-plane commands.

### 2.2 Frozen Contracts (`packages/contracts/`)
The control plane is governed by frozen version 1 contracts:
- `launch.json`: Request validation for `POST /api/launch` and `crewbus launch`.
- `harness.json`: Driver definitions, execution capabilities, and model flags.
- `pairing.json`: Per-device QR pairing URLs (`crewbus://pair?...#secret`) with fragment-only secrets.
- `board-caps.json`: Capability negotiation (`hlc`, `tombstones`, `channels`, `revoked`, `holds`, `standby`).

### 2.3 Shared Client Runtime (`packages/client-runtime/`)
Both the Web Dashboard (`crewbus web`) and Mobile Shell (`apps/mobile/`) build upon the shared client runtime:
- **Route Walk & Learned Routes:** Probes advertised relay endpoints, fallback routes, and direct LAN IPs.
- **Reconnect Supervisor:** Exponential backoff with jitter and health checks (`GET /healthz`).
- **Offline Mutation Outbox:** Queues actions offline; retries on explicit user action only.

---

## 3. Message Delivery Protocol & Long Runs

### 3.1 Delivery Semantics
- **Fire-once push, at-least-once reliability:** Harness hooks and background waiters trigger notifications; failed pushes fall back to pull polling.
- **Ordering:** Causal order tracked via timestamps and parent reply IDs (`--reply <id>`); cross-sender ordering is timestamp-based.
- **Deduplication:** Maintained via `delivered/<agent>/<msg-id>` marker files.

### 3.2 Poll Discipline for Long-Running Tasks
When workers run unattended long-duration tasks, they follow the poll ladder:
```sh
# Long-run poll discipline ladder
crewbus inbox --from <you> --unacked --digest
crewbus inbox --grep "<keyword>"
crewbus inbox --priority high
crewbus thread <brief-id>
crewbus gather <brief-id>
```
- Workers mark progress with `[checkpoint]` log tags.
- Asynchronous push notifications wake sleeping workers immediately without polling loops.

### 3.3 Session Compaction & Recovery
Harnesses periodically compact context windows during multi-hour runs. To prevent agents from losing their identity:
- `crewbus recover [--session <id>]` inspects registered board bindings, token-file hashes, and working directory markers to restore identity without creating duplicate accounts.
- `respawn` captures session IDs and refreshes process timestamps (`spawnedAt`), ensuring continuity across process restarts.

---

## 4. Workbenches, Groups & Channels

- **Task-Scoped Groups:** Workforces are partitioned into groups (`crewbus group create <name> --members a,b,c`).
- **Member-Scoped Channels (`grp-<name>`):** Workers may broadcast to channels corresponding to their group memberships. Orchestrators may broadcast globally.
- **Artifacts & Compound Memory:** Workers record structured deliverables and dependencies (`crewbus artifact record --name <key> --file <path>`).
- **Consolidator & Verifier:** Specialized patterns where an observer agent reconciles parallel outputs and verifies criteria before closing a task.

---

## 5. Storage Engine & Board Layout

Boards use standard filesystem hierarchies:
```
.crewbus/
├── board.json              # Board schema version and metadata
├── agents/                 # Registered agent records ({role, tokenHash, salt})
├── mail/                   # Immutable direct messages (<id>.json)
├── delivered/              # Deduplication delivery markers (<agent>/<id>)
├── cursors/                # Sync cursors per peer
├── groups/                 # Group memberships
├── channels/               # Channel message streams
├── artifacts/              # Task deliverables and dependency graphs
├── locks/                  # Named advisory locks with TTL
└── logs/
    ├── chain.jsonl         # Hash-chained CLI audit log
    ├── audit.jsonl         # Hash-chained relay audit log
    └── orchestrator.token  # Local orchestrator secret
```
Atomic file operations ensure cross-process safety without file locking overhead: writes stream to temporary files and atomically rename into place.

---

## 6. High Availability & Multi-Node Sync

- **Active / Passive Single Writer:** The Primary relay accepts all writes (`POST /api/spawn`, sync push). Standby relays replicate via pull (`--relay-interval 5s`).
- **Scale-Out Reads:** Standbys serve read-heavy queries (`GET /sync/manifest`, `/sync/file`, `/sync/wait`, `/healthz`) locally.
- **Failover:** Promoted manually via `crewbus relay promote --from orchestrator` or automatically via `--promote-on-miss <sec>` with split-brain safeguards.
- **Mesh Transport:** Relay communication is recommended over encrypted peer mesh networks (such as Tailscale) for seamless NAT traversal and authenticated TLS encryption.
