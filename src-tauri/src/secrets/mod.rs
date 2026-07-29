//! Keychain-backed secret storage.
//!
//! DECISIONS 9 / CLAUDE.md 비밀:
//!
//! - 토큰·이메일은 **Keychain** (`keyring` crate).
//! - **평문 파일 금지, 폴백 금지.** 키체인이 실패하면 실패했다고 말한다.
//! - 로그에 토큰을 찍지 않는다. **마스킹 필수.**
//!
//! # No fallback
//!
//! There is deliberately no file-based path in this module. DECISIONS 9:
//! 폴백이 조용히 발동하면 사용자가 자기 토큰이 평문인 걸 모름. A keychain
//! failure surfaces as [`SecretError`]; it never downgrades to plaintext.
//!
//! # No leak through `Debug`
//!
//! [`Secret`] holds the plaintext and implements `Debug` by hand to print a
//! mask. `#[derive(Debug)]` is never used on a type holding a secret, so a
//! stray `tracing::debug!("{:?}", ...)` cannot dump a token into
//! `~/Library/Logs/my-pegboard/`. Reaching the real value requires the
//! explicit, greppable [`Secret::expose`].

use std::fmt;

use keyring::Entry;
use thiserror::Error;

/// The keychain service name. All entries live under this.
pub const SERVICE: &str = "io.mypegboard.app";

/// The only connection id today.
///
/// DECISIONS 15: 연결은 서비스당 1개, 단 구조는 대비. Keys are namespaced
/// `jira.default.token` from the start so multi-connection can arrive without
/// migrating anyone's keychain.
pub const DEFAULT_CONNECTION: &str = "default";

#[derive(Debug, Error)]
pub enum SecretError {
    /// The key exists in our namespace but has no value stored.
    #[error("no secret stored for {key}")]
    NotFound { key: String },

    /// The keychain itself failed. Surfaced, never worked around.
    #[error("keychain error for {key}: {source}")]
    Keychain {
        key: String,
        #[source]
        source: keyring::Error,
    },

    #[error("invalid secret key: {reason}")]
    InvalidKey { reason: String },
}

pub type SecretResult<T> = Result<T, SecretError>;

/// Which service a credential belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Service {
    Jira,
    Github,
}

impl Service {
    pub const fn as_str(self) -> &'static str {
        match self {
            Service::Jira => "jira",
            Service::Github => "github",
        }
    }
}

impl fmt::Display for Service {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Which credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Credential {
    Token,
    Email,
}

impl Credential {
    pub const fn as_str(self) -> &'static str {
        match self {
            Credential::Token => "token",
            Credential::Email => "email",
        }
    }
}

impl fmt::Display for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A namespaced keychain key: `jira.default.token`.
///
/// Constructing keys through this type rather than by formatting strings at
/// call sites keeps the namespace in one place, so adding a connection id later
/// is a change here and nowhere else.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SecretKey {
    pub service: Service,
    pub connection_id: String,
    pub credential: Credential,
}

impl SecretKey {
    pub fn new(
        service: Service,
        connection_id: impl Into<String>,
        credential: Credential,
    ) -> SecretResult<Self> {
        let connection_id = connection_id.into();

        // A connection id with a dot would make the key ambiguous to parse back.
        if connection_id.is_empty() {
            return Err(SecretError::InvalidKey {
                reason: "connection id must not be empty".to_string(),
            });
        }
        if connection_id.contains('.') {
            return Err(SecretError::InvalidKey {
                reason: format!("connection id {connection_id:?} must not contain '.'"),
            });
        }

        Ok(Self {
            service,
            connection_id,
            credential,
        })
    }

    /// Key for the single connection that exists today.
    pub fn default_connection(service: Service, credential: Credential) -> Self {
        Self {
            service,
            connection_id: DEFAULT_CONNECTION.to_string(),
            credential,
        }
    }

    pub fn jira_token() -> Self {
        Self::default_connection(Service::Jira, Credential::Token)
    }

    pub fn jira_email() -> Self {
        Self::default_connection(Service::Jira, Credential::Email)
    }

    pub fn github_token() -> Self {
        Self::default_connection(Service::Github, Credential::Token)
    }

    /// The wire form: `jira.default.token`.
    pub fn as_string(&self) -> String {
        format!(
            "{}.{}.{}",
            self.service, self.connection_id, self.credential
        )
    }
}

impl fmt::Display for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.as_string())
    }
}

/// A secret value that will not print itself.
///
/// `Debug` and `Display` both render the mask. The plaintext leaves only
/// through [`expose`](Secret::expose).
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The real value. Deliberately verbose so `grep expose()` finds every
    /// place a secret escapes — use it at the HTTP boundary, never in a log.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Masked form for logs: `abc***xyz`.
    pub fn masked(&self) -> String {
        mask(&self.0)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

/// Prints the mask, never the value.
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Secret({})", self.masked())
    }
}

/// Also masked — `{}` in a log line is at least as likely as `{:?}`.
impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.masked())
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

/// Mask a secret for logging: `abc***xyz`.
///
/// Keeps 3 leading and 3 trailing characters so a user can confirm *which*
/// token is in play when diagnosing a 401, without the log being enough to
/// authenticate with.
///
/// Short values are fully masked rather than partially revealed — showing
/// `ab***ab` of a 4-character value would give away most of it.
pub fn mask(value: &str) -> String {
    const KEEP: usize = 3;
    const MASK: &str = "***";

    // Count by chars, not bytes: a token is ASCII but an email need not be,
    // and slicing a multi-byte char at a byte index would panic.
    let chars: Vec<char> = value.chars().collect();

    if chars.is_empty() {
        return String::new();
    }

    // Need more than both windows for a partial mask to hide anything.
    if chars.len() <= KEEP * 2 {
        return MASK.to_string();
    }

    let head: String = chars[..KEEP].iter().collect();
    let tail: String = chars[chars.len() - KEEP..].iter().collect();
    format!("{head}{MASK}{tail}")
}

/// Keychain-backed store.
///
/// Thin by design. There is no in-memory cache of secrets: holding tokens in
/// process memory longer than needed widens the blast radius of a crash dump,
/// and keychain reads happen only when building a request.
///
/// Manual `Debug` — even though no secret is held, deriving it here would
/// invite someone to add a cache field later and silently start logging tokens.
pub struct SecretStore {
    service: String,
}

impl fmt::Debug for SecretStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretStore")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore {
    pub fn new() -> Self {
        Self {
            service: SERVICE.to_string(),
        }
    }

    /// Store under a different keychain service name.
    ///
    /// Exists so tests can isolate themselves from the real app namespace.
    pub fn with_service(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    fn entry(&self, key: &SecretKey) -> SecretResult<Entry> {
        Entry::new(&self.service, &key.as_string()).map_err(|source| SecretError::Keychain {
            key: key.as_string(),
            source,
        })
    }

    /// Read a secret. `Ok(None)` when absent — an unconfigured connection is a
    /// normal state, and the settings UI needs to distinguish it from a
    /// keychain that is genuinely broken.
    pub fn get(&self, key: &SecretKey) -> SecretResult<Option<Secret>> {
        let entry = self.entry(key)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(Secret::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(source) => Err(SecretError::Keychain {
                key: key.as_string(),
                source,
            }),
        }
    }

    /// Read a secret, erroring when absent.
    pub fn require(&self, key: &SecretKey) -> SecretResult<Secret> {
        self.get(key)?.ok_or_else(|| SecretError::NotFound {
            key: key.as_string(),
        })
    }

    /// Write a secret, replacing any existing value.
    pub fn set(&self, key: &SecretKey, value: &Secret) -> SecretResult<()> {
        let entry = self.entry(key)?;
        entry
            .set_password(value.expose())
            .map_err(|source| SecretError::Keychain {
                key: key.as_string(),
                source,
            })
    }

    /// Delete a secret. Idempotent — deleting an absent secret succeeds, so
    /// "disconnect" works regardless of prior state.
    pub fn delete(&self, key: &SecretKey) -> SecretResult<()> {
        let entry = self.entry(key)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(source) => Err(SecretError::Keychain {
                key: key.as_string(),
                source,
            }),
        }
    }

    /// Whether a secret is present. Used by settings to show connection state
    /// without pulling the value into memory.
    pub fn has(&self, key: &SecretKey) -> SecretResult<bool> {
        Ok(self.get(key)?.is_some())
    }

    /// Remove every credential for a connection.
    ///
    /// Best-effort across all credential kinds: a partial failure still tries
    /// the rest, so a "disconnect" cannot leave a token behind because the
    /// email entry errored first.
    pub fn delete_connection(&self, service: Service, connection_id: &str) -> SecretResult<()> {
        let mut first_error = None;

        for credential in [Credential::Token, Credential::Email] {
            let key = SecretKey::new(service, connection_id, credential)?;
            if let Err(err) = self.delete(&key) {
                first_error.get_or_insert(err);
            }
        }

        match first_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure tests — no keychain access. Always run.

    #[test]
    fn mask_keeps_three_each_side() {
        assert_eq!(mask("abcdefghijklmnop"), "abc***nop");
    }

    #[test]
    fn mask_hides_short_values_entirely() {
        // A partial mask of a short value would reveal most of it.
        assert_eq!(mask("abcdef"), "***");
        assert_eq!(mask("abc"), "***");
        assert_eq!(mask("a"), "***");
    }

    #[test]
    fn mask_of_empty_is_empty() {
        assert_eq!(mask(""), "");
    }

    #[test]
    fn mask_handles_multibyte_without_panicking() {
        // Byte-index slicing would panic here.
        let masked = mask("한국어이메일주소@example.com");
        assert!(!masked.contains("이메일"));
        assert!(masked.contains("***"));
    }

    #[test]
    fn mask_of_realistic_token_reveals_little() {
        let token = "ATATT3xFfGF0T4JqOaBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890";
        let masked = mask(token);
        assert_eq!(masked, "ATA***890");
        assert!(!masked.contains("FfGF0T4JqOaBcDeFgHiJkLmNoPqRsTuVwXyZ"));
    }

    #[test]
    fn debug_never_reveals_secret() {
        let secret = Secret::new("super-secret-token-value");
        let rendered = format!("{secret:?}");
        assert!(
            !rendered.contains("super-secret-token-value"),
            "Debug leaked the secret: {rendered}"
        );
        assert!(!rendered.contains("secret-token"), "leaked: {rendered}");
        assert_eq!(rendered, "Secret(sup***lue)");
    }

    #[test]
    fn display_never_reveals_secret() {
        let secret = Secret::new("super-secret-token-value");
        let rendered = format!("{secret}");
        assert!(!rendered.contains("super-secret-token-value"));
        assert_eq!(rendered, "sup***lue");
    }

    #[test]
    fn debug_of_short_secret_is_fully_masked() {
        let secret = Secret::new("abc");
        assert_eq!(format!("{secret:?}"), "Secret(***)");
    }

    #[test]
    fn debug_of_containers_holding_secret_does_not_leak() {
        // The realistic leak: a secret nested in a derived-Debug struct.
        #[derive(Debug)]
        struct Config {
            // Present so the secret sits among ordinary fields, as it would in
            // a real config struct. Only ever read via the derived Debug.
            #[allow(dead_code)]
            email: String,
            token: Secret,
        }

        let config = Config {
            email: "user@example.com".to_string(),
            token: Secret::new("super-secret-token-value"),
        };

        let rendered = format!("{config:?}");
        assert!(
            !rendered.contains("super-secret-token-value"),
            "nested Debug leaked: {rendered}"
        );

        // Same through Option, Vec, and Result.
        assert!(!format!("{:?}", Some(config.token.clone())).contains("super-secret-token-value"));
        assert!(!format!("{:?}", vec![config.token.clone()]).contains("super-secret-token-value"));
        let as_result: Result<Secret, ()> = Ok(config.token.clone());
        assert!(!format!("{as_result:?}").contains("super-secret-token-value"));
    }

    #[test]
    fn expose_returns_the_real_value() {
        // The one sanctioned way out.
        let secret = Secret::new("super-secret-token-value");
        assert_eq!(secret.expose(), "super-secret-token-value");
    }

    #[test]
    fn secret_store_debug_is_safe() {
        let store = SecretStore::new();
        let rendered = format!("{store:?}");
        assert!(rendered.contains("SecretStore"));
        assert!(rendered.contains(SERVICE));
    }

    #[test]
    fn key_namespace_matches_decisions() {
        // DECISIONS 9: 네임스페이스 `jira.default.token` 형태.
        assert_eq!(SecretKey::jira_token().as_string(), "jira.default.token");
        assert_eq!(SecretKey::jira_email().as_string(), "jira.default.email");
        assert_eq!(
            SecretKey::github_token().as_string(),
            "github.default.token"
        );
    }

    #[test]
    fn key_supports_future_connection_ids() {
        // DECISIONS 15: multi-connection must not need a keychain migration.
        let key = SecretKey::new(Service::Jira, "work", Credential::Token).unwrap();
        assert_eq!(key.as_string(), "jira.work.token");
    }

    #[test]
    fn key_rejects_ambiguous_connection_ids() {
        assert!(SecretKey::new(Service::Jira, "", Credential::Token).is_err());
        assert!(SecretKey::new(Service::Jira, "a.b", Credential::Token).is_err());
    }

    /// Guards DECISIONS 9 against a future "temporary" plaintext fallback.
    ///
    /// Checks the module's `use` declarations rather than grepping the whole
    /// source, so the prose explaining *why* there is no filesystem access
    /// cannot trip it. Anything that writes a secret to disk needs an import
    /// from one of these paths, and adding one makes this fail.
    #[test]
    fn secrets_module_imports_nothing_from_the_filesystem() {
        let source = include_str!("mod.rs");

        // Only the pre-test portion: test helpers legitimately use tempfiles.
        let code = source
            .split("#[cfg(test)]")
            .next()
            .expect("module always has a non-test portion");

        let imports: Vec<&str> = code
            .lines()
            .map(str::trim_start)
            .filter(|line| line.starts_with("use "))
            .collect();

        assert!(!imports.is_empty(), "sanity: imports should be found");

        for import in &imports {
            for forbidden in ["std::fs", "std::path", "std::io", "crate::storage"] {
                assert!(
                    !import.contains(forbidden),
                    "secrets must never touch the filesystem — DECISIONS 9 \
                     forbids a plaintext fallback, but found: {import}"
                );
            }
        }
    }

    // Keychain tests write to the real macOS login keychain, so they are
    // gated. CI never enables this feature.
    //
    //     cargo test --features keychain-tests
    #[cfg(feature = "keychain-tests")]
    mod keychain {
        use super::*;

        fn test_store() -> SecretStore {
            // Separate service name so a failed run cannot clobber real creds.
            SecretStore::with_service("io.mypegboard.app.test")
        }

        #[test]
        fn roundtrip_set_get_delete() {
            let store = test_store();
            let key = SecretKey::new(Service::Jira, "testconn", Credential::Token).unwrap();

            let _ = store.delete(&key);

            assert!(store.get(&key).unwrap().is_none());

            store.set(&key, &Secret::new("test-token-value")).unwrap();
            assert_eq!(store.require(&key).unwrap().expose(), "test-token-value");
            assert!(store.has(&key).unwrap());

            store.set(&key, &Secret::new("replaced")).unwrap();
            assert_eq!(store.require(&key).unwrap().expose(), "replaced");

            store.delete(&key).unwrap();
            assert!(store.get(&key).unwrap().is_none());
            // Idempotent.
            store.delete(&key).unwrap();
        }

        #[test]
        fn require_errors_when_absent() {
            let store = test_store();
            let key = SecretKey::new(Service::Github, "absentconn", Credential::Token).unwrap();
            let _ = store.delete(&key);
            assert!(matches!(
                store.require(&key),
                Err(SecretError::NotFound { .. })
            ));
        }
    }
}
