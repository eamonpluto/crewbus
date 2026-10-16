// CrewBus M4 desktop supervisor (Tauri).
// Compiles in CI (release-desktop.yml); validate behavior on a toolchain
// machine with `npm run tauri build` + installer smoke test.
//
// Job: own the loopback sidecar lifecycle. The sidecar is stock zero-dep
// `bin/crewbus.js serve --port 0` on 127.0.0.1, run by the BUNDLED node
// sidecar (`externalBin binaries/node`, staged by scripts/fetch-node.mjs)
// with a system-PATH `node` fallback for dev machines. `--port 0` means a
// RANDOM port, so the actual `http://127.0.0.1:PORT` is LEARNED by scanning
// sidecar stdout for the first loopback URL, then emitted to the shell as a
// `dashboard-ready` event. The shell (`src/main.js`) points its dashboard
// <iframe> at that URL — the dashboard UI is reused, never duplicated.
//
// Remote-only toggle: `stop_sidecar` kills the child process and emits
// `dashboard-stopped`. Stopping the sidecar deletes NO board state — `serve`
// only reads/writes live under `.crewbus/`; the board directory is untouched.
// (Spec CONTROL_PLANE_SPEC §4.3: remote-only mode stops the sidecar WITHOUT
// deleting board state.)
//
// Pairing window: the `pair` webview (see tauri.conf.json, pair.html) renders
// the one-time `crewbus://pair?...#<abp-…>` QR from `serve --pair-qrcode`
// output. Fragment-secret hygiene: the full URL lives in memory only, is
// never logged/persisted, and secrets travel in #fragment, never query
// (packages/contracts/pairing.json, client-runtime parsePairUrl).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{ShellExt, process::{CommandChild, CommandEvent}};

struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    url: Mutex<Option<String>>,
    /// Last terminal status: set once the supervisor task finishes or fails.
    /// Lets a late frontend (missed the one-shot event) catch up on demand.
    status: Mutex<Option<String>>,
    /// Human detail for the status above (port-learned URL, or error text).
    detail: Mutex<Option<String>>,
    /// Board dir the running sidecar was booted against. None until the
    /// first boot resolves it; updated by switch_board before respawn.
    /// Lets board_status report without re-deriving app_data_dir.
    board: Mutex<Option<String>>,
}

// Days-since-epoch to civil date (Howard Hinnant's algorithm): board.json
// wants an ISO-8601 createdAt and there is no chrono dependency for three
// lines of math. Only used by ensure_board_dir() for fresh boards.
fn ymd_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

// Minimal board bootstrap mirroring bin/lib/store.js ensureBoard(): create
// the hot dirs + board.json {name, version, createdAt} IFF board.json is
// absent. Never overwrites, never touches anything else. BOARD_VERSION is
// duplicated here by necessity (no shared schema crate); check.mjs asserts
// parity with store.js BOARD_VERSION on every run.
// NOTE: keep the hot-dir list in lockstep with store.js dirs() + the logs/
// addition (operator token file). check.mjs asserts the set.
fn ensure_board_dir(root: &std::path::Path) -> std::io::Result<()> {
    for sub in [
        "",
        "agents",
        "dm",
        "delivered",
        "broadcast",
        "groups",
        "channels",
        "locks",
        "results",
        "tombstones",
        "pool-state",
        "worker-sessions",
        "index",
        "cursors",
        "revoked",
        "holds",
        "logs",
    ] {
        std::fs::create_dir_all(root.join(sub))?;
    }
    let meta = root.join("board.json");
    if !meta.is_file() {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let days = secs.div_euclid(86400);
        let rem = secs.rem_euclid(86400);
        let (y, m, d) = ymd_from_days(days);
        let at = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
            y,
            m,
            d,
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60
        );
        // CHECK-MJS PARITY: keep "version": 2 in lockstep with
        // bin/lib/store.js BOARD_VERSION (asserted, fails loudly on drift).
        let doc = serde_json::json!({ "name": "board", "version": 2, "createdAt": at });
        std::fs::write(&meta, serde_json::to_string_pretty(&doc).unwrap() + "\n")?;
    }
    Ok(())
}

fn is_loopback_url(s: &str) -> bool {
    s.starts_with("http://127.0.0.1:") || s.starts_with("http://localhost:")
}

// Scan one stdout/stderr line for the first loopback URL the sidecar prints
// (e.g. `crewbus web at http://127.0.0.1:54321 ...`). `--port 0` guarantees
// the port is only known after boot, so we parse, never configure.
fn first_loopback_url(line: &str) -> Option<String> {
    let mut rest = line;
    loop {
        let i = rest.find("http://")?;
        let tail = &rest[i..];
        let end = tail
            .find(|c: char| c.is_whitespace())
            .unwrap_or(tail.len());
        let cand = tail[..end].trim_end_matches(|c| c == '.' || c == ',' || c == ')');
        if is_loopback_url(cand) {
            return Some(cand.to_string());
        }
        rest = &tail[end.min(1).min(tail.len())..];
        if rest.len() <= "http://".len() {
            return None;
        }
        rest = &rest["http://".len().min(rest.len())..];
    }
}

// Normie-install core resolution: the installed app has no repo checkout,
// so the crewbus core ships as Tauri `resources` (tauri.conf
// `bundle.resources: ["../../../bin"]`, staged by tauri-bundler with `..`
// rewritten as `_up_` dirs => `<resourceDir>/_up_/_up_/_up_/bin/crewbus.js` plus
// `<resourceDir>/_up_/_up_/_up_/bin/lib/*.js`, the same relative layout as the
// repo, so the `./lib/*.js` imports inside crewbus.js resolve unchanged —
// the core is zero-dep (node builtins only) and no other repo path is read
// at sidecar runtime). Every plausible layout is probed below and a
// candidate only wins when its sibling `lib/store.js` exists (proves the
// import graph shipped intact). This uses the documented
// `tauri::Manager::path().resource_dir()` pattern; if the toolchain's Tauri
// version returns `PathBuf` instead of `Result<PathBuf>` here, drop the
// `if let Ok(...)` wrapper.
// resolution helper: returns the winning path (if any) plus a
// `debugReport` fragment echoed into the `dashboard-error` message (and
// into sidecar.log) so an installed miss is actionable without a checkout.
// Shape: `crewbus core not found (...) | resource_dir()=... | probed:
// <cand> (missing|present|present, no lib/store.js); ...`.
fn resolve_crewbus_js(app: &tauri::AppHandle) -> (Option<std::path::PathBuf>, String) {
    let mut cands = Vec::new();
    let rd_note: String = match app.path().resource_dir() {
        Ok(rd) => {
            // NOTE: tauri-bundler stages resource `..` segments as literal
            // `_up_` dirs, so `bundle.resources: ["../../../bin"]` (3 parent dirs)
            // lands at `<resourceDir>/_up_/_up_/_up_/bin/` — NOT at `<resourceDir>/bin/`.
            // The other candidates below cover alternate/past layouts.
            for rel in [
                "_up_/_up_/_up_/bin/crewbus.js",
                "_up_/_up_/bin/crewbus.js",
                "_up_/bin/crewbus.js",
                "bin/crewbus.js",
                "crewbus/bin/crewbus.js",
                "crewbus.js",
            ] {
                cands.push(rd.join(rel));
            }
            format!("resource_dir()={}", rd.display())
        }
        Err(e) => format!("resource_dir() Err: {e}"),
    };
    // Dev-checkout fallback (`tauri dev` before resources are staged).
    #[cfg(debug_assertions)]
    cands.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bin/crewbus.js"));
    let mut annotated = Vec::new();
    for p in &cands {
        let tag = if !p.is_file() {
            "(missing)"
        } else if !p
            .parent()
            .map(|d| d.join("lib/store.js").is_file())
            .unwrap_or(false)
        {
            "(present, no lib/store.js)"
        } else {
            "(present)"
        };
        annotated.push(format!("{} {}", p.display(), tag));
    }
    let probed = if annotated.is_empty() {
        "(none)".to_string()
    } else {
        annotated.join("; ")
    };
    let debug_report = format!(
        "crewbus core not found (resources bin/crewbus.js missing and no dev checkout) | {rd_note} | probed: {probed}"
    );
    let hit = cands.into_iter().find(|p| {
        p.is_file()
            && p.parent()
                .map(|d| d.join("lib/store.js").is_file())
                .unwrap_or(false)
    });
    (hit, debug_report)
}

#[tauri::command]
async fn sidecar_status(state: tauri::State<'_, SidecarState>) -> Result<serde_json::Value, String> {
    let url = state.url.lock().map_err(|e| e.to_string())?.clone();
    let status = state.status.lock().map_err(|e| e.to_string())?.clone();
    let detail = state.detail.lock().map_err(|e| e.to_string())?.clone();
    Ok(serde_json::json!({ "url": url, "status": status, "detail": detail }))
}

#[tauri::command]
async fn stop_sidecar(app: tauri::AppHandle, state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.take() {
        child.kill().map_err(|e| e.to_string())?;
    }
    *state.url.lock().map_err(|e| e.to_string())? = None;
    *state.status.lock().map_err(|e| e.to_string())? = Some("stopped".to_string());
    *state.detail.lock().map_err(|e| e.to_string())? = Some("remote-only toggle: sidecar stopped, board untouched".to_string());
    // Board state is NOT touched: killing `serve` removes no `.crewbus/` files.
    let _ = app.emit("dashboard-stopped", ());
    Ok(())
}

// Phase-2 board switching: which board is the sidecar serving?
// Returns { board, defaultBoard, url, status }. `board` is None until the
// first boot resolves it.
#[tauri::command]
async fn board_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> Result<serde_json::Value, String> {
    let board = state.board.lock().map_err(|e| e.to_string())?.clone();
    let url = state.url.lock().map_err(|e| e.to_string())?.clone();
    let status = state.status.lock().map_err(|e| e.to_string())?.clone();
    let default_board = app
        .path()
        .app_data_dir()
        .map(|d| d.join("board").to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(serde_json::json!({
        "board": board,
        "defaultBoard": default_board,
        "url": url,
        "status": status,
    }))
}

// Validate a candidate board dir WITHOUT touching it: must exist, contain
// board.json with a numeric version, and be a directory (not a file).
// Accepts either the project dir (containing .crewbus/) or the board dir
// itself (containing board.json). Mirrors CLI boardDir/findBoardUpward.
fn validate_board_dir(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("pick a folder first".to_string());
    }
    let p = std::path::Path::new(t);
    let candidates = [p.join(".crewbus"), p.to_path_buf()];
    for cand in &candidates {
        let meta = cand.join("board.json");
        if meta.is_file() {
            let text = std::fs::read_to_string(&meta)
                .map_err(|e| format!("cannot read {}: {e}", meta.display()))?;
            let doc: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("{} is not valid JSON: {e}", meta.display()))?;
            match doc.get("version").and_then(|v| v.as_u64()) {
                Some(_) => {}
                None => {
                    return Err(format!(
                        "{} has no numeric version (not a crewbus board)",
                        meta.display()
                    ))
                }
            }
            return Ok(cand.to_string_lossy().into_owned());
        }
    }
    Err(format!(
        "no board found at {t} (need <project>/.crewbus/board.json or board.json directly)"
    ))
}

#[tauri::command]
async fn open_pair_window(app: tauri::AppHandle, dashboard: Option<String>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("pair") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        // Plug-and-play pairing: hand the sidecar origin to pair.js via the
        // ?dashboard= param so it can auto-mint a one-time pair URL on open
        // (POST /api/pair-qr). Validate loopback http(s) before navigating —
        // the pair window's CSP only allows loopback fetches anyway.
        if let Some(db) = dashboard {
            let db = db.trim().to_string();
            let ok = db.starts_with("http://127.0.0.1")
                || db.starts_with("http://localhost")
                || db.starts_with("http://[::1]")
                || db.starts_with("https://127.0.0.1")
                || db.starts_with("https://localhost")
                || db.starts_with("https://[::1]");
            if ok {
                let target = format!(
                    "pair.html?dashboard={}",
                    urlencoding_encode(&db)
                );
                let js = format!("location.replace({})", serde_json::to_string(&target).unwrap_or_else(|_| "\"pair.html\"".to_string()));
                let _ = win.eval(&js);
            }
        }
        Ok(())
    } else {
        Err("pair window not found".to_string())
    }
}

// Minimal URL-encoding for the ?dashboard= query param (no external crate):
// percent-encode everything outside the RFC 3986 unreserved set so Windows
// backslashes and stray ampersands can never smuggle extra params.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// Shared boot-learner: watch sidecar stdout for the first loopback URL,
// record it, emit dashboard-ready. Used by first boot AND switch_board so
// both paths learn the random --port 0 port identically.
async fn learn_sidecar_url(
    handle: tauri::AppHandle,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
) {
    let note = |status: &str, detail: String| {
        if let Ok(mut s) = handle.state::<SidecarState>().status.lock() {
            *s = Some(status.to_string());
        }
        if let Ok(mut d) = handle.state::<SidecarState>().detail.lock() {
            *d = Some(detail);
        }
    };
    let err = |msg: String| {
        note("error", msg.clone());
        let _ = handle.emit(
            "dashboard-error",
            serde_json::json!({ "message": msg }),
        );
    };
    let st: tauri::State<SidecarState> = handle.state();
    let mut learned_url = false;
    while let Some(evt) = rx.recv().await {
        if let CommandEvent::Stdout(line) | CommandEvent::Stderr(line) = evt {
            let text = String::from_utf8_lossy(&line);
            let already_known = st.url.lock().map(|g| g.is_some()).unwrap_or(true);
            if !already_known {
                if let Some(url) = first_loopback_url(&text) {
                    match st.url.lock() {
                        Ok(mut u) => {
                            *u = Some(url.clone());
                            note("ready", url.clone());
                            learned_url = true;
                            let _ = handle.emit(
                                "dashboard-ready",
                                serde_json::json!({ "url": url }),
                            );
                        }
                        Err(e) => {
                            err(format!("lock failed: {e}"));
                            return;
                        }
                    }
                }
            }
        }
    }
    if learned_url {
        note("stopped", "sidecar exited after serving".to_string());
        let _ = handle.emit("dashboard-stopped", ());
    } else {
        err("sidecar exited before serving a URL".to_string());
    }
}

// Restart the sidecar against a validated board dir. Validates first
// (no writes), mkdirs hot dirs only, kills the old child, spawns an
// identical serve with the new --board, re-arms the URL learner.
// Old board untouched; operator auto-provision runs inside the sidecar.
#[tauri::command]
async fn switch_board(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    path: String,
) -> Result<serde_json::Value, String> {
    let board_str = validate_board_dir(&path)?;
    let board_path = std::path::PathBuf::from(&board_str);
    ensure_board_dir(&board_path)
        .map_err(|e| format!("board init failed: {e}"))?;
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
    if let Ok(mut u) = state.url.lock() {
        *u = None;
    }
    if let Ok(mut s) = state.status.lock() {
        *s = Some("switching".to_string());
    }
    if let Ok(mut b) = state.board.lock() {
        *b = Some(board_str.clone());
    }
    let (crewbus_opt, crewbus_report) = resolve_crewbus_js(&app);
    let crewbus_js = match crewbus_opt {
        Some(p) => p.to_string_lossy().into_owned(),
        None => return Err(crewbus_report),
    };
    let args = [
        crewbus_js.as_str(),
        "serve",
        "--port",
        "0",
        "--board",
        board_str.as_str(),
    ];
    let (rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("sidecar missing: {e}"))?
        .args(args)
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }
    tauri::async_runtime::spawn(learn_sidecar_url(app.clone(), rx));
    Ok(serde_json::json!({ "board": board_str }))
}

fn main() {
    tauri::Builder::default()
        // Single-instance MUST register first (per the plugin docs): a
        // second launch hands its args to the running instance and exits, so
        // it can never double-spawn the sidecar. The callback focuses the
        // running `main` window (documented focus pattern). Installer note:
        // NSIS/desktop-shortcut launches exec the same installed exe path, so
        // they route through this callback too — no extra flag is needed for
        // installer-launched second processes.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Updater wiring (INERT without signing keys): registered so a future
        // SIGNED release can auto-update from the `latest.json` endpoint in
        // tauri.conf.json. No `check()` is ever called at startup, so without
        // a pubkey / TAURI_SIGNING_PRIVATE_KEY this plugin performs zero
        // network I/O and can never crash or block boot (see
        // apps/desktop/RELEASE.md for the maintainer steps).
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Autostart for the background-service story (OS login boot where
        // the service/ units are skipped). Registration passes `--minimized`
        // so a login boot hides `main` instead of popping the window (see
        // setup below); the sidecar still spawns.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .manage(SidecarState {
            child: Mutex::new(None),
            url: Mutex::new(None),
            status: Mutex::new(Some("starting".to_string())),
            detail: Mutex::new(Some("sidecar booting".to_string())),
            board: Mutex::new(None),
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Both main and pair windows hide on close ('X') so background
                // sidecar, paired devices, and active agents continue running
                // uninterrupted. Explicit Quit is available from the system tray menu.
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            // System tray menu: Show / Quit.
            // Closing the window ('X') hides it to the background so running agents
            // and mobile pairing continue without interruption. Explicit Quit is
            // available here in the system tray menu.
            let show_i = MenuItemBuilder::new("Show CrewBus").id("show").build(app)?;
            let quit_i = MenuItemBuilder::new("Quit CrewBus").id("quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&show_i)
                .separator()
                .item(&quit_i)
                .build()?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .tooltip("CrewBus")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.unminimize();
                                let _ = win.set_focus();
                            }
                        }
                        "quit" => {
                            if let Ok(mut guard) = app.state::<SidecarState>().child.lock() {
                                if let Some(child) = guard.take() {
                                    let _ = child.kill();
                                }
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _tray = tray_builder.build(app)?;

            // Autostart start-minimized-friendly: hide `main` on a
            // `--minimized` boot (login via the autostart registration).
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.hide();
                }
            }
            // Single-instance is declared (see builder above; it focuses
            // `main` on second launch) so a second launch never
            // double-spawns the sidecar. Autostart via
            // tauri-plugin-autostart covers the OS-registration story
            // (see service/README.md for the unit-based alternative).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Failures emit dashboard-error (the shell renders it) instead
                // of panicking: a crash here would leave the shell on its
                // perpetual "waiting" text with no explanation.
                // Every terminal path ALSO records status+detail in
                // SidecarState so a late frontend (missed the one-shot event)
                // catches up via the sidecar_status command.
                let note = |status: &str, detail: String| {
                    if let Ok(mut s) = handle.state::<SidecarState>().status.lock() {
                        *s = Some(status.to_string());
                    }
                    if let Ok(mut d) = handle.state::<SidecarState>().detail.lock() {
                        *d = Some(detail);
                    }
                };
                let err = |msg: String| {
                    note("error", msg.clone());
                    let _ = handle.emit(
                        "dashboard-error",
                        serde_json::json!({ "message": msg }),
                    );
                };
                // Bundled-node resolution (normie install = no node):
                // `sidecar("node")` is the per-platform node binary packed
                // via `bundle.externalBin: ["binaries/node"]` and staged
                // at build time by `node scripts/fetch-node.mjs`.
                // There is deliberately NO system-PATH fallback here:
                // tauri-plugin-shell v2 keeps `Command::new` private, so an
                // unscoped std-spawn would bypass the capability audit, and
                // dev machines run `scripts/fetch-node.mjs` once instead
                // (externalBin resolves in `tauri dev` too).
                // Pinned (capabilities/main.json `shell:allow-spawn`): ONLY
                // `<crewbus.js> serve --port 0 --board <dir>` (+ `--host`
                // default 127.0.0.1 inside crewbus). The board path varies
                // per machine so its position is a permissive validator;
                // program, file, verb, and flags stay exact. First-run board
                // creation is Rust-side ensure_board_dir() (no sidecar verb
                // needed), so the scope needs exactly one shape.
                let (crewbus_opt, crewbus_report) = resolve_crewbus_js(&handle);
                let crewbus_js = match crewbus_opt {
                    Some(p) => p.to_string_lossy().into_owned(),
                    None => {
                        // Mirror the same report line to sidecar.log
                        // (best-effort; a missing log never blocks the emit).
                        if let Ok(d) = handle.path().app_data_dir() {
                            let _ = std::fs::create_dir_all(&d);
                            let lp = d.join("sidecar.log");
                            if let Ok(mut f) = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(&lp)
                            {
                                use std::io::Write as _;
                                let _ = writeln!(f, "{crewbus_report}");
                            }
                        }
                        err(crewbus_report);
                        return;
                    }
                };
                // Default board for normie installs (no checkout, no
                // CREWBUS_DIR): <app-data>/board, auto-initialized on first
                // run. Mirrors bin/lib/store.js ensureBoard() (mkdirs +
                // board.json {name, version, createdAt} when missing) WITHOUT
                // forking it: this writes ONLY when board.json is absent and
                // never overwrites, and check.mjs asserts BOARD_VERSION
                // parity against store.js so a schema bump fails loudly
                // instead of drifting. requireBoard() only gates on
                // `version` and mkdirs the hot dirs itself on every serve.
                let board_dir = match handle.path().app_data_dir() {
                    Ok(d) => d.join("board"),
                    Err(e) => {
                        err(format!("app data dir unavailable: {e}"));
                        return;
                    }
                };
                let board_str = board_dir.to_string_lossy().into_owned();
                let state: tauri::State<SidecarState> = handle.state();
                // Remember which board this boot serves (board_status).
                if let Ok(mut b) = state.board.lock() {
                    *b = Some(board_str.clone());
                }
                if !board_dir.join("board.json").is_file() {
                    if let Err(e) = ensure_board_dir(&board_dir) {
                        err(format!("default board init failed: {e}"));
                        return;
                    }
                }
                let args = [
                    crewbus_js.as_str(),
                    "serve",
                    "--port",
                    "0",
                    "--board",
                    board_str.as_str(),
                ];
                let (mut rx, child) = match handle.shell().sidecar("node") {
                    Ok(cmd) => match cmd.args(args).spawn() {
                        Ok(pair) => pair,
                        Err(e) => {
                            err(format!("bundled node spawn failed: {e}"));
                            return;
                        }
                    },
                    Err(e) => {
                        err(format!("bundled node sidecar missing (dev: run `node scripts/fetch-node.mjs` from apps/desktop first): {e}"));
                        return;
                    }
                };
                match state.child.lock() {
                    Ok(mut guard) => *guard = Some(child),
                    Err(e) => {
                        err(format!("sidecar state lock failed: {e}"));
                        return;
                    }
                };
                // Sidecar log file (<app-data>/sidecar.log, truncated per
                // boot): post-mortem when the window only says "waiting".
                // Best-effort — a missing log never blocks the sidecar.
                let log_path = handle
                    .path()
                    .app_data_dir()
                    .map(|d| {
                        let _ = std::fs::create_dir_all(&d);
                        d.join("sidecar.log")
                    })
                    .unwrap_or_else(|_| std::path::PathBuf::from("sidecar.log"));
                let mut logf = std::fs::File::create(&log_path).ok();
                use std::io::Write as _;
                let mut learned_url = false;
                while let Some(evt) = rx.recv().await {
                    if let CommandEvent::Stdout(line) | CommandEvent::Stderr(line) = evt {
                        let text = String::from_utf8_lossy(&line);
                        if let Some(f) = logf.as_mut() {
                            let _ = writeln!(f, "{}", text);
                        }
                        let already_known = state.url.lock().map(|g| g.is_some()).unwrap_or(true);
                        if !already_known {
                            if let Some(url) = first_loopback_url(&text) {
                                match state.url.lock() {
                                    Ok(mut u) => {
                                        *u = Some(url.clone());
                                        note("ready", url.clone());
                                        learned_url = true;
                                        let _ = handle.emit(
                                            "dashboard-ready",
                                            serde_json::json!({ "url": url }),
                                        );
                                    }
                                    Err(e) => {
                                        err(format!("sidecar state lock failed while recording URL: {e}"));
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
                // End of stream: normal shutdown (toggle/quit) only counts if
                // a URL was ever learned — otherwise the sidecar died before
                // serving (e.g. no board, bad flags) and the shell must say
                // so instead of idling on "waiting" forever.
                if learned_url {
                    note("stopped", "sidecar exited after serving".to_string());
                    let _ = handle.emit("dashboard-stopped", ());
                } else {
                    err("sidecar exited before serving a URL (board init or serve flags failed)".to_string());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sidecar_status, stop_sidecar, open_pair_window, board_status, switch_board])
        .run(tauri::generate_context!())
        .expect("crewbus desktop failed");
}
