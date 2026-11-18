# Consolidator Pattern

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#workflow`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#workflow)
> - Canonical Markdown Reference: [`docs/ARCHITECTURE.md`](file:///C:/Users/Surface/Documents/crewbus/docs/ARCHITECTURE.md)

---

## Consolidator Pattern

- An observer pattern where a dedicated worker synthesizes and reconciles work from multiple parallel task workers.
- Gathers thread deliverables using `crewbus gather <brief-id>`.
