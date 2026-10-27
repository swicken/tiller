mod external_links;

use std::{env, fs, path::PathBuf, process::{Command, Stdio}, thread, time::{Duration, Instant}};
use tauri::{image::Image, menu::{Menu, MenuItem, PredefinedMenuItem}, tray::TrayIconBuilder, AppHandle, Manager, RunEvent, Theme, Url, WebviewWindow, Wry};

fn home() -> PathBuf {
    env::var_os("TL_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env::var("HOME").unwrap_or_default()).join(".tiller"))
}

fn read(name: &str) -> Option<String> {
    fs::read_to_string(home().join(name)).ok().map(|s| s.trim().to_string())
}

// Same lookup as src/daemon/home.ts daemonPort.
fn port() -> u16 {
    env::var("TL_PORT").ok().or_else(|| read("port")).and_then(|p| p.parse().ok()).unwrap_or(7788)
}

fn alive(port: u16) -> bool {
    reqwest::blocking::Client::new().get(format!("http://127.0.0.1:{port}/health")).timeout(Duration::from_millis(500)).send().is_ok_and(|r| r.status().is_success())
}

// Start bin/tld detached in its own session, appending to daemon.log, then wait up to 15 s for /health.
fn ensure_daemon(port: u16) -> Result<(), String> {
    if alive(port) { return Ok(()); }
    let repo = option_env!("TL_REPO").map(String::from).or_else(|| read("repo")).ok_or("no ~/.tiller/repo (run `tl` once) and TL_REPO not set at build time")?;
    fs::create_dir_all(home()).map_err(|e| e.to_string())?;
    let log = fs::OpenOptions::new().create(true).append(true).open(home().join("daemon.log")).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(PathBuf::from(repo).join("bin/tld"));
    cmd.env("TL_HOME", home()).env("TL_PORT", port.to_string()).stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    cmd.spawn().map_err(|e| format!("starting bin/tld: {e}"))?;
    let end = Instant::now() + Duration::from_secs(15);
    while Instant::now() < end {
        if alive(port) { return Ok(()); }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!("daemon did not come up on port {port}; see {}", home().join("daemon.log").display()))
}

// A filled circle for the menu bar: 32 px, so 16 pt on a Retina screen.
fn dot(rgb: [u8; 3]) -> Image<'static> {
    const N: u32 = 32;
    let c = N as f32 / 2.0;
    let px = (0..N * N).flat_map(|i| {
        let (dx, dy) = ((i % N) as f32 + 0.5 - c, (i / N) as f32 + 0.5 - c);
        let alpha = ((9.0 - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0) * 255.0) as u8; // radius 9, antialiased edge
        [rgb[0], rgb[1], rgb[2], alpha]
    }).collect();
    Image::new_owned(px, N, N)
}

// Nodes that need you (id, title), then Open and the do-not-disturb toggle.
fn tray_menu(app: &AppHandle, items: &[(String, String)], dnd: bool) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    for (id, title) in items { menu.append(&MenuItem::with_id(app, format!("node:{id}"), title, true, None::<&str>)?)?; }
    if !items.is_empty() { menu.append(&PredefinedMenuItem::separator(app)?)?; }
    menu.append(&MenuItem::with_id(app, "open", "Open Tiller", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "dnd", if dnd { "Turn off do not disturb" } else { "Do not disturb 1 h" }, true, None::<&str>)?)?;
    Ok(menu)
}

const GREEN: [u8; 3] = [0x30, 0xa4, 0x6c];

fn show_and_focus(w: &tauri::WebviewWindow) {
    let _ = w.show();
    let _ = w.set_focus();
}

// The UI calls this whenever what needs you changes (ui/hooks.ts useDocumentSync), as it sets the Dock badge.
#[tauri::command]
fn set_tray(app: AppHandle, color: String, items: Vec<(String, String)>, dnd: bool) -> Result<(), String> {
    let tray = app.tray_by_id("tl").ok_or("no tray icon")?;
    let rgb = match color.as_str() { "red" => [0xe5, 0x48, 0x4d], "amber" => [0xf5, 0xa5, 0x24], _ => GREEN };
    tray.set_icon(Some(dot(rgb))).map_err(|e| e.to_string())?;
    tray.set_menu(Some(tray_menu(&app, &items, dnd).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())
}

fn parse_theme(theme: Option<&str>) -> Result<Option<Theme>, String> {
    match theme {
        None => Ok(None),
        Some("light") => Ok(Some(Theme::Light)),
        Some("dark") => Ok(Some(Theme::Dark)),
        Some(other) => Err(format!("unknown theme {other:?}")),
    }
}

// The UI calls this with its theme preference (ui/theme.ts); None follows the OS. The traffic lights take this appearance.
#[tauri::command]
fn set_app_theme(window: WebviewWindow, theme: Option<String>) -> Result<(), String> {
    window.set_theme(parse_theme(theme.as_deref())?).map_err(|e| e.to_string())
}

// Menu clicks go to the UI (window.__tltray in ui/hooks.ts), which selects the node or toggles do not disturb.
fn on_tray_menu(app: &AppHandle, id: &str) {
    let Some(w) = app.get_webview_window("main") else { return };
    if id == "dnd" { let _ = w.eval("window.__tltray?.('dnd')"); return; }
    show_and_focus(&w); // every other id, "open" included, brings the window up
    if let Some(node) = id.strip_prefix("node:").filter(|n| n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')) {
        let _ = w.eval(format!("window.__tltray?.('select', '{node}')"));
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![set_tray, set_app_theme, external_links::open_external_url])
        .setup(|app| {
            TrayIconBuilder::with_id("tl")
                .icon(dot(GREEN))
                .tooltip("Tiller")
                .menu(&tray_menu(app.handle(), &[], false)?)
                .on_menu_event(|app, e| on_tray_menu(app, e.id().as_ref()))
                .build(app)?;
            let win = app.get_webview_window("main").expect("main window");
            thread::spawn(move || {
                let port = port();
                if let Err(e) = ensure_daemon(port) { eprintln!("tiller: {e}"); return; }
                let token = read("admin-token").unwrap_or_default();
                // `tl` launches the app with `--node <id>` so it opens on that node.
                let node = env::args().skip_while(|a| a != "--node").nth(1).map(|n| format!("&node={n}")).unwrap_or_default();
                // The UI sets the Dock badge itself (ui/hooks.ts useDocumentSync).
                let _ = win.navigate(Url::parse(&format!("http://127.0.0.1:{port}/?k={token}&app=1{node}")).unwrap());
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, event| {
        if let RunEvent::Reopen { .. } = event {
            if let Some(w) = app.get_webview_window("main") { show_and_focus(&w); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_theme, Theme};

    #[test]
    fn parses_only_known_themes() {
        assert_eq!(parse_theme(None), Ok(None));
        assert_eq!(parse_theme(Some("light")), Ok(Some(Theme::Light)));
        assert_eq!(parse_theme(Some("dark")), Ok(Some(Theme::Dark)));
        for value in ["system", "Light", ""] {
            assert!(parse_theme(Some(value)).is_err(), "{value}");
        }
    }
}
