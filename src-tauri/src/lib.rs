use tauri::Manager;

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

struct SidecarChild(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // In release mode, spawn the sidecar server and wait for ready signal
            #[cfg(not(debug_assertions))]
            {
                let sidecar = app
                    .shell()
                    .sidecar("codex-server")
                    .expect("failed to create sidecar");
                let (mut rx, child) = sidecar
                    .env("TAURI_SIDECAR", "1")
                    .spawn()
                    .expect("failed to spawn sidecar");

                // Store child handle for cleanup on exit
                app.manage(SidecarChild(std::sync::Mutex::new(Some(child))));

                let window = app
                    .get_webview_window("main")
                    .expect("main window not found");

                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_shell::process::CommandEvent;
                    while let Some(event) = rx.recv().await {
                        match event {
                            CommandEvent::Stdout(line) => {
                                let text = String::from_utf8_lossy(&line);
                                if text.contains("__SIDECAR_READY__") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                    break;
                                }
                            }
                            CommandEvent::Error(err) => {
                                eprintln!("sidecar error: {err}");
                            }
                            _ => {}
                        }
                    }
                });
            }

            // In debug mode, the server is started via beforeDevCommand
            #[cfg(debug_assertions)]
            {
                app.manage(SidecarChild(std::sync::Mutex::new(None)));
                let window = app
                    .get_webview_window("main")
                    .expect("main window not found");
                let _ = window.show();
                let _ = window.set_focus();
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarChild>() {
                if let Some(child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
