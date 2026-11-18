# Orchestrator Role & Responsibilities

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#control-plane`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#control-plane)
> - Canonical Markdown Reference: [`docs/ARCHITECTURE.md`](file:///C:/Users/Surface/Documents/crewbus/docs/ARCHITECTURE.md)

---

## Orchestrator Identity

- The single control-plane agent on each board.
- Automatically provisioned on spawn/launch as `orchestrator`.
- Governs worker lifecycles, approvals, pairing, and task pooling.
