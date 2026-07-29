//! Storage tests.
//!
//! CLAUDE.md: "Rust와 상태 관리는 테스트로 보장. 사용자가 안 보는 영역이므로
//! 조용히 깨지면 안 된다." The user never reads this code, so these tests are
//! the only thing standing between a logic error and silent data loss.

mod atomic_tests;
mod board_tests;
mod cache_tests;
mod migrate_tests;
mod todos_tests;
