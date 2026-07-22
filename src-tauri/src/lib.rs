use tauri_plugin_opener::OpenerExt;

/// The remote origin the desktop shell wraps. Navigation that stays on this
/// host is handled in-app; anything else is opened in the system browser.
const APP_HOST: &str = "kluely.vercel.app";
const APP_URL: &str = "https://kluely.vercel.app";

/// A normal WebView2 UA with a "KluelyDesktop" marker appended, so the remote
/// page can detect it runs inside the desktop shell (via navigator.userAgent)
/// and hide browser-only affordances like the "Download on Desktop" button.
/// A custom UA is set here rather than in tauri.conf.json because the window
/// itself must be built in Rust to attach the external-link handlers below,
/// and a config-declared window can't carry those builder-only handlers.
const KLUELY_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 \
Edg/120.0.0.0 KluelyDesktop/1.0";

/// True for URLs that should leave the app and open in the user's browser:
/// http(s) links to any host other than our own. Internal schemes (tauri:,
/// about:, blob:, data:, …) and same-host navigation stay in the webview.
fn is_external(url: &tauri::Url) -> bool {
  match url.scheme() {
    "http" | "https" => url.host_str() != Some(APP_HOST),
    _ => false,
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // The window is built here (not in tauri.conf.json) so it can carry the
      // navigation/new-window handlers that route external links to the
      // system browser — the fix for target="_blank" links doing nothing
      // inside the webview.
      let nav_handle = app.handle().clone();
      let win_handle = app.handle().clone();
      let url: tauri::Url = APP_URL.parse().expect("valid app URL");

      tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
        .title("Kluely")
        .inner_size(1100.0, 800.0)
        .min_inner_size(480.0, 600.0)
        .resizable(true)
        .user_agent(KLUELY_USER_AGENT)
        // Keep the SmartScreen/OOUI tweaks and auto-grant the mic prompt, as
        // the previous config-defined window did.
        .additional_browser_args(
          "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--use-fake-ui-for-media-stream",
        )
        // Same-window navigation to an external host: open it in the browser
        // and cancel the in-app navigation.
        .on_navigation(move |url| {
          if is_external(url) {
            let _ = nav_handle.opener().open_url(url.to_string(), None::<&str>);
            return false;
          }
          true
        })
        // target="_blank" / window.open: WebView2 raises a new-window request
        // that the webview otherwise swallows. Open external targets in the
        // browser and deny the in-app popup.
        .on_new_window(move |url, _features| {
          if is_external(&url) {
            let _ = win_handle.opener().open_url(url.to_string(), None::<&str>);
            tauri::webview::NewWindowResponse::Deny
          } else {
            tauri::webview::NewWindowResponse::Allow
          }
        })
        .build()?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
