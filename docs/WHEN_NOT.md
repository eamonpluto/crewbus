# When NOT to Use crewbus

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#when-not-to-use`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#when-not-to-use)
> - Canonical Markdown Reference: [`docs/COMPATIBILITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/COMPATIBILITY.md)

---

## Anti-Patterns

- Parent-to-subagent workflows in a single harness (native subagents are simpler).
- Thousands of concurrent live OS processes (use distributed orchestrators).
- Strict transactional total-order message queues.
- Untrusted code execution on a shared board directory without container isolation.
