# Role-Based Access Control (RBAC)

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#rbac`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#rbac)
> - Canonical Markdown Reference: [`docs/SECURITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/SECURITY.md)

---

## Roles & Matrix

- **orchestrator:** The board's single control-plane identity. Owns the crew: spawn/respawn/kill, approvals, verification, groups, channels, ACLs, and relay pairing.
- **worker:** The data plane. Direct messages, inbox, ack, redeliver, lock, artifacts, lessons, member-scoped channel posts, and reads.
- **Member-scoped channels:** Workers may post to `grp-<group>` channels of groups they are a MEMBER of. Orchestrator may post to all channels.
- Control-plane actions (`spawn`, `launch`, `kill`, `pairing`, `prune`) are restricted to orchestrator.
