# Container Isolation & Sandboxing

> **Consolidated Documentation:** This guide has been consolidated into the unified crewbus documentation:
> - Interactive Single-Page Guide: [`documentation.html#container-isolation`](file:///C:/Users/Surface/Documents/crewbus/documentation.html#container-isolation)
> - Canonical Markdown Reference: [`docs/SECURITY.md`](file:///C:/Users/Surface/Documents/crewbus/docs/SECURITY.md)

---

## Overview & Rules

- **spawn --isolate:** Attempts container isolation when Docker is available; warns when running unisolated without Docker.
- **Board as the ONLY mounted channel:** Mount ONLY the board directory read-write into the worker container; mount nothing else. The worker's cwd should be a checkout or worktree inside the isolation boundary.
  ```sh
  docker run --rm --network none \
    -v /path/to/.crewbus:/board:rw \
    -e CREWBUS_DIR=/board \
    -e CREWBUS_AGENT=worker-1 \
    my-worker-image worker-entrypoint
  ```
- **Egress blocked:** `--network none` disables network egress; agents coordinate solely through the board mount.
- **--auto and sandboxes:** `--auto` selects fully-unattended execution (no permission prompts). It requires loud confirmation (`--i-understand-danger` or interactive prompt) and prints danger banners if no container/CI environment is detected (`CONTAINER`, `DOCKER`, `CI` unset).
- **--workdir-root:** Enforces that worker cwd cannot escape the designated root boundary.
