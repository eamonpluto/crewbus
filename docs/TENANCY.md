# Multi-Tenancy & Board Partitioning

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#trust`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#trust)
> - Canonical Markdown Reference: [`docs/ARCHITECTURE.md`](file:///C:/Users/Surface/Documents/crewbus/docs/ARCHITECTURE.md)

---

## Tenancy Boundaries

- One board directory per tenant / trust zone.
- Zero cross-board queries; directory paths strictly enforce data segregation.
