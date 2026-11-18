# Shared Responsibility Model

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#threat-model`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#threat-model)
> - Canonical Markdown Reference: [`docs/SECURITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/SECURITY.md)

---

## Boundary of Responsibility

- **crewbus provides:** Local-first protocol messaging, token verification, tamper-evident audit logging, and RBAC enforcement.
- **User provides:** OS user account isolation, filesystem permissions, container sandboxes for untrusted agent workloads, and transport security (e.g. Tailscale / WireGuard).
