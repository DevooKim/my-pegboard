//! 외부 서비스 provider. 위젯 하나 = provider 하나.
//!
//! 각 provider는 자기 API 클라이언트·타입·에러 분류를 소유하고,
//! 캐시·스케줄링·비밀 관리는 소유하지 않는다.

pub mod github;
pub mod jira;
