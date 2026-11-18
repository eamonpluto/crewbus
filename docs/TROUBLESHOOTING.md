# Troubleshooting Matrix & Common Gotchas

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#troubleshooting`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#troubleshooting)
> - Canonical Markdown Reference: [`docs/COMPATIBILITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/COMPATIBILITY.md)

---

## Diagnostic Baseline

- Run `crewbus doctor` first.
- Split boards: Compare `[board <path>]` echoes; set `CREWBUS_DIR`.
- Lost token: Re-read mint output or rotate via `crewbus token rotate`.
- Post-compaction identity loss: Run `crewbus recover [--session <id>]`.
- PowerShell quoting: Always quote comma lists: `--add "a,b,c"`.
- Pairing socket timeout: Mobile shell v0.6.4+ retries automatically.
