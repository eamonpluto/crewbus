# Human-in-the-Loop Approvals Protocol

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#approvals`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#approvals)
> - Canonical Markdown Reference: [`docs/SECURITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/SECURITY.md)

---

## Blocked-Worker Convention

Workers cannot self-approve destructive, irreversible, or out-of-scope actions. When blocked, a worker asks the board orchestrator via DM and blocks on the verdict.

### Request Schema (worker -> orchestrator)
- Sent with `--priority high` to `orchestrator`, threaded via `--reply <brief-id>`.
- Subject: `approval: <short action>`
- Body keys (each on its own line):
  - `command:` — exact proposed command
  - `cwd:` — working directory
  - `why:` — why needed
  - `tried-instead:` — safer alternative tried
  - `timeout: 300s` — fail-closed timeout window

### Response Schema (orchestrator -> worker)
- DM reply with `replyTo` set to request id.
- Body is exactly one of:
  - `approved`
  - `denied: <reason, max 500 chars>`
- **Fail-closed silence:** `crewbus listen --timeout 300000`. Silence past the timeout is treated as `denied: timeout`. Workers never proceed without explicit approval.
