# Orchestrator & Worker Lane Model

Crewbus separates **spawning** from **leading** with exactly two roles.
`spawn` provisions the board's single **orchestrator** and boots the workers;
the orchestrator owns the crew, while workers collaborate peer-to-peer.

- **Workers** communicate directly, self-organize strategy, and write
  findings to shared ambient memory (the board / Workbench).
- The **orchestrator** monitors health, chases failures/timeouts, fail-closes
  approvals, verifies claims against actual artifacts, and posts the aggregate.
- The **user/operator** runs `crewbus spawn` with a brief and a worker count.
  There is no separate `boss`, `admin`, `lead`, or `auditor` identity.

---

## 1. The Lane Model

| Lane | Actor | Authority & Responsibilities |
|---|---|---|
| **Orchestrator** | Board control plane (`orchestrator`) | • Sets the mission from the user's brief.<br>• Observes health, TTLs, respawns (`spawn-status --all`, `respawn`).<br>• Decides irreversible/high-risk approvals (`fail-closed`).<br>• Audits worker claims against files/logs before aggregating.<br>• Posts the aggregate outcome on the board.<br>• *Never* does workers' implementation tasks. |
| **Workers** | Worker agents (`worker-1`, `worker-2`, ...) | • Own task strategy, execution, and local decisions.<br>• Direct peer-to-peer DMs for cooperation and rescue calls.<br>• Post lessons and artifacts directly to the board Workbench.<br>• Checkpoint progress along threads.<br>• Consult groups first; escalate to the orchestrator only for scope/approvals. |

---

## 2. CLI: brief + count

```sh
# Default: provisions or reuses the board orchestrator
crewbus spawn "Implement feature X" --count 3 --harness opencode
```

There is no `--from` and no `--lead` flag. `spawn` runs as the board
orchestrator; `--body "..."` and a positional brief are equivalent.

### Architecture

- Auto-provisions or reuses the board's single `orchestrator` lane.
- Worker briefs pin reply targets and approval requests to `--to orchestrator`.
- The orchestrator runs persistently to monitor health and approvals.
- Crewbus requires a coding harness (`opencode`, `claude`, `codex`, `grok`,
  `antigravity`, `cursor`, `qwen`).

---

## 3. Provisioning & Collision Rules

1. **Single identity**
   - `ensureOrchestrator` mints the `orchestrator` identity with
     `role: "orchestrator"` when missing.
   - The token is saved to `logs/orchestrator.token` (token-file convention).
   - `crewbus orchestrator init` bootstraps explicitly; `orchestrator show`
     reports the identity read-only.

2. **Reuse standing orchestrators**
   - If a live, non-stale coordinator runs on the `orchestrator` lane,
     subsequent `spawn` bursts reuse it rather than duplicating it.
   - Workers from new bursts are transferred to the orchestrator
     (`spawnedBy: "orchestrator"`), preserving own-crew permissions for
     health tracking and `spawn-kill`.

3. **Offboarded lane**
   - If the `orchestrator` lane has been marked `offboarded: true`,
     auto-provisioning refuses silently to resurrect a deliberate teardown.
     Re-onboard it explicitly before spawning again.

4. **Revive (`crewbus spawn --count 0`)**
   - Boots NOTHING except the orchestrator lane: zero worker boots, zero DMs.
   - The mission text you pass becomes the orchestrator's reminder of what the
     crew was working on (worker threads and scope live on the board).
   - Worker selectors (`--to`/`--to-file`/`--to-group`) are refused.
   - A standing orchestrator is reused, never duplicated.

---

## 4. Prompt Engineering

- **Workers (`buildSpawnPrompt`)**:
  - Direct completion summaries, checkpoints, and approval requests to
    `--to orchestrator`.
  - Tell the worker that the orchestrator owns the crew.
  - Reinforce peer-first habits: consult groups before escalating.
- **Orchestrator (`buildOrchestratorPrompt`)**:
  - Injected with the verbatim user brief.
  - Lists worker brief IDs for threading and reply tracking.
  - Enforces polling discipline (`listen` / `inbox --digest`), fail-closed
    approval timeouts, and maximum 2 respawn attempts per lane before posting
    the stall on the board.