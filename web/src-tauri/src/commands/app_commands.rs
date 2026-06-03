use crate::pty::shell_detect::{self, AgentInfo};
use crate::db::store::{DbStore, SavedLayout, SavedSession};
use serde::Serialize;

#[derive(Serialize)]
pub struct GitInfo { pub branch: Option<String>, pub dirty: bool, pub repo_exists: bool }

#[tauri::command]
pub async fn detect_agents() -> Result<Vec<AgentInfo>, String> { Ok(shell_detect::detect_agents()) }

#[tauri::command]
pub async fn get_git_status(path: String) -> Result<GitInfo, String> {
    match git2::Repository::discover(&path) {
        Ok(repo) => {
            let branch = repo.head().ok().and_then(|h| h.shorthand().ok().map(|s| s.to_string()));
            let dirty = repo.statuses(None).map(|s| s.iter().any(|e| e.status() != git2::Status::CURRENT)).unwrap_or(false);
            Ok(GitInfo { branch, dirty, repo_exists: true })
        }
        Err(_) => Ok(GitInfo { branch: None, dirty: false, repo_exists: false }),
    }
}

#[tauri::command]
pub async fn save_layout(dockview_json: String, sessions: Vec<SavedSession>, window_width: u32, window_height: u32, state: tauri::State<'_, DbStore>) -> Result<(), String> {
    state.save_layout(&SavedLayout { sessions, dockview_json, window_width, window_height }).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_layout(state: tauri::State<'_, DbStore>) -> Result<Option<SavedLayout>, String> {
    state.load_layout().map_err(|e| e.to_string())
}
