mod pty;
mod commands;
mod db;
mod config;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    log::info!("Conductor starting...");
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_commands::detect_agents,
            commands::app_commands::get_git_status,
            commands::app_commands::save_layout,
            commands::app_commands::load_layout,
            commands::pty_commands::pty_spawn,
            commands::pty_commands::pty_write,
            commands::pty_commands::pty_resize,
            commands::pty_commands::pty_kill,
            commands::pty_commands::pty_list,
            commands::pty_commands::pty_kill_all,
            commands::pty_commands::pty_set_agent_session_id,
        ])
        .manage(pty::manager::PtyManager::new())
        .manage(db::store::DbStore::new().expect("Failed to init database"))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Only kill all PTY sessions — do NOT save here.
                // The frontend auto-save (debounced) + beforeunload flush handles persistence.
                // Saving from mgr.list() can include stale sessions that the user already closed.
                let mgr = window.state::<pty::manager::PtyManager>();
                mgr.kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
