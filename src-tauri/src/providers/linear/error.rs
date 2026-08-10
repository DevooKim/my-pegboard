//! Linear 에러 분류 (DECISIONS 16장 / 25.4).
//!
//! Jira·GitHub의 `error.rs`와 같은 축(재시도 가능/불가)을 쓴다. 다만 **Linear에는
//! 이 앱이 처음 만나는 함정이 하나 있다.**
//!
//! # ★ rate limit이 HTTP 400으로 온다
//!
//! | 서비스 | rate limit 신호 |
//! |---|---|
//! | Jira | 429 |
//! | GitHub | 429 **또는** 403 + `x-ratelimit-remaining: 0` |
//! | **Linear** | **400** + 본문 `errors[].extensions.code == "RATELIMITED"` |
//!
//! 이 앱은 400을 **영구**로 분류한다(JQL 문법 오류·잘못된 쿼리가 거기 오기 때문).
//! Linear에 그 규칙을 그대로 적용하면 **rate limit이 "재시도 없는 영구 실패"가 된다.**
//! 목록이 한 번 죽으면 사용자가 새로고침을 누를 때까지 살아나지 않는다.
//!
//! 그래서 [`classify_status`]는 400을 만나면 **본문을 먼저 본다.** rate limit이면
//! [`LinearError::RateLimited`](일시적), 아니면 [`LinearError::BadRequest`](영구)다.
//!
//! # GraphQL은 실패해도 200을 준다
//!
//! GitHub과 같은 함정이다. `200 OK` 본문에 `errors` 배열이 실려 온다 — 상태 코드만
//! 보면 전부 성공으로 보인다. 200 본문의 `errors`도 분류 대상이며, 거기에도
//! `RATELIMITED`가 올 수 있다(문서 기준. 실측하지 못했다 — 25.7의 미검증 목록).
//!
//! | 실패 | 성격 | 처리 |
//! |---|---|---|
//! | 401 키 만료/오입력 | 영구 | 전역 배너 + [설정 열기] |
//! | 403 | 영구 | 위젯 에러 + 안내 |
//! | **400 + RATELIMITED** | **일시** | 백오프 |
//! | 400 그 외 (쿼리 오류) | 영구 | **Linear 원문 그대로** |
//! | 429 | 일시 | 백오프 (문서에 없지만 방어) |
//! | 5xx | 일시 | 백오프 |
//! | 네트워크/타임아웃 | 일시 | 백오프 |
//! | GraphQL `errors` | 대부분 영구 | 원문 그대로. RATELIMITED만 일시 |
//!
//! Linear의 에러 메시지는 Jira·GitHub과 마찬가지로 **가공하지 않는다.**

use serde::{Deserialize, Serialize};
use std::fmt;

/// GraphQL 확장 코드 중 rate limit을 뜻하는 값.
///
/// **문자열 하나에 재시도 정책이 걸려 있다.** 이 상수를 지우거나 오타를 내면
/// rate limit이 영구 실패로 떨어지고, 사용자는 "목록이 안 살아난다"만 겪는다.
pub const RATELIMITED_CODE: &str = "RATELIMITED";

/// 재시도 정책을 결정하는 단 하나의 축. Jira·GitHub과 같은 의미다.
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
/// `rename_all`이 enum과 필드 양쪽에 필요한 이유는 Jira 쪽 주석에 적혀 있다 —
/// enum의 `rename_all`은 variant 이름만 바꾸고, 필드는 `rename_all_fields`가
/// 따로 담당한다. 빠뜨리면 `retryAfterSecs`가 조용히 사라진다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LinearError {
    /// 401. API 키가 없거나 철회됐거나 틀렸다. 전역 배너 1회.
    ///
    /// **`Bearer` 접두사를 붙이면 여기로 온다.** Linear는 `Authorization: <키>`를
    /// 그대로 받는다 — GitHub과 다르다(25.2).
    Unauthorized { message: String },

    /// 403. 인증은 됐지만 이 리소스에 권한이 없다.
    Forbidden { message: String },

    /// 404.
    NotFound { message: String },

    /// 400 중 rate limit이 아닌 것. 쿼리·필터 오류 등.
    /// `message`는 **Linear 원문 그대로**.
    BadRequest { message: String },

    /// rate limit. **Linear는 이것을 HTTP 400으로 보낸다** — 이 모듈 문서 참조.
    ///
    /// `reset_at_ms`는 `X-RateLimit-*-Reset` 헤더(UTC epoch **밀리초**).
    /// `Retry-After`가 아니라서 초로 환산해 `retry_after_secs`에 담는다.
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
    /// 보내도 같은 자리에서 깨진다. (RATELIMITED만은 예외라 위에서 걸러낸다.)
    GraphqlErrors { message: String },

    /// 200을 받았지만 우리가 기대한 모양이 아님.
    ///
    /// 영구다. 조용히 넘기지 않는 것이 중요하다(CLAUDE.md "조용한 실패 금지").
    Decode { message: String },

    /// 위 어디에도 안 들어가는 HTTP 상태.
    Unexpected { status: u16, message: String },
}

impl LinearError {
    /// 재시도 여부. 이 앱에서 이 함수보다 중요한 분기는 거의 없다.
    pub fn kind(&self) -> ErrorKind {
        match self {
            LinearError::RateLimited { .. }
            | LinearError::ServerError { .. }
            | LinearError::Network { .. } => ErrorKind::Transient,
            LinearError::Unauthorized { .. }
            | LinearError::Forbidden { .. }
            | LinearError::NotFound { .. }
            | LinearError::BadRequest { .. }
            | LinearError::GraphqlErrors { .. }
            | LinearError::Decode { .. } => ErrorKind::Permanent,
            LinearError::Unexpected { status, .. } => {
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

    /// Mutation 요청을 보낸 뒤 생성 여부를 확정할 수 없는 실패인가.
    ///
    /// 네트워크·5xx만 true다. rate limit은 서버가 요청을 명시적으로 거절한
    /// 응답이므로 중복 생성 경고를 띄우지 않는다.
    pub fn possibly_created(&self) -> bool {
        matches!(self, Self::Network { .. } | Self::ServerError { .. })
    }

    /// 401 전용 판별. "인증 실패는 전역 배너 한 번만" 규칙의 트리거.
    pub fn is_auth_failure(&self) -> bool {
        matches!(self, LinearError::Unauthorized { .. })
    }

    /// rate limit에 리셋 시각이 실려 왔다면 그때까지 남은 초.
    pub fn retry_after_secs(&self) -> Option<u64> {
        match self {
            LinearError::RateLimited {
                retry_after_secs, ..
            } => *retry_after_secs,
            _ => None,
        }
    }

    /// 사용자에게 보여줄 메시지.
    pub fn message(&self) -> &str {
        match self {
            LinearError::Unauthorized { message }
            | LinearError::Forbidden { message }
            | LinearError::NotFound { message }
            | LinearError::BadRequest { message }
            | LinearError::RateLimited { message, .. }
            | LinearError::ServerError { message, .. }
            | LinearError::Network { message }
            | LinearError::GraphqlErrors { message }
            | LinearError::Decode { message }
            | LinearError::Unexpected { message, .. } => message,
        }
    }
}

impl fmt::Display for LinearError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message())
    }
}

impl std::error::Error for LinearError {}

/// HTTP 응답을 에러로 분류한다.
///
/// # ★ `body`를 받는 이유
///
/// **400이 rate limit일 수 있다.** GitHub에서 403이 그랬던 것과 같은 구조이고,
/// 거기서는 헤더(`x-ratelimit-remaining`)가 단서였지만 Linear는 **본문**에 있다
/// (`errors[].extensions.code == "RATELIMITED"`). 상태 코드만 보고 분류하면
/// rate limit을 영구 실패로 만든다.
///
/// `reset_at_ms`는 `X-RateLimit-*-Reset` 헤더(UTC epoch 밀리초). `now_ms`와의
/// 차이를 초로 환산해 넣는다 — 인자로 받는 이유는 테스트가 시계를 고정할 수 있어야
/// 하기 때문이다.
pub fn classify_status(
    status: u16,
    message: String,
    body: &str,
    reset_at_ms: Option<u64>,
    now_ms: u64,
) -> LinearError {
    let retry_after_secs = reset_at_ms.map(|reset| reset.saturating_sub(now_ms) / 1000);

    match status {
        401 => LinearError::Unauthorized { message },
        403 => LinearError::Forbidden { message },
        404 => LinearError::NotFound { message },
        // ★ 이 한 줄이 이 모듈의 존재 이유다. 본문을 안 보면 rate limit이
        //   "재시도 없는 영구 실패"가 된다.
        400 if body_says_rate_limited(body) => LinearError::RateLimited {
            message,
            retry_after_secs,
        },
        400 | 422 => LinearError::BadRequest { message },
        // 문서에는 400만 적혀 있지만 429도 막아둔다. 프록시·게이트웨이가
        // 끼면 표준 코드로 바뀌어 올 수 있다.
        429 => LinearError::RateLimited {
            message,
            retry_after_secs,
        },
        500..=599 => LinearError::ServerError { status, message },
        _ => LinearError::Unexpected { status, message },
    }
}

/// 본문이 rate limit을 말하는가.
///
/// `extensions.code`를 정확히 파싱하는 것이 우선이고, 파싱이 실패하면 원문에
/// 코드 문자열이 있는지 본다 — 응답 모양이 문서와 달라도 **rate limit을 놓치지
/// 않는 쪽**으로 기운다. 놓치면 영구 실패가 되고, 과하게 잡으면 재시도 한 번이다.
/// 비용이 대칭이 아니다.
pub fn body_says_rate_limited(body: &str) -> bool {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(errors) = value.get("errors").and_then(|e| e.as_array()) {
            let coded = errors.iter().any(|e| {
                e.get("extensions")
                    .and_then(|x| x.get("code"))
                    .and_then(|c| c.as_str())
                    .is_some_and(|c| c.eq_ignore_ascii_case(RATELIMITED_CODE))
            });
            if coded {
                return true;
            }
        }
    }
    // 파싱 실패 또는 코드가 다른 자리에 있는 경우.
    body.contains(RATELIMITED_CODE)
}

pub type LinearResult<T> = Result<T, LinearError>;
