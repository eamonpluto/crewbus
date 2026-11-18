# Groups & Member-Scoped Channels

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#layout`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#layout)
> - Canonical Markdown Reference: [`docs/ARCHITECTURE.md`](file:///C:/Users/Surface/Documents/crewbus/docs/ARCHITECTURE.md)

---

## Groups & Channels

- Group creation: `crewbus group create <name> --members a,b,c`.
- Scoped channels: `grp-<name>` channels permit postings only from members of that group.
- Context isolation: Task-scoped briefs include relevant groups only, preventing cross-task leaks.
