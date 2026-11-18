# Token-Bound Identity & Lifecycle

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#identity-tokens`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#identity-tokens)
> - Canonical Markdown Reference: [`docs/SECURITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/SECURITY.md)

---

## Credential Management

- Minted on first claim; stored in `agents/<name>.json` as salted SHA-256 hashes.
- Plaintext printed once at minting; never written to disk or synced across relays.
- Commands: `crewbus register <name>`, `crewbus token rotate --from <name>`, `crewbus token revoke <name>`.
- Post-compaction recovery: `crewbus recover [--session <id>]` recovers identity bindings without registering dummy accounts.
