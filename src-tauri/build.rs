fn main() {
  // App commands need ACL entries because the UI is served from a local remote URL.
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["set_tray", "set_app_theme", "open_external_url"]))).expect("tauri build");
}
