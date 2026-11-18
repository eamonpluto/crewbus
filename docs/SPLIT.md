# Codebase Architecture & Modular Split

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#what`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#what)
> - Canonical Markdown Reference: [`docs/ARCHITECTURE.md`](file:///C:/Users/Surface/Documents/crewbus/docs/ARCHITECTURE.md)

---

## Modular Decomposition

- Monolithic core decomposed into decoupled modules under `bin/lib/`:
  - `spawn.js`, `mail.js`, `sync.js`, `relay.js`, `web.js`, `kidproc.js`, `export.js`.
- Zero local circular dependencies; pure acyclic dependency graph.
