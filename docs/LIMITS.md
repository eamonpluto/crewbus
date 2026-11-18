# Scale Limits & Operational Budgets

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#scale-limits`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#scale-limits)
> - Canonical Markdown Reference: [`docs/COMPATIBILITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/COMPATIBILITY.md)

---

## Budgets & Ceilings

- **Broadcast fan-out:** `--to` supports up to 10,000 recipients.
- **Concurrent live workers:** `spawn` caps at 20 live boots per call; budget workers like compute processes.
- **Thread depth:** `MAX_FWD_DEPTH` is 16.
- **Rate limits:** 60 messages/minute per agent (override with `--no-rate-limit`).
