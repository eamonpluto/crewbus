# Audit Export & Legal Holds

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#tamper-evident`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#tamper-evident)
> - Canonical Markdown Reference: [`docs/SECURITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/SECURITY.md)

---

## Tamper-Evident Logging

- Every privileged CLI op appends to `logs/chain.jsonl`; relay operations append to `logs/audit.jsonl`.
- Versioned `v:1` envelopes contain `seq`, `at`, `actor`, `role`, `action`, `target`, `board`, `result`, `prevHash`, `sig`, and `hash`.
- Off-box verification: `crewbus log --verify` scans from genesis to tip, verifying SHA-256 chain continuity and HMAC-SHA256 signatures.
