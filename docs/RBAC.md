# RBAC + per-board ACLs + group-scoped send permissions

Zero-dependency, file-local. Composes with tokens: `checkToken()` proves WHO
you are; `authorize()` decides WHAT your role may do. `authorize()` is a
SEPARATE function called AFTER `checkToken()` passes — never before, never
instead, never merged into token code.

## Roles

Agent records carry `role` in `{orchestrator, worker}`.

- **orchestrator** — the board's single control-plane identity. It owns the
  crew: spawn/respawn/kill, approvals, verification, groups, channels, ACLs,
  pairing, and every worker action. `spawn` (and `web`/`serve`) bootstrap it
  automatically as the agent named `orchestrator`, with its token at
  `logs/orchestrator.token`.
- **worker** — the data plane. Send/inbox/ack/redeliver/lock, artifacts,
  lessons, member-scoped channel posts, and reads. No control-plane actions.
- Every self-registering agent is a **worker**. Only
  `ensureOrchestrator`/`crewbus orchestrator init` mints the orchestrator.
- Records with any other or missing role are treated as **worker** (an
  unknown role can never gain control-plane powers).

## Permission matrix

| action | orchestrator | worker |
|---|---|---|
| send / inbox / ack / redeliver / lock (scoped) | yes | yes |
| spawn / respawn / pool / spawn-kill / group manage / result record / race close | yes | NO |
| channel post | yes (anywhere) | members-only: the channel's own group (`grp-<group>` where the caller is a member) |
| launch (same RBAC + audit as spawn) | yes | NO |
| relay pair issue / devices / revoke (`pairing`) | yes | NO |
| prune / acl set / role-grant / offboard / group restrict / serve `--allow-remote-spawn` / import / snapshot / quota / legal hold | yes | NO |
| reads (gather / thread / log / channel tail / group show / result show / spawn-status / agents / hold status) | yes | yes |

Notes:

- Reads not listed above default-allow (fail-closed only for writes).
- `spawn-kill` is orchestrator-only; the orchestrator owns every crew.
- `lock release` still requires ownership even when acquire is allowed.
- MCP twins: `dm_send`→`send`, `dm_inbox`→`inbox`, `dm_ack`→`ack`,
  `dm_channel_post`→`channel-post` (member-scoped like the CLI),
  `dm_gather`/`dm_channel_tail` are identity-less reads.
- Relay: `POST /api/spawn`→`spawn`, `POST /api/launch`→`spawn`,
  `POST /api/kill`→`spawn-kill` (403 on denial); pair endpoints→`pairing`.
  Remote control-plane actions run as the relay board's orchestrator; the
  relay secret or a device credential with `launch:spawn` is the auth
  boundary.
- Device-scope layer: transport credential scopes (`requireScope` in
  `bin/lib/relay.js`) compose UNDER role checks — a narrowed device can only
  further restrict, never widen, what the agent token's role allows.
- `prune` and `group create/add/remove` keep the bare operator path (no
  `--from`) open; with `--from` the caller is token-checked and authorized.
  `serve --allow-remote-spawn` with `--from` requires the orchestrator.

## Per-board ACLs

`board.json` gains `acl: {defaultRole, frozen?}`.

- `acl set --from orchestrator [--default-role worker] [--freeze|--unfreeze]`
  (orchestrator-only). `acl show [--json]` is read-only.
- Every new registration is a worker; `defaultRole` stays `worker`.
- Frozen boards refuse new registrations (including first-send auto-mint),
  except by orchestrator grant (`register --from orchestrator --for <new>`).

## Group-scoped send permissions

- `group restrict <name> --from orchestrator` sets `restricted: true`
  (`group unrestrict` clears it). Orchestrator-only. The flag survives
  member edits.
- Sends with `--to-group` (or `to_group` / relay `to_group`) to a restricted
  group are refused unless the caller is the orchestrator or a group member.
- Pattern: curate a private crew (`group create elite --add a,b`), then
  `group restrict elite --from orchestrator`; outsiders get a loud refusal,
  members + the orchestrator keep working.

## Bootstrap and migration

- Fresh boards: `spawn`, `web`, or `serve` ensure the orchestrator; or run
  `crewbus orchestrator init` explicitly (prints the token once).
- Existing boards with roles outside `{orchestrator, worker}` are treated as
  worker-only; mint the orchestrator with `crewbus orchestrator init`.
- `crewbus orchestrator show` reports the identity, live pid, and token path
  without booting anything.