//! 파일 로그.
//!
//! 사용자가 코드를 읽지 않으므로, "어젯밤 뭔가 실패했는데 지금은 정상"을
//! 추적할 수 있는 유일한 수단이다. 토큰 마스킹은 선택이 아니라 필수.

use std::path::Path;
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

static GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// `~/Library/Logs/my-pegboard/` 에 일 단위 회전 로그를 남긴다.
pub fn init(log_dir: &Path) {
    if GUARD.get().is_some() {
        return;
    }

    if let Err(e) = std::fs::create_dir_all(log_dir) {
        eprintln!("로그 디렉토리 생성 실패: {e}");
        return;
    }

    let appender = tracing_appender::rolling::daily(log_dir, "my-pegboard.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let _ = GUARD.set(guard);

    let filter = EnvFilter::try_from_env("MY_PEGBOARD_LOG")
        .unwrap_or_else(|_| EnvFilter::new("my_pegboard_lib=info,warn"));

    let file_layer = fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(true);

    let registry = tracing_subscriber::registry().with(filter).with(file_layer);

    // 개발 중에는 터미널에도 함께 출력
    #[cfg(debug_assertions)]
    let registry = registry.with(fmt::layer().with_target(false));

    if registry.try_init().is_err() {
        eprintln!("로그 초기화 중복 호출");
    }
}

/// 비밀값을 로그에 남길 때 쓰는 마스킹.
///
/// 앞 3자 + 뒤 3자만 남긴다. 짧은 값은 통째로 가린다 —
/// 짧은 토큰일수록 일부만 노출돼도 위험하다.
pub fn mask(secret: &str) -> String {
    let n = secret.chars().count();
    if n <= 8 {
        return "*".repeat(n.max(3));
    }
    let head: String = secret.chars().take(3).collect();
    let tail: String = secret.chars().skip(n - 3).collect();
    format!("{head}***{tail}")
}

#[cfg(test)]
mod tests {
    use super::mask;

    #[test]
    fn masks_long_secret_keeping_only_edges() {
        assert_eq!(mask("ATATT3xFfGF0abcdefg123"), "ATA***123");
    }

    #[test]
    fn hides_short_secret_entirely() {
        assert_eq!(mask("abc12345"), "********");
        assert_eq!(mask("ab"), "***");
    }

    #[test]
    fn never_leaks_full_secret() {
        let secret = "super-secret-token-value";
        let masked = mask(secret);
        assert!(!masked.contains("secret-token"));
        assert!(masked.len() < secret.len());
    }
}
