//! Storage and secrets layer for my-pegboard.
//!
//! Two independent concerns, deliberately not sharing an error type:
//!
//! - [`storage`] — JSON files under the app data directory. Atomic writes,
//!   schema versioning, corrupt-file recovery, per-widget disk cache.
//! - [`secrets`] — macOS Keychain. No plaintext fallback, no leak via `Debug`.
//!
//! DECISIONS 9 keeps these apart so that copying a config file (or committing
//! one) can never carry a token with it. The split is enforced structurally:
//! the secrets module touches no filesystem path at all, and a test asserts it.
//!
//! Both take their location as a parameter — `base_dir` for storage, a service
//! name for secrets — so nothing here depends on a running Tauri app and every
//! test can point at a tempdir.

pub mod secrets;
pub mod storage;
