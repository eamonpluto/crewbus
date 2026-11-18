# High Availability & Relay Replication

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#ha-sync`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#ha-sync)
> - Canonical Markdown Reference: [`docs/ARCHITECTURE.md`](file:///C:/Users/Surface/Documents/crewbus/docs/ARCHITECTURE.md)

---

## Active / Passive Relay Topology

- Single writer (Primary relay) handles writes (`POST /api/spawn`, sync push).
- Standby relays replicate from primary via pull (`--relay-interval 5s`).
- Standbys serve read endpoints (`GET /sync/manifest`, `/sync/file`, `/healthz`) locally; writes return 503 with `X-Relay-Role: standby`.
- Promotion: `crewbus relay promote --from orchestrator`. Split-brain prevention: ensure old primary stays down.
- Recommended transport: Tailscale / WireGuard private mesh.
