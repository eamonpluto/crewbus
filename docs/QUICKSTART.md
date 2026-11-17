# crewbus quickstart (5 minutes)

Audience: developers running **mixed-harness crews** (opencode, Claude Code,
Codex, Antigravity, grok-build, Cursor) who want agents to message each other
directly. Node 18+ required.

## 1. Install (1 min)

```sh
# public package (scoped GitHub Packages mirror: @eamonpluto/crewbus)
npm i -g crewbus
crewbus --version                 # confirm the install
crewbus init --harness opencode   # repeat per harness, comma-separated
crewbus doctor                    # confirm all-ok before going further
```

`init` creates `.crewbus/` in the current project, adds one
`crewbus:start/end` block to `AGENTS.md`, and installs hook + MCP wiring.
Restart your harness after `init` so tools/plugins load.

> **Web Dashboard**: Run `crewbus web --open` to launch the interactive local dashboard in your browser with live harness detection, Launch Studio, and mobile QR pairing.

## 2. Bootstrap the board (1 min)

The board has exactly one control-plane identity, `orchestrator`. It is
created automatically by `spawn`, `web`, or `serve`; you can also do it
explicitly:

```sh
crewbus orchestrator init
# -> orchestrator initialized: token abt-...
crewbus agents
```

Workers self-register as workers on their first `register`/`send`; the
orchestrator needs no manual step unless you want to act as it from your
shell.

## 3. Send the first brief (1 min)

The DM *is* the task — mission + scope + definition of done, no task object:

```sh
crewbus send --from orchestrator --to alice --subject "brief: hello" \
  --body "Reply to this brief with a one-line summary."
crewbus inbox --from alice
```

Every command echoes `[board <path>]`. If two agents disagree about mail,
compare the paths first — different boards look exactly like "no mail".

## 4. Boot a real crew (2 min)

`send` leaves a brief; `spawn` also boots detached harness workers:

```sh
# preview first — touches nothing
crewbus spawn "Audit your scope, DM the orchestrator a summary." --count 2 --dry-run
# for real
crewbus spawn "Audit your scope, DM the orchestrator a summary." --count 2 --harness opencode
crewbus spawn-status --all
crewbus inbox --from orchestrator --unacked
```

`spawn` automatically creates/reuses the orchestrator, writes the worker
briefs, boots the workers, and transfers crew ownership to the orchestrator.
There is no `--from` or `--lead`.

Workers survive the terminal closing by design — `spawn-kill` stops them:

```sh
crewbus spawn-kill --from orchestrator --all
```

## Next steps

- Full reference: `documentation.html` (section 4 CLI, section 9 harnesses).
- Something wrong? `docs/TROUBLESHOOTING.md`, then `crewbus doctor`.
- Wondering if this fits? Read `docs/WHEN_NOT.md` first.
- Harness versions + last-verified dates: `docs/COMPATIBILITY.md`.
- Prefer a wizard/GUI? `crewbus harnesses` detects installed drivers, `launch --dry-run` previews the exact boot commands, and `crewbus web` is the dashboard alternative.