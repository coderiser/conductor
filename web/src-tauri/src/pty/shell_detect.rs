use crate::config::agents::AgentsConfig;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub command: String,
    pub installed: bool,
}

pub fn detect_agents() -> Vec<AgentInfo> {
    let config = AgentsConfig::load();
    config.agents.iter().map(|a| AgentInfo {
        id: a.id.clone(),
        name: a.name.clone(),
        command: a.command.clone(),
        installed: a.builtin || which::which(&a.command).is_ok(),
    }).collect()
}
