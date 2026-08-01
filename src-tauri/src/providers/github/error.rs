//! GitHub 에러 분류 (DECISIONS 16장).
//!
//! Jira의 `error.rs`와 같은 축(재시도 가능/불가)을 쓰되, **GraphQL 때문에
//! 하나가 다르다.**
//!
//! # GraphQL은 실패해도 200을 준다
//!
//! REST는 상태 코드로 실패를 말하지만 GraphQL은 `200 OK` 본문에 `errors` 배열을
//! 실어 보낸다. 상태 코드만 보면 **전부 성공으로 보인다.** 그래서 이 모듈은
//! 본문의 `errors`도 분류 대상으로 삼는다.
//!
//! | 실패 | 성격 | 처리 |
//! |---|---|---|
//! | 401 토큰 만료/오입력 | 영구 | 전역 배너 + [설정 열기] |
//! | 403 + rate limit 헤더 | 일시 | 백오프 (GitHub은 429 대신 403을 쓰기도 한다) |
//! | 403 그 외 (SSO 미인증 등) | 영구 | 위젯 에러 + 안내 |
//! | 429 | 일시 | 백오프 (`Retry-After` 존중) |
//! | 5xx | 일시 | 백오프 |
//! | 네트워크/타임아웃 | 일시 | 백오프 |
//! | GraphQL `errors` | 대부분 영구 | 원문 메시지 그대로 |
//!
//! GitHub의 에러 메시지는 Jira와 마찬가지로 **가공하지 않는다.** 검색 문법
//! 오류에 대한 GitHub 메시지는 구체적이고, 우리가 다시 쓰면 나빠지기만 한다.

use serde::{Deserialize, Serialize};
use std::fmt;

/// 재시도 정책을 결정하는 단 하나의 축. Jira와 같은 의미다.
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
/// `rename_all`이 enum과 필드 양쪽에 필요한 이유는 Jira 쪽 주석에 적어뒀다 —
/// enum의 `rename_all`은 variant 이름만 바꾸고, 필드는 `rename_all_fields`가
/// 따로 담당한다. 빠뜨리면 `retryAfterSecs`가 조용히 사라진다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GithubError {
    /// 401. 토큰이 없거나 만료됐거나 틀렸다. 전역 배너 1회.
    Unauthorized { message: String },

    /// 403 중 rate limit이 아닌 것. **SSO 미인증이 여기로 온다.**
    ///
    /// 조직이 SAML SSO를 걸어두면 토큰을 따로 authorize해야 하는데, 그 전까지
    /// 해당 조직 리소스가 403이거나 아예 목록에서 빠진다. `message`에 GitHub
    /// 원문을 담아 사용자가 무엇을 해야 하는지 알 수 있게 한다.
    Forbidden { message: String },

    /// 404. 없거나, 있어도 볼 권한이 없어 GitHub이 숨긴 경우.
    NotFound { message: String },

    /// 검색 문법 오류 등. `message`는 **GitHub 원문 그대로**.
    BadRequest { message: String },

    /// rate limit. GitHub은 429뿐 아니라 **403 + `x-ratelimit-remaining: 0`**
    /// 조합으로도 알린다. 둘 다 여기로 모은다.
    RateLimited {
        message: String,
        retry_after_secs: Option<u64>,
    },

    /// 5xx.
    ServerError { status: u16, message: String },

    /// 연결 실패·DNS·TLS·타임아웃.
    Network { message: String },

    /// 200 + `errors` 배열. GraphQL 고유의 실패 경로다.
    ///
    /// **영구로 분류한다** — 쿼리가 잘못됐거나 스키마가 바뀐 것이므로 다시
    /// 보내도 같은 자리에서 깨진다. (rate limit만은 예외라 위에서 걸러낸다.)
    GraphqlErrors { message: String },

    /// 200을 받았지만 우리가 기대한 모양이 아님.
    ///
    /// 영구다. 조용히 넘기지 않는 것이 중요하다(CLAUDE.md "조용한 실패 금지").
    Decode { message: String },

    /// 위 어디에도 안 들어가는 HTTP 상태.
    Unexpected { status: u16, message: String },
}

impl GithubError {
    /// 재시도 여부.
    pub fn kind(&self) -> ErrorKind {
        match self {
            GithubError::RateLimited { .. }
            | GithubError::ServerError { .. }
            | GithubError::Network { .. } => ErrorKind::Transient,
            GithubError::Unauthorized { .. }
            | GithubError::Forbidden { .. }
            | GithubError::NotFound { .. }
            | GithubError::BadRequest { .. }
            | GithubError::GraphqlErrors { .. }
            | GithubError::Decode { .. } => ErrorKind::Permanent,
            GithubError::Unexpected { status, .. } => {
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
        matches!(self, GithubError::Unauthorized { .. })
    }

    /// 429/403-rate-limit에 `Retry-After`가 실려 왔다면 그 값(초).
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            GithubError::RateLimited {
                retry_after_secs, ..
            } => *retry_after_secs,
            _ => None,
        }
    }

    /// 사용자에게 보여줄 메시지.
    pub fn message(&self) -> &str {
        match self {
            GithubError::Unauthorized { message }
            | GithubError::Forbidden { message }
            | GithubError::NotFound { message }
            | GithubError::BadRequest { message }
            | GithubError::RateLimited { message, .. }
            | GithubError::ServerError { message, .. }
            | GithubError::Network { message }
            | GithubError::GraphqlErrors { message }
            | GithubError::Decode { message }
            | GithubError::Unexpected { message, .. } => message,
        }
    }
}

impl fmt::Display for GithubError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message())
    }
}

impl std::error::Error for GithubError {}

/// HTTP 응답을 에러로 분류한다.
///
/// `remaining`은 `x-ratelimit-remaining` 헤더다. **403을 rate limit과
/// 권한 문제로 가르는 유일한 단서**라 인자로 받는다 — 이게 없으면 SSO 미인증을
/// 재시도하며 시간을 버린다.
pub fn classify_status(
    status: u16,
    message: String,
    retry_after_secs: Option<u64>,
    remaining: Option<u64>,
) -> GithubError {
    match status {
        401 => GithubError::Unauthorized { message },
        // GitHub은 rate limit에 403을 쓰기도 한다. remaining이 0이면 그 경우다.
        403 if remaining == Some(0) => GithubError::RateLimited {
            message,
            retry_after_secs,
        },
        403 => GithubError::Forbidden { message },
        404 => GithubError::NotFound { message },
        422 | 400 => GithubError::BadRequest { message },
        429 => GithubError::RateLimited {
            message,
            retry_after_secs,
        },
        500..=599 => GithubError::ServerError { status, message },
        _ => GithubError::Unexpected { status, message },
    }
}

pub type GithubResult<T> = Result<T, GithubError>;
