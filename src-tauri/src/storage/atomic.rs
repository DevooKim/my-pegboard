//! Atomic file write primitive.
//!
//! DECISIONS 10 (필수 안전장치 1): 임시 파일 → `rename`.
//! 중간에 죽으면 배치가 통째로 날아간다.
//!
//! The guarantee we need is *crash atomicity*: at any instant a reader either
//! sees the complete old file or the complete new file, never a truncated or
//! interleaved one. Writing in place (`File::create` + `write`) breaks this —
//! `create` truncates first, so a crash between truncate and flush leaves an
//! empty `board.json` and the user's entire layout is gone.
//!
//! The sequence below is the standard durable-replace dance:
//!
//! 1. Write the payload to a temp file **in the same directory** as the target.
//!    Same directory matters: `rename` is only atomic within a filesystem, and
//!    `/tmp` is frequently a different mount. A cross-device rename fails with
//!    `EXDEV` and the fallback (copy) is not atomic.
//! 2. `sync_all` the temp file, so its contents reach stable storage *before*
//!    anything points at them. Without this, a power loss can land the rename
//!    but not the data, leaving a file full of zeroes.
//! 3. `rename` over the target. POSIX guarantees this replaces the directory
//!    entry atomically.
//! 4. `fsync` the *directory* so the rename itself is durable.
//!
//! Step 4 is the one most implementations skip. Without it the rename can sit
//! in the directory's dirty page cache and be lost on power failure even though
//! the data blocks made it to disk.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::storage::error::{StorageError, StorageResult};

/// Write `bytes` to `path` atomically, replacing any existing file.
///
/// On success the target either contains the full new contents or, if the
/// process dies partway, is left entirely untouched. It is never truncated,
/// never partially written.
///
/// The parent directory is created if it does not exist.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> StorageResult<()> {
    let parent = path.parent().ok_or_else(|| StorageError::InvalidPath {
        path: path.to_path_buf(),
        reason: "path has no parent directory".to_string(),
    })?;

    fs::create_dir_all(parent).map_err(|source| StorageError::Io {
        path: parent.to_path_buf(),
        action: "create data directory",
        source,
    })?;

    let tmp_path = temp_path_for(path);

    // Scope the handle so it is closed before the rename. Closing after rename
    // is harmless on Unix but is required for correctness on Windows, and this
    // module should not encode a platform assumption it does not need to.
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|source| StorageError::Io {
                path: tmp_path.clone(),
                action: "create temp file",
                source,
            })?;

        if let Err(source) = file.write_all(bytes) {
            let _ = fs::remove_file(&tmp_path);
            return Err(StorageError::Io {
                path: tmp_path,
                action: "write temp file",
                source,
            });
        }

        // Durability before visibility.
        if let Err(source) = file.sync_all() {
            let _ = fs::remove_file(&tmp_path);
            return Err(StorageError::Io {
                path: tmp_path,
                action: "fsync temp file",
                source,
            });
        }
    }

    if let Err(source) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(StorageError::Io {
            path: path.to_path_buf(),
            action: "rename temp file over target",
            source,
        });
    }

    // Make the rename itself durable. Best-effort: some filesystems reject
    // fsync on a directory handle, and failing the whole write for that would
    // be worse than the (already very small) durability gap.
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }

    Ok(())
}

/// Serialize `value` as pretty JSON and write it atomically.
///
/// Pretty-printed on purpose: DECISIONS 10 lists "사용자가 직접 열어서 고칠 수
/// 있음" as a real advantage of JSON over SQLite. A single-line file forfeits it.
pub fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> StorageResult<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|source| StorageError::Serialize {
        path: path.to_path_buf(),
        source,
    })?;
    bytes.push(b'\n');
    write_atomic(path, &bytes)
}

/// Monotonic counter making each temp path unique within the process.
static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Temp file name that lives beside the target.
///
/// The leading dot keeps it out of casual directory listings. Uniqueness comes
/// from the pid *and* a per-call counter:
///
/// - The pid separates processes.
/// - The counter separates concurrent writes inside one process. This matters
///   in the real app, not just in tests: the scheduler polls several widgets at
///   once and each writes its own cache file. With a pid-only name, two
///   simultaneous writes would share a temp path — the first `rename` moves it
///   away and the second fails with `ENOENT`, so a widget silently loses its
///   cache update even though the write "succeeded" from its own perspective.
///
/// The target is never corrupted either way (rename stays atomic); the bug is
/// the spurious failure, which CLAUDE.md's no-silent-failure rule makes worse
/// than it sounds.
fn temp_path_for(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "data".to_string());

    let counter = WRITE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let unique = format!(".{}.tmp-{}-{}", file_name, std::process::id(), counter);
    path.with_file_name(unique)
}
