//! Jira 에러 분류 (DECISIONS 16장).
//!
//! 이 모듈의 유일한 책임: **재시도해도 되는 실패**와 **재시도하면 안 되는 실패**를
//! 호출자가 헷갈릴 수 없게 구분하는 것.
//!
//! | 실패 | 성격 | 처리 |
//! |---|---|---|
//! | 401 토큰 만료 | 영구 | 전역 배너 + [설정 열기] |
//! | 403 권한 없음 | 영구 | 위젯 에러 상태 |
//! | 400 JQL 오류 | 영구 | **Jira 원문 메시지 그대로** |
//! | 404 없음 | 영구 | 위젯 에러 상태 |
//! | 429 rate limit | 일시 | 백오프 재시도 (`Retry-After` 존중) |
//! | 5xx | 일시 | 백오프 재시도 |
//! | 네트워크/타임아웃 | 일시 | 백오프 재시도 |
//!
//! Jira의 `errorMessages` / `errors` 본문은 **가공하지 않고 그대로** 보존한다.
//! JQL 문법 오류에 대한 Jira 메시지는 실제로 친절하고, 우리가 다시 쓰면 나빠지기만 한다.

use serde::{Deserialize, Serialize};
use std::fmt;

/// 재시도 정책을 결정하는 단 하나의 축.
///
/// 호출자(스케줄러)는 `Transient`만 재시도한다. `Permanent`를 재시도하면
/// 401로 4번 더 두들겨서 계정이 잠기는 식의 일만 생긴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// 재시도하면 성공할 수 있다. 지수 백오프 3회.
    Transient,
    /// 사람이 뭔가 바꾸기 전에는 몇 번을 해도 같은 결과.
    Permanent,
}

impl ErrorKind {
    pub fn is_transient(self) -> bool {
        matches!(self, ErrorKind::Transient)
    }

    pub fn is_permanent(self) -> bool {
        matches!(self, ErrorKind::Permanent)
    }
}

/// 프론트가 어떤 UI를 그릴지 고르기 위한 세부 사유.
///
/// `ErrorKind`가 "재시도할까?"라면 이건 "사용자에게 뭐라고 할까?"에 답한다.
/// `rename_all`이 enum 레벨과 필드 레벨 양쪽에 있는 이유: enum의 `rename_all`은
/// **variant 이름**만 바꾼다. variant 안의 필드까지 camelCase로 만들려면
/// `rename_all_fields`가 따로 필요하다. 이게 없으면 프론트가 `retryAfterSecs`를
/// 찾는데 실제로는 `retry_after_secs`가 나가서 429 대기 시간이 조용히 사라진다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JiraError {
    /// 401. 토큰 만료/오입력. 전역 배너 1회 (위젯마다 반복 금지).
    Unauthorized { message: String },

    /// 403. 인증은 됐지만 이 리소스에 권한이 없음.
    Forbidden { message: String },

    /// 404. 이슈/프로젝트가 없거나, 있어도 볼 권한이 없어 Jira가 숨긴 경우.
    NotFound { message: String },

    /// 400. 대부분 JQL 문법 오류. `message`는 **Jira 원문 그대로**.
    BadRequest { message: String },

    /// 429. `retry_after_secs`는 `Retry-After` 헤더가 있을 때만 채워진다.
    RateLimited {
        message: String,
        retry_after_secs: Option<u64>,
    },

    /// 5xx. Jira 쪽 문제.
    ServerError { status: u16, message: String },

    /// 연결 실패·DNS·TLS·타임아웃. 요청이 Jira에 닿지 못했거나 응답이 오지 않음.
    Network { message: String },

    /// 200을 받았지만 우리가 기대한 모양이 아님. 스키마가 바뀌었거나 우리 타입이 틀림.
    ///
    /// **영구**로 분류한다 — 같은 응답을 다시 받아도 같은 자리에서 깨진다.
    /// 조용히 넘기지 않는 것이 중요하다(CLAUDE.md "조용한 실패 금지").
    Decode { message: String },

    /// 위 어디에도 안 들어가는 HTTP 상태.
    Unexpected { status: u16, message: String },
}

impl JiraError {
    /// 재시도 여부. 이 앱에서 이 함수보다 중요한 분기는 거의 없다.
    pub fn kind(&self) -> ErrorKind {
        match self {
            JiraError::RateLimited { .. }
            | JiraError::ServerError { .. }
            | JiraError::Network { .. } => ErrorKind::Transient,
            JiraError::Unauthorized { .. }
            | JiraError::Forbidden { .. }
            | JiraError::NotFound { .. }
            | JiraError::BadRequest { .. }
            | JiraError::Decode { .. } => ErrorKind::Permanent,
            // 알 수 없는 상태 코드: 5xx면 서버 문제일 가능성이 높으니 재시도를 허용하고,
            // 나머지(3xx/4xx)는 재시도해도 같을 것으로 본다.
            JiraError::Unexpected { status, .. } => {
                if *status >= 500 {
                    ErrorKind::Transient
                } else {
                    ErrorKind::Permanent
                }
            }
        }
    }

    pub fn is_transient(&self) -> bool {
        self.kind().is_transient()
    }

    pub fn is_permanent(&self) -> bool {
        self.kind().is_permanent()
    }

    /// 401 전용 판별. "인증 실패는 전역 배너 한 번만" 규칙의 트리거.
    pub fn is_auth_failure(&self) -> bool {
        matches!(self, JiraError::Unauthorized { .. })
    }

    /// 429에 `Retry-After`가 실려 왔다면 그 값(초). 없으면 `None`이고
    /// 호출자는 자기 백오프 스케줄을 쓴다.
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            JiraError::RateLimited {
                retry_after_secs, ..
            } => *retry_after_secs,
            _ => None,
        }
    }

    /// 사용자에게 보여줄 문자열. Jira 원문이 있으면 그대로다.
    pub fn message(&self) -> &str {
        match self {
            JiraError::Unauthorized { message }
            | JiraError::Forbidden { message }
            | JiraError::NotFound { message }
            | JiraError::BadRequest { message }
            | JiraError::RateLimited { message, .. }
            | JiraError::ServerError { message, .. }
            | JiraError::Network { message }
            | JiraError::Decode { message }
            | JiraError::Unexpected { message, .. } => message,
        }
    }

    /// HTTP 상태 코드 + 응답 본문에서 에러를 만든다.
    ///
    /// 본문이 Jira의 표준 에러 봉투(`{"errorMessages": [...], "errors": {...}}`)면
    /// 그 텍스트를 **그대로** 쓴다. 아니면 본문 전체를 잘라서 쓴다.
    ///
    /// 어느 경로든 마지막에 [`sanitize`]를 통과한다. 프록시나 게이트웨이가
    /// 요청 URL을 그대로 에코하는 에러 페이지를 돌려주면 거기에 `user:token@host`가
    /// 실려 있을 수 있고, 그게 로그와 화면에 그대로 나가면 안 된다.
    /// Jira 자신의 메시지에는 URL이 없으므로 이 처리로 원문이 손상되지 않는다.
    pub fn from_response(status: u16, body: &str, retry_after: Option<u64>) -> Self {
        // **순서가 중요하다: 자르기 전에 마스킹한다.**
        // 반대로 하면 잘림 지점이 URL의 종결 '@' 앞에 떨어졌을 때 sanitize가
        // authority를 인식하지 못해 토큰이 통째로 살아남는다. (실측으로 확인함)
        let message = extract_jira_message(body)
            .map(|m| sanitize(&m))
            .unwrap_or_else(|| fallback_message(status, &sanitize(body)));

        match status {
            400 => JiraError::BadRequest { message },
            401 => JiraError::Unauthorized { message },
            403 => JiraError::Forbidden { message },
            404 => JiraError::NotFound { message },
            429 => JiraError::RateLimited {
                message,
                retry_after_secs: retry_after,
            },
            s if (500..600).contains(&s) => JiraError::ServerError { status: s, message },
            s => JiraError::Unexpected { status: s, message },
        }
    }

    /// serde 실패를 `Decode`로. 어느 응답이었는지 `context`로 남긴다.
    pub fn decode(context: &str, err: impl fmt::Display) -> Self {
        JiraError::Decode {
            message: format!("{context}: {err}"),
        }
    }
}

impl fmt::Display for JiraError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JiraError::Unauthorized { message } => write!(f, "인증 실패 (401): {message}"),
            JiraError::Forbidden { message } => write!(f, "권한 없음 (403): {message}"),
            JiraError::NotFound { message } => write!(f, "찾을 수 없음 (404): {message}"),
            JiraError::BadRequest { message } => write!(f, "잘못된 요청 (400): {message}"),
            JiraError::RateLimited {
                message,
                retry_after_secs,
            } => match retry_after_secs {
                Some(s) => write!(f, "요청 한도 초과 (429), {s}초 후 재시도: {message}"),
                None => write!(f, "요청 한도 초과 (429): {message}"),
            },
            JiraError::ServerError { status, message } => {
                write!(f, "Jira 서버 오류 ({status}): {message}")
            }
            JiraError::Network { message } => write!(f, "네트워크 오류: {message}"),
            JiraError::Decode { message } => write!(f, "응답 해석 실패: {message}"),
            JiraError::Unexpected { status, message } => {
                write!(f, "예기치 않은 응답 ({status}): {message}")
            }
        }
    }
}

impl std::error::Error for JiraError {}

impl From<reqwest::Error> for JiraError {
    fn from(err: reqwest::Error) -> Self {
        // 본문을 다 읽지 못한 채 끊긴 디코드 실패도 여기로 온다.
        // 이런 경우는 "우리 타입이 틀림"이 아니라 전송 실패이므로 Network(일시적)가 맞다.
        if err.is_timeout() || err.is_connect() || err.is_request() || err.is_body() {
            return JiraError::Network {
                message: sanitize(&err.to_string()),
            };
        }
        if err.is_decode() {
            return JiraError::Decode {
                message: sanitize(&err.to_string()),
            };
        }
        if let Some(status) = err.status() {
            return JiraError::from_response(status.as_u16(), &err.to_string(), None);
        }
        JiraError::Network {
            message: sanitize(&err.to_string()),
        }
    }
}

/// 로그·에러 메시지에 URL이 섞여 나올 때 자격증명이 딸려가지 않게 지운다.
/// (`https://user:token@host` 형태 — reqwest 에러 문자열에 URL이 포함된다)
fn sanitize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(scheme_at) = rest.find("://") {
        let after_scheme = scheme_at + 3;
        // 이 URL의 authority 구간 끝
        let authority_end = rest[after_scheme..]
            .find(['/', '?', '#', ' ', '"'])
            .map(|i| after_scheme + i)
            .unwrap_or(rest.len());
        let authority = &rest[after_scheme..authority_end];
        if let Some(at) = authority.rfind('@') {
            out.push_str(&rest[..after_scheme]);
            out.push_str("***@");
            out.push_str(&authority[at + 1..]);
        } else {
            out.push_str(&rest[..authority_end]);
        }
        rest = &rest[authority_end..];
    }
    out.push_str(rest);
    out
}

/// Jira 표준 에러 봉투에서 사람이 읽을 텍스트를 뽑는다.
///
/// ```json
/// { "errorMessages": ["Field 'foo' does not exist..."], "errors": {} }
/// { "errorMessages": [], "errors": { "summary": "You must specify a summary." } }
/// ```
///
/// **원문을 손대지 않는다.** 여러 개면 줄바꿈으로 잇기만 한다.
fn extract_jira_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let mut parts: Vec<String> = Vec::new();

    if let Some(arr) = value.get("errorMessages").and_then(|v| v.as_array()) {
        parts.extend(arr.iter().filter_map(|v| v.as_str()).map(str::to_owned));
    }

    if let Some(map) = value.get("errors").and_then(|v| v.as_object()) {
        // 필드별 오류는 순서가 보장되지 않으므로 정렬해 결정적으로 만든다.
        let mut entries: Vec<(&String, &serde_json::Value)> = map.iter().collect();
        entries.sort_by_key(|(k, _)| k.as_str());
        for (field, msg) in entries {
            if let Some(text) = msg.as_str() {
                parts.push(format!("{field}: {text}"));
            }
        }
    }

    // 일부 엔드포인트(특히 게이트웨이 레벨)는 `message` 하나만 준다.
    if parts.is_empty() {
        if let Some(text) = value.get("message").and_then(|v| v.as_str()) {
            parts.push(text.to_owned());
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

/// 최대 본문 길이. HTML 에러 페이지가 통째로 UI에 쏟아지지 않게 자른다.
const MAX_FALLBACK_BODY: usize = 500;

fn fallback_message(status: u16, body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return format!("HTTP {status} (본문 없음)");
    }
    // char 경계에서 자른다 — 한글 본문에서 byte slicing은 패닉을 낸다.
    let truncated: String = trimmed.chars().take(MAX_FALLBACK_BODY).collect();
    if trimmed.chars().count() > MAX_FALLBACK_BODY {
        format!("{truncated}…")
    } else {
        truncated
    }
}

/// `Retry-After` 헤더 파싱. Jira는 초 단위 정수를 보낸다.
///
/// RFC 7231은 HTTP-date 형식도 허용하지만 Atlassian Cloud는 초를 쓴다.
/// 파싱에 실패하면 `None`을 반환해 호출자의 기본 백오프로 넘긴다.
pub fn parse_retry_after(raw: &str) -> Option<u64> {
    raw.trim().parse::<u64>().ok()
}

#[cfg(test)]
#[path = "tests/error_tests.rs"]
mod error_tests;
