mod pty;
mod commands;
mod db;
mod config;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        ])
        .manage(pty::manager::PtyManager::new())
        .manage(db::store::DbStore::new().expect("Failed to init database"))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<pty::manager::PtyManager>().kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
