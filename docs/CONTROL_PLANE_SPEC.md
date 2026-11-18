# Control Plane Specification

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#control-plane`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#control-plane)
> - Canonical Markdown Reference: [`docs/ARCHITECTURE.md`](file:///C:/Users/Surface/Documents/crewbus/docs/ARCHITECTURE.md)

---

## Control Plane Architecture

- Governed by frozen v1 contracts in `packages/contracts/`:
  - `launch.json` (Launch requests and permission mapping)
  - `harness.json` (7 AI harness drivers and CLI flags)
  - `pairing.json` (QR and relay pairing with fragment secrets)
  - `board-caps.json` (Feature negotiation and capability degradation)
- Implemented via `crewbus launch`, `crewbus harnesses detect`, `crewbus web`, and `packages/client-runtime/`.
