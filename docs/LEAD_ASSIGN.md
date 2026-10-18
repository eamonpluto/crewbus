# Auto-assigned Lead & Observer Lane Model

Crewbus separates **spawning** from **leading**. Instead of the interactive spawner remaining the central router for all worker communications (sub-agent hub pattern), Crewbus defaults to an autonomous **lead** lane provisioned on the board, while workers collaborate peer-to-peer.

This architecture is modeled after decentralized multi-agent coordination patterns (e.g. Minecraft multi-agent peer collaboration):
- **Peers** communicate directly, self-organize strategy, and write findings to shared ambient memory (the board / Workbench).
- An **Observer** (`lead`) monitors health, chases failures/timeouts, fail-closes approvals, and verifies claims against actual artifacts.
- The **Boss** sets the objective and monitors milestones asynchronously without micromanaging execution.

---

## 1. The Lane Model

| Lane | Actor | Authority & Responsibilities |
|---|---|---|
| **Boss** | User / Calling Session | • Sets the objective and mission parameters.<br>• Reads progress via dashboard, status commands, or milestone DMs.<br>• Resolves out-of-scope mission changes or irreconcilable disputes.<br>• Never routes routine peer messages. |
| **Lead** | Autonomous Board Coordinator (`lead`) | • **Observer Role**: Environment repairs, TTL chasing, respawn health (`spawn-status --all`, `respawn`).<br>• **Approvals**: Decides on irreversible/high-risk actions (`fail-closed`).<br>• **Verification**: Audits worker claims against actual files/logs before aggregating.<br>• **Milestones**: Relays aggregate outcomes back to the boss.<br>• *Never* settles peer strategy disputes or does workers' implementation tasks. |
| **Peers** | Worker Agents (`sec-1`, `sec-2`, ...) | • Own task strategy, execution, and local decisions.<br>• Direct peer-to-peer DMs for targeted cooperation and rescue calls.<br>• Post lessons and artifacts directly to the board Workbench.<br>• Checkpoint progress along threads.<br>• Consult groups first; escalate to lead only for scope/approvals. |

---

## 2. CLI Control: `--lead auto|board|none`

When spawning workers with `crewbus spawn`:

```sh
# Default: auto-assigns lead if a coding harness is present
crewbus spawn --from boss --count 3 --harness opencode --body "Implement feature X"

# Explicit board coordinator
crewbus spawn --from boss --count 3 --harness opencode --lead board --body "Implement feature X"

# Legacy star topology (replies pin directly to boss)
crewbus spawn --from boss --count 3 --harness generic --lead none --body "Run test suite"
```

### Modes:
- **`auto` (default)**:
  - If any coding harness (`opencode`, `claude`, `codex`, `grok`, `antigravity`, `cursor`) is used: selects `board` mode.
  - If all workers use `generic` harnesses (shell commands without an LLM harness): falls back to `none` mode.
- **`board`**:
  - Auto-provisions or reuses the board's standing `lead` lane.
  - Workers' brief prompts pin reply targets and approval requests to `--to lead`.
  - Requires at least one coding harness to run the coordinator prompt; fails loudly if attempted with pure `generic` harnesses.
- **`none`**:
  - Legacy star topology: replies and approvals pin directly to the spawner (`--to <from>`).
  - No autonomous coordinator is provisioned.

---

## 3. Provisioning & Collision Rules

1. **First-Claim-Wins**:
   - On a fresh board without a `lead` agent, `provisionAutoLead` mints the `lead` identity with `role: "lead"`.
   - The token is saved to `logs/lead.token` according to the token-file convention.
2. **Reuse Standing Coordinators**:
   - If an active coordinator is already running (live PID on the `lead` lane), subsequent `spawn` bursts reuse the standing coordinator rather than duplicating it.
   - Workers from new bursts are transferred to the lead lane (`spawnedBy: "lead"`), preserving own-crew RBAC permissions for health tracking and `spawn-kill`.
3. **Offboarded Safety**:
   - If the `lead` lane has been marked `offboarded: true` (deliberate teardown), auto-provisioning is skipped with a loud warning.
4. **Boss Detachment**:
   - If `from === "lead"`, auto-provisioning skips into self-bootstrap mode to prevent recursion.

---

## 4. Prompt Engineering

- **Workers (`buildSpawnPrompt`)**:
  - Directs completion summaries, checkpoints, and approval requests to `--to lead`.
  - Informs the worker that the spawner stepped back to boss and reads progress via the lead.
  - Reinforces peer-first habits: consult groups before escalating to the lead.
- **Coordinator (`buildCoordinatorPrompt`)**:
  - Injected with the verbatim mission text from the boss.
  - Lists worker brief IDs for easy threading and reply tracking.
  - Enforces polling discipline (`listen` / `inbox --digest`), fail-closed approval timeouts, and maximum 2 respawn attempts per lane before escalating stalls to the boss.
