pub mod agents;

use std::path::PathBuf;

/// Config directory — same location as conductor.cmd (project root).
/// In dev mode, walks up from target/debug/ to find conductor.cmd.
pub fn config_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let mut dir = exe.parent().unwrap_or(&std::path::Path::new(".")).to_path_buf();

    // In dev mode, exe is in target/debug/ — walk up to where conductor.cmd lives
    for _ in 0..5 {
        if dir.join("conductor.cmd").exists() || dir.join("agents.json").exists() {
            return dir;
        }
        if let Some(parent) = dir.parent() {
            dir = parent.to_path_buf();
        } else { break; }
    }
    // Fallback: exe directory
    exe.parent().unwrap_or(&std::path::Path::new(".")).to_path_buf()
}
