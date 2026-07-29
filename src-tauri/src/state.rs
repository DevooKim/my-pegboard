//! 앱 전역 상태.
//!
//! Rust가 데이터의 주인이라는 원칙(DECISIONS 5장)의 구현체.
//! 저장소·비밀·연결 설정을 한 곳에서 들고 있으며, 커맨드는 여기를 통해서만 접근한다.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::providers::jira::JiraCredentials;
use crate::secrets::{SecretKey, SecretStore};
use crate::storage::board::BoardStore;
use crate::storage::cache::CacheStore;
use crate::storage::todos::TodoStore;

/// 비밀이 아닌 연결 설정. `connections.json`에 저장된다.
///
/// 토큰과 이메일은 여기 없다 — 키체인에 있다. 이 파일을 실수로 복사하거나
/// git에 넣어도 자격증명이 딸려가지 않도록 하는 것이 분리의 목적(DECISIONS 9장).
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Connections {
    #[serde(default)]
    pub version: u32,
    /// `https://your-team.atlassian.net`
    #[serde(default)]
    pub jira_base_url: Option<String>,
}

pub struct AppState {
    pub board: Mutex<BoardStore>,
    pub todos: Mutex<TodoStore>,
    pub cache: Mutex<CacheStore>,
    pub secrets: SecretStore,
    pub connections: Mutex<Connections>,
    pub connections_path: PathBuf,
    /// reqwest 클라이언트는 커넥션 풀을 들고 있으므로 재사용해야 한다.
    /// 위젯마다 새로 만들면 TLS 핸드셰이크를 매번 다시 한다.
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(base_dir: PathBuf) -> Result<Self, String> {
        let (board, board_outcome) =
            BoardStore::load(&base_dir).map_err(|e| format!("보드 파일을 읽을 수 없습니다: {e}"))?;
        if board_outcome.is_noteworthy() {
            tracing::warn!(?board_outcome, "보드 파일 상태");
        }

        let (todos, todos_outcome) =
            TodoStore::load(&base_dir).map_err(|e| format!("todo 파일을 읽을 수 없습니다: {e}"))?;
        if todos_outcome.is_noteworthy() {
            tracing::warn!(?todos_outcome, "todo 파일 상태");
        }

        let connections_path = base_dir.join("connections.json");
        let connections = std::fs::read_to_string(&connections_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Connections>(&s).ok())
            .unwrap_or_default();

        Ok(Self {
            board: Mutex::new(board),
            todos: Mutex::new(todos),
            cache: Mutex::new(CacheStore::new(&base_dir)),
            secrets: SecretStore::new(),
            connections: Mutex::new(connections),
            connections_path,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .user_agent(concat!("my-pegboard/", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|e| format!("HTTP 클라이언트를 만들 수 없습니다: {e}"))?,
        })
    }

    /// 키체인 + 설정에서 Jira 자격증명을 조립한다.
    ///
    /// 셋 중 하나라도 없으면 `None`. 부분적으로만 설정된 상태를 "설정됨"으로
    /// 취급하면 사용자가 401을 받고 원인을 못 찾는다.
    pub fn jira_credentials(&self) -> Result<Option<JiraCredentials>, String> {
        let base_url = {
            let c = self.connections.lock().map_err(|_| "상태 잠금 실패")?;
            c.jira_base_url.clone()
        };
        let Some(base_url) = base_url.filter(|s| !s.trim().is_empty()) else {
            return Ok(None);
        };

        let email = self
            .secrets
            .get(&SecretKey::jira_email())
            .map_err(|e| e.to_string())?;
        let token = self
            .secrets
            .get(&SecretKey::jira_token())
            .map_err(|e| e.to_string())?;

        match (email, token) {
            (Some(email), Some(token)) => Ok(Some(JiraCredentials::new(
                base_url,
                email.expose(),
                token.expose(),
            ))),
            _ => Ok(None),
        }
    }

    pub fn save_connections(&self) -> Result<(), String> {
        let c = self.connections.lock().map_err(|_| "상태 잠금 실패")?;
        crate::storage::atomic::write_json_atomic(&self.connections_path, &*c)
            .map_err(|e| format!("연결 설정을 저장할 수 없습니다: {e}"))
    }
}
