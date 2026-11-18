# Long-Running Tasks Playbook

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#delivery`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#delivery)
> - Canonical Markdown Reference: [`docs/ARCHITECTURE.md`](file:///C:/Users/Surface/Documents/crewbus/docs/ARCHITECTURE.md)

---

## Long Runs (Multi-Day Tasks)

- Rotate workers in waves; sessions are a cache, the board is the database.
- Use `--checkpoint` to preserve intermediate progress before risky actions.
- Poll digest-first: `crewbus inbox --from <you> --unacked --digest`.
- Re-brief replacement workers on surviving threads.
