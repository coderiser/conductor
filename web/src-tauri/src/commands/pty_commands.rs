use crate::pty::manager::PtyManager;
use crate::pty::session::SessionInfo;

#[tauri::command]
pub async fn pty_spawn(
    agent: String, cwd: String, cols: u16, rows: u16,
    state: tauri::State<'_, PtyManager>, app: tauri::AppHandle,
) -> Result<SessionInfo, String> {
    let cwd = if cwd.is_empty() {
        std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    } else { cwd };
    state.spawn(agent, cwd, cols, rows, app)
}

#[tauri::command]
pub async fn pty_write(session_id: String, data: String, state: tauri::State<'_, PtyManager>) -> Result<(), String> {
    state.write(&session_id, &data)
}

#[tauri::command]
pub async fn pty_resize(session_id: String, cols: u16, rows: u16, state: tauri::State<'_, PtyManager>) -> Result<(), String> {
    state.resize(&session_id, cols, rows)
}

#[tauri::command]
pub async fn pty_kill(session_id: String, state: tauri::State<'_, PtyManager>) -> Result<(), String> {
    state.kill(&session_id)
}

#[tauri::command]
pub async fn pty_list(state: tauri::State<'_, PtyManager>) -> Result<Vec<SessionInfo>, String> {
    Ok(state.list())
}

#[tauri::command]
pub async fn pty_kill_all(state: tauri::State<'_, PtyManager>) -> Result<(), String> {
    state.kill_all();
    Ok(())
}
