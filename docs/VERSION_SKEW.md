# Version Skew & Backwards Compatibility

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#changes`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#changes)
> - Canonical Markdown Reference: [`docs/COMPATIBILITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/COMPATIBILITY.md)

---

## Fleet Compatibility

- Capability negotiation via `packages/contracts/board-caps.json`.
- Missing capabilities degrade gracefully with readable CLI warnings, never 500 crashes.
- Legacy token hashing migration and backward-compatible agent roles.
