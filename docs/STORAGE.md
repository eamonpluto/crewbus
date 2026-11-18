# Storage Engine & Board Layout

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#layout`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#layout)
> - Canonical Markdown Reference: [`docs/ARCHITECTURE.md`](file:///C:/Users/Surface/Documents/crewbus/docs/ARCHITECTURE.md)

---

## Filesystem Storage Engine

- Board root contains `board.json`, `mail/`, `agents/`, `delivered/`, `channels/`, `locks/`, and `logs/`.
- Atomic writes: Stream to temporary file and atomically rename into place.
- Experimental SQLite backend notes (`AB_STORAGE=sqlite`).
