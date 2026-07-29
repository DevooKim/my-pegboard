//! Migration, corruption recovery, and version-gate tests.
//!
//! DECISIONS 10 (필수 안전장치 3): 스키마 버전.
//! The governing rule for every case here: never silently discard user data.

use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tempfile::TempDir;

use crate::storage::board::BoardStore;
use crate::storage::error::StorageError;
use crate::storage::migrate::{load_or_default, LoadOutcome, Migration, MigrationSet};

/// A toy schema with a real v1→v2 migration, to exercise the framework the
/// shipping stores do not use yet.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
struct Doc {
    version: u32,
    #[serde(default)]
    name: String,
    #[serde(default)]
    items: Vec<String>,
}

fn rename_title_to_name(mut value: Value) -> Result<Value, String> {
    let obj = value.as_object_mut().ok_or("expected an object")?;
    if let Some(title) = obj.remove("title") {
        obj.insert("name".to_string(), title);
    }
    Ok(value)
}

static V1_TO_V2: &[Migration] = &[Migration {
    from: 1,
    to: 2,
    apply: rename_title_to_name,
}];

fn v2_set() -> MigrationSet {
    MigrationSet {
        current_version: 2,
        migrations: V1_TO_V2,
    }
}

static V1_TO_V3: &[Migration] = &[
    Migration {
        from: 1,
        to: 2,
        apply: rename_title_to_name,
    },
    Migration {
        from: 2,
        to: 3,
        apply: |mut value| {
            let obj = value.as_object_mut().ok_or("expected an object")?;
            obj.entry("items").or_insert_with(|| json!([]));
            Ok(value)
        },
    },
];

fn v3_set() -> MigrationSet {
    MigrationSet {
        current_version: 3,
        migrations: V1_TO_V3,
    }
}

fn v1_only_set() -> MigrationSet {
    MigrationSet {
        current_version: 1,
        migrations: &[],
    }
}

// ------------------------------------------------------------ missing file

#[test]
fn missing_file_returns_defaults_and_writes_nothing() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    let loaded = load_or_default::<Doc>(&path, &v1_only_set()).unwrap();

    assert_eq!(loaded.value, Doc::default());
    assert_eq!(loaded.outcome, LoadOutcome::Missing);
    assert!(!path.exists(), "loading must not create the file");
}

#[test]
fn empty_file_is_treated_as_missing_not_corrupt() {
    // A zero-byte file has nothing worth quarantining; making a .corrupt copy
    // of it would only litter the data directory.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");
    fs::write(&path, "   \n  ").unwrap();

    let loaded = load_or_default::<Doc>(&path, &v1_only_set()).unwrap();

    assert_eq!(loaded.outcome, LoadOutcome::Missing);
    assert!(!has_quarantine_file(dir.path()));
}

// -------------------------------------------------------------- corruption

/// DECISIONS: 절대 조용히 버리지 않는다.
#[test]
fn corrupt_json_is_preserved_not_destroyed() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    let bad = r#"{"version": 1, "name": "my board", TRUNCATED"#;
    fs::write(&path, bad).unwrap();

    let loaded = load_or_default::<Doc>(&path, &v1_only_set()).unwrap();

    // Defaults returned so the app can still start.
    assert_eq!(loaded.value, Doc::default());

    let LoadOutcome::Recovered { backup, reason } = loaded.outcome else {
        panic!("expected Recovered, got {:?}", loaded.outcome);
    };
    assert!(!reason.is_empty(), "caller needs something to show the user");

    // The original bytes survive, exactly.
    assert!(backup.exists());
    assert_eq!(fs::read_to_string(&backup).unwrap(), bad);

    let name = backup.file_name().unwrap().to_string_lossy();
    assert!(name.starts_with("doc.json.corrupt-"), "got {name}");
}

/// Structurally valid JSON that does not fit the target type is corruption too.
#[test]
fn type_mismatch_is_also_quarantined() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    // `items` should be an array of strings.
    let bad = r#"{"version": 1, "name": "board", "items": {"not": "an array"}}"#;
    fs::write(&path, bad).unwrap();

    let loaded = load_or_default::<Doc>(&path, &v1_only_set()).unwrap();

    assert_eq!(loaded.value, Doc::default());
    assert!(matches!(loaded.outcome, LoadOutcome::Recovered { .. }));
    assert_eq!(read_quarantine_file(dir.path()), bad);
}

/// Two corruptions in the same second must not clobber each other — the whole
/// point of quarantining is that nothing is lost.
#[test]
fn repeated_corruption_never_overwrites_an_earlier_quarantine() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    for n in 0..3 {
        fs::write(&path, format!("{{corrupt-{n}")).unwrap();
        let loaded = load_or_default::<Doc>(&path, &v1_only_set()).unwrap();
        assert!(matches!(loaded.outcome, LoadOutcome::Recovered { .. }));
    }

    let mut preserved: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().contains(".corrupt-"))
        .map(|p| fs::read_to_string(p).unwrap())
        .collect();
    preserved.sort();

    assert_eq!(
        preserved,
        vec!["{corrupt-0", "{corrupt-1", "{corrupt-2"],
        "an earlier quarantine was overwritten"
    );
}

#[test]
fn corrupt_board_json_recovers_to_a_usable_default_board() {
    // End to end through the real store: a mangled board.json must still let
    // the app start with a drawable board.
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("board.json"), "not json at all {[").unwrap();

    let (store, outcome) = BoardStore::load(dir.path()).unwrap();

    assert!(matches!(outcome, LoadOutcome::Recovered { .. }));
    assert_eq!(store.data().boards.len(), 1);
    assert_eq!(store.data().active_board().unwrap().id, "default");
    assert_eq!(read_quarantine_file(dir.path()), "not json at all {[");
}

// ---------------------------------------------------------- future version

/// DECISIONS 10: reading a newer file must fail loudly.
///
/// serde drops unknown fields silently, so without the version gate a v2 file
/// would parse fine here and the next save would write back a v1 file with the
/// v2 fields deleted — data loss with no error anywhere.
#[test]
fn future_version_is_rejected_loudly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    fs::write(
        &path,
        r#"{"version": 2, "name": "from a newer build", "futureField": "must not be lost"}"#,
    )
    .unwrap();

    let result = load_or_default::<Doc>(&path, &v1_only_set());

    let Err(StorageError::FutureVersion {
        found, supported, ..
    }) = result
    else {
        panic!("expected FutureVersion, got {result:?}");
    };
    assert_eq!(found, 2);
    assert_eq!(supported, 1);

    // Critically: the file is untouched. Not quarantined, not defaulted, not
    // rewritten. Opening the app with the newer build must still find it whole.
    let raw = fs::read_to_string(&path).unwrap();
    assert!(raw.contains("must not be lost"));
    assert!(!has_quarantine_file(dir.path()));
}

#[test]
fn future_version_error_message_tells_the_user_what_to_do() {
    // CLAUDE.md: 사용자는 코드를 읽지 않는다. The message is the whole UI here.
    let err = StorageError::FutureVersion {
        path: "/tmp/board.json".into(),
        found: 3,
        supported: 1,
    };
    let message = err.to_string();

    assert!(message.contains("board.json"));
    assert!(message.contains('3') && message.contains('1'));
    assert!(
        message.to_lowercase().contains("update"),
        "should say what to do: {message}"
    );
}

/// A version number past `u32::MAX` must not wrap into a *lower* version.
///
/// `as u32` truncation would turn 2^32 into 0, so the gate would see an older
/// schema and quietly run migrations across a file from the future.
#[test]
fn an_absurdly_large_version_still_fails_loudly() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    // 2^32 — truncates to 0 under `as u32`.
    fs::write(
        &path,
        r#"{"version": 4294967296, "name": "x", "futureField": "must not be lost"}"#,
    )
    .unwrap();

    assert!(
        matches!(
            load_or_default::<Doc>(&path, &v1_only_set()),
            Err(StorageError::FutureVersion { .. })
        ),
        "a wrapped version was treated as an old schema"
    );

    // Untouched, as with any future version.
    assert!(fs::read_to_string(&path).unwrap().contains("must not be lost"));
    assert!(!has_quarantine_file(dir.path()));
}

#[test]
fn future_version_is_rejected_through_the_board_store() {
    let dir = TempDir::new().unwrap();
    fs::write(
        dir.path().join("board.json"),
        r#"{"version": 99, "activeBoardId": "default", "boards": []}"#,
    )
    .unwrap();

    assert!(matches!(
        BoardStore::load(dir.path()),
        Err(StorageError::FutureVersion { found: 99, .. })
    ));
}

// ---------------------------------------------------------------- migration

#[test]
fn migrates_v1_to_v2() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    fs::write(&path, r#"{"version": 1, "title": "old field name"}"#).unwrap();

    let loaded = load_or_default::<Doc>(&path, &v2_set()).unwrap();

    assert_eq!(loaded.outcome, LoadOutcome::Migrated { from: 1, to: 2 });
    assert_eq!(loaded.value.name, "old field name");
    assert_eq!(loaded.value.version, 2, "version field must be updated");

    // Migration does not persist by itself — the caller decides when to write.
    assert!(fs::read_to_string(&path).unwrap().contains("title"));
}

#[test]
fn chains_migrations_v1_to_v3() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    fs::write(&path, r#"{"version": 1, "title": "ancient"}"#).unwrap();

    let loaded = load_or_default::<Doc>(&path, &v3_set()).unwrap();

    assert_eq!(loaded.outcome, LoadOutcome::Migrated { from: 1, to: 3 });
    assert_eq!(loaded.value.name, "ancient");
    assert_eq!(loaded.value.version, 3);
    assert!(loaded.value.items.is_empty());
}

#[test]
fn starts_the_chain_from_the_files_own_version() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    // Already v2: the v1→v2 step must not run and clobber `name`.
    fs::write(&path, r#"{"version": 2, "name": "already migrated"}"#).unwrap();

    let loaded = load_or_default::<Doc>(&path, &v3_set()).unwrap();

    assert_eq!(loaded.outcome, LoadOutcome::Migrated { from: 2, to: 3 });
    assert_eq!(loaded.value.name, "already migrated");
}

#[test]
fn missing_migration_step_is_an_error_not_a_silent_skip() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");
    fs::write(&path, r#"{"version": 1, "name": "x"}"#).unwrap();

    // Claims v3 but only registers 2→3, so 1→2 is missing.
    static GAPPED: &[Migration] = &[Migration {
        from: 2,
        to: 3,
        apply: Ok,
    }];
    let set = MigrationSet {
        current_version: 3,
        migrations: GAPPED,
    };

    assert!(matches!(
        load_or_default::<Doc>(&path, &set),
        Err(StorageError::MissingMigration { from: 1, to: 3, .. })
    ));
}

#[test]
fn a_failing_migration_surfaces_its_reason() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");
    fs::write(&path, r#"{"version": 1}"#).unwrap();

    static FAILING: &[Migration] = &[Migration {
        from: 1,
        to: 2,
        apply: |_| Err("the reshape did not work".to_string()),
    }];
    let set = MigrationSet {
        current_version: 2,
        migrations: FAILING,
    };

    let Err(StorageError::MigrationFailed { reason, .. }) = load_or_default::<Doc>(&path, &set)
    else {
        panic!("expected MigrationFailed");
    };
    assert_eq!(reason, "the reshape did not work");
}

#[test]
fn a_file_without_a_version_field_is_treated_as_v1() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");

    fs::write(&path, r#"{"title": "pre-versioning"}"#).unwrap();

    let loaded = load_or_default::<Doc>(&path, &v2_set()).unwrap();

    assert_eq!(loaded.outcome, LoadOutcome::Migrated { from: 1, to: 2 });
    assert_eq!(loaded.value.name, "pre-versioning");
}

#[test]
fn current_version_loads_without_migrating() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("doc.json");
    fs::write(&path, r#"{"version": 1, "name": "current"}"#).unwrap();

    let loaded = load_or_default::<Doc>(&path, &v1_only_set()).unwrap();

    assert_eq!(loaded.outcome, LoadOutcome::Loaded);
    assert_eq!(loaded.value.name, "current");
}

#[test]
fn outcome_flags_only_the_cases_worth_telling_the_user_about() {
    assert!(!LoadOutcome::Missing.is_noteworthy());
    assert!(!LoadOutcome::Loaded.is_noteworthy());
    assert!(LoadOutcome::Migrated { from: 1, to: 2 }.is_noteworthy());
    assert!(LoadOutcome::Recovered {
        backup: "/tmp/x".into(),
        reason: "bad".into(),
    }
    .is_noteworthy());
}

// ------------------------------------------------------------------ helpers

fn quarantine_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().contains(".corrupt-"))
        .collect()
}

fn has_quarantine_file(dir: &std::path::Path) -> bool {
    !quarantine_files(dir).is_empty()
}

fn read_quarantine_file(dir: &std::path::Path) -> String {
    let files = quarantine_files(dir);
    assert_eq!(files.len(), 1, "expected exactly one quarantine file");
    fs::read_to_string(&files[0]).unwrap()
}
