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
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentsConfig {
    #[serde(default = "default_agents")]
    pub agents: Vec<AgentConfig>,
}

fn default_agents() -> Vec<AgentConfig> {
    vec![
        AgentConfig { id: "cmd".into(), name: "Command Prompt".into(), command: "cmd.exe".into(), args: vec![], builtin: true },
        AgentConfig { id: "claude".into(), name: "Claude Code".into(), command: "claude".into(), args: vec![], builtin: false },
        AgentConfig { id: "opencode".into(), name: "OpenCode".into(), command: "opencode".into(), args: vec![], builtin: false },
        AgentConfig { id: "codex".into(), name: "Codex".into(), command: "codex".into(), args: vec![], builtin: false },
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
