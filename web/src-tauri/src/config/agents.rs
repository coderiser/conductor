use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    #[serde(alias = "createTemplate")]
    pub create_template: String,  // e.g. "--session-id {session_id}"
    #[serde(default)]
    #[serde(alias = "resumeTemplate")]
    pub resume_template: String,  // e.g. "--resume {session_id}"
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentsConfig {
    #[serde(default = "default_agents")]
    pub agents: Vec<AgentConfig>,
}

fn default_agents() -> Vec<AgentConfig> {
    vec![
        AgentConfig { id: "cmd".into(), name: "Command Prompt".into(), command: "cmd.exe".into(), args: vec![], create_template: String::new(), resume_template: String::new(), builtin: true },
        AgentConfig { id: "claude".into(), name: "Claude Code".into(), command: "claude".into(), args: vec![], create_template: "--session-id {session_id}".into(), resume_template: "--resume {session_id}".into(), builtin: false },
        AgentConfig { id: "opencode".into(), name: "OpenCode".into(), command: "opencode".into(), args: vec![], create_template: String::new(), resume_template: "--session {session_id}".into(), builtin: false },
        AgentConfig { id: "codex".into(), name: "Codex".into(), command: "codex".into(), args: vec![], create_template: String::new(), resume_template: "resume --last".into(), builtin: false },
    ]
}

impl AgentsConfig {
    pub fn load() -> Self {
        let path = super::config_dir().join("agents.json");
        match fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| Self::default()),
            Err(_) => {
                let cfg = Self::default();
                if let Ok(j) = serde_json::to_string_pretty(&cfg) {
                    let _ = fs::write(&path, j);
                }
                cfg
            }
        }
    }

    pub fn find(&self, id: &str) -> Option<&AgentConfig> {
        self.agents.iter().find(|a| a.id == id)
    }

    pub fn installed(&self) -> Vec<&AgentConfig> {
        self.agents.iter().filter(|a| {
            if a.builtin { return true; }
            which::which(&a.command).is_ok()
        }).collect()
    }
}

impl Default for AgentsConfig {
    fn default() -> Self {
        Self { agents: default_agents() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resume_templates() {
        let cfg = AgentsConfig::default();

        // Claude: create at spawn, resume with --resume
        let claude = cfg.find("claude").unwrap();
        assert_eq!(claude.create_template, "--session-id {session_id}");
        assert_eq!(claude.resume_template, "--resume {session_id}");

        // OpenCode: no create template, resume with --session {ses_xxx}
        let opencode = cfg.find("opencode").unwrap();
        assert_eq!(opencode.create_template, "");
        assert_eq!(opencode.resume_template, "--session {session_id}");
        let arg = opencode.resume_template.replace("{session_id}", "ses_test123");
        assert_eq!(arg, "--session ses_test123");

        // Codex: no create template, resume uses --last (most recent session)
        let codex = cfg.find("codex").unwrap();
        assert_eq!(codex.create_template, "");
        assert_eq!(codex.resume_template, "resume --last");
    }

    #[test]
    fn test_opencode_db_parsing() {
        // Simulate "opencode db SELECT id FROM session" output
        let stdout = "\
id
──────────
ses_aaa111
ses_bbb222
ses_ccc333";

        let ids: Vec<String> = stdout
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim();
                if trimmed.starts_with("ses_") {
                    Some(trimmed.to_string())
                } else {
                    None
                }
            })
            .collect();

        assert_eq!(ids, vec!["ses_aaa111", "ses_bbb222", "ses_ccc333"]);
    }

    #[test]
    fn test_codex_session_index_parsing() {
        // Simulate session_index.jsonl content
        let content = r#"{"id":"019eb61a-bf68-7f31-8c19-93351ab97b56","thread_name":"test","updated_at":"2026-06-11T09:54:47Z"}
{"id":"019eb432-0b8f-7ba0-8206-8d06c4e8eb46","thread_name":"other","updated_at":"2026-06-11T08:00:00Z"}"#;

        let ids: Vec<String> = content
            .lines()
            .filter_map(|line| {
                serde_json::from_str::<serde_json::Value>(line).ok()
                    .and_then(|v| v.get("id")?.as_str().map(String::from))
            })
            .collect();

        assert_eq!(ids, vec![
            "019eb61a-bf68-7f31-8c19-93351ab97b56",
            "019eb432-0b8f-7ba0-8206-8d06c4e8eb46",
        ]);
    }

    #[test]
    fn test_before_after_snapshot_diff() {
        let prev = vec!["ses_aaa111".to_string(), "ses_bbb222".to_string()];
        let after = vec!["ses_aaa111".to_string(), "ses_bbb222".to_string(), "ses_ccc333".to_string()];

        let new_id = after.iter().find(|id| !prev.contains(id)).cloned();
        assert_eq!(new_id, Some("ses_ccc333".to_string()));
    }

    #[test]
    fn test_json_backward_compatibility() {
        // Old agents.json with minimal fields — missing optional fields should default
        let old_json = r#"{
            "agents": [
                {"id": "test", "name": "Test", "command": "test",
                 "builtin": false}
            ]
        }"#;
        let cfg: AgentsConfig = serde_json::from_str(old_json).unwrap();
        let agent = cfg.find("test").unwrap();
        assert_eq!(agent.create_template, "");
        assert_eq!(agent.resume_template, "");
        assert_eq!(agent.args, Vec::<String>::new());
    }
}
