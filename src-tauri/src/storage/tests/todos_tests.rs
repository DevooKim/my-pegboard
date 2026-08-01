//! Todo store and carry-over tests.
//!
//! DECISIONS 13. Carry-over is the highest-risk logic in the storage layer:
//! it mutates the only data in the app with no upstream copy, and it runs
//! automatically at app start and midnight without the user asking.

use std::fs;

use chrono::NaiveDate;
use tempfile::TempDir;

use crate::storage::todos::{TodoItem, TodoStore, TODOS_BACKUP_FILE, TODOS_FILE};

fn date(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

fn store(dir: &TempDir) -> TodoStore {
    TodoStore::load(dir.path()).unwrap().0
}

// ---------------------------------------------------------------- carry-over

#[test]
fn moves_undone_items_from_yesterday_to_today() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "write tests", date("2026-07-28")));

    let report = s.carry_over(date("2026-07-29"));

    assert_eq!(report.count(), 1);
    let item = &s.items()[0];
    assert_eq!(item.date, date("2026-07-29"));
    assert_eq!(item.carried_count, 1);
}

/// DECISIONS 13: 복사가 아니라 **이동**. 항목은 하나만 존재하고 `date`만 바뀜.
///
/// Copying would leave undone ghosts on past dates and make "어제 뭐 했지"
/// permanently noisy.
#[test]
fn moves_rather_than_copies() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "task", date("2026-07-27")));
    assert_eq!(s.items().len(), 1);

    s.carry_over(date("2026-07-29"));

    // Exactly one row still exists.
    assert_eq!(s.items().len(), 1, "carry-over must not duplicate the item");

    // The past date retains no ghost.
    assert!(
        s.items_on(date("2026-07-27")).is_empty(),
        "past date must not retain an undone ghost"
    );
    assert_eq!(s.items_on(date("2026-07-29")).len(), 1);

    // Identity is preserved — same id, not a new one.
    assert_eq!(s.items()[0].id, "a");
}

/// DECISIONS 13: 어제만이 아니라 **과거 전체**.
/// 주말에 앱을 안 켰으면 금요일 항목도 월요일로.
#[test]
fn sweeps_all_past_dates_not_just_yesterday() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    // Friday, Saturday, Sunday — app not opened over the weekend.
    s.add(TodoItem::new("fri", "friday task", date("2026-07-24")));
    s.add(TodoItem::new("sat", "saturday task", date("2026-07-25")));
    s.add(TodoItem::new("sun", "sunday task", date("2026-07-26")));
    // And something much older, to prove there is no lookback window.
    s.add(TodoItem::new("old", "ancient task", date("2026-01-15")));

    let monday = date("2026-07-27");
    let report = s.carry_over(monday);

    assert_eq!(report.count(), 4, "every past date must be swept");
    for item in s.items() {
        assert_eq!(item.date, monday, "{} was left behind", item.id);
    }

    // The report tells the caller how many distinct days were pulled forward.
    assert_eq!(
        report.source_dates,
        vec![
            date("2026-01-15"),
            date("2026-07-24"),
            date("2026-07-25"),
            date("2026-07-26"),
        ]
    );
    assert_eq!(report.target_date, monday);
}

/// A single sweep across a multi-day gap counts as **one** carry, not one per
/// day skipped. `carried_count` measures deferrals, not elapsed time.
#[test]
fn multi_day_gap_increments_carried_count_once() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "task", date("2026-07-24")));

    s.carry_over(date("2026-07-27"));

    assert_eq!(s.items()[0].carried_count, 1);
    assert_eq!(s.items()[0].date, date("2026-07-27"));
}

/// DECISIONS 13: `originDate`는 최초 생성 날짜. Never changes.
#[test]
fn origin_date_never_changes_across_repeated_carries() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    let origin = date("2026-07-20");
    s.add(TodoItem::new("a", "long-deferred task", origin));

    for day in ["2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"] {
        s.carry_over(date(day));
        assert_eq!(
            s.items()[0].origin_date,
            origin,
            "origin_date drifted on {day}"
        );
    }

    assert_eq!(s.items()[0].carried_count, 4);
    assert_eq!(s.items()[0].date, date("2026-07-24"));
}

/// Completed items belong to the day they were finished — that is the record
/// of "어제 뭐 했지".
#[test]
fn completed_items_are_never_touched() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    let mut done = TodoItem::new("done", "finished task", date("2026-07-27"));
    done.done = true;
    s.add(done);
    s.add(TodoItem::new("undone", "pending task", date("2026-07-27")));

    let report = s.carry_over(date("2026-07-29"));

    assert_eq!(report.count(), 1, "only the undone item should move");

    let done_item = s.items().iter().find(|i| i.id == "done").unwrap();
    assert_eq!(done_item.date, date("2026-07-27"), "completed item moved");
    assert_eq!(done_item.carried_count, 0);

    let undone_item = s.items().iter().find(|i| i.id == "undone").unwrap();
    assert_eq!(undone_item.date, date("2026-07-29"));
}

/// DECISIONS 13: 미래는 추가 가능 ("내일 이거 해야지"). A sweep must not drag
/// tomorrow's plan onto today.
#[test]
fn future_items_are_never_touched() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("tomorrow", "future task", date("2026-07-30")));
    s.add(TodoItem::new("later", "much later", date("2026-08-15")));

    let report = s.carry_over(date("2026-07-29"));

    assert!(report.is_empty());
    assert_eq!(s.items()[0].date, date("2026-07-30"));
    assert_eq!(s.items()[1].date, date("2026-08-15"));
}

#[test]
fn items_already_on_today_are_untouched() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "today's task", date("2026-07-29")));

    let report = s.carry_over(date("2026-07-29"));

    assert!(report.is_empty());
    assert_eq!(s.items()[0].carried_count, 0, "carried_count inflated");
}

/// The sweep runs at app start *and* at midnight, which can fire seconds apart.
/// A second run must be a no-op — otherwise `carried_count` inflates and the
/// "N일째" pressure badge lies.
#[test]
fn carry_over_is_idempotent() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "task one", date("2026-07-25")));
    s.add(TodoItem::new("b", "task two", date("2026-07-26")));
    let mut done = TodoItem::new("c", "finished", date("2026-07-26"));
    done.done = true;
    s.add(done);

    let today = date("2026-07-29");

    let first = s.carry_over(today);
    assert_eq!(first.count(), 2);
    let after_first: Vec<_> = s.items().to_vec();

    let second = s.carry_over(today);
    assert!(second.is_empty(), "second sweep must find nothing");
    assert_eq!(
        s.items(),
        after_first.as_slice(),
        "second sweep mutated state"
    );

    // A third for good measure.
    assert!(s.carry_over(today).is_empty());
    assert_eq!(s.items(), after_first.as_slice());

    for item in s.items().iter().filter(|i| !i.done) {
        assert_eq!(item.carried_count, 1, "carried_count inflated by re-runs");
    }
}

/// DECISIONS 13: `carriedCount >= 7`이면 힌트. **자동 삭제 절대 안 함.**
#[test]
fn never_auto_deletes_no_matter_how_high_carried_count_gets() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("zombie", "the task I keep avoiding", date("2026-01-01")));

    // Carry it forward 400 times — well past the zombie threshold.
    let mut day = date("2026-01-02");
    for _ in 0..400 {
        s.carry_over(day);
        day = day.succ_opt().unwrap();
    }

    assert_eq!(s.items().len(), 1, "item was auto-deleted");
    assert_eq!(s.items()[0].carried_count, 400);
    assert!(s.items()[0].is_zombie());
    assert_eq!(s.items()[0].origin_date, date("2026-01-01"));
}

#[test]
fn zombie_threshold_matches_decisions() {
    let mut item = TodoItem::new("a", "task", date("2026-07-29"));

    item.carried_count = 6;
    assert!(!item.is_zombie());

    item.carried_count = 7;
    assert!(item.is_zombie(), "DECISIONS 13: carriedCount >= 7");
}

#[test]
fn is_carried_flags_only_moved_items() {
    let mut item = TodoItem::new("a", "task", date("2026-07-29"));
    assert!(!item.is_carried());

    item.carried_count = 1;
    assert!(item.is_carried());
}

#[test]
fn empty_store_sweep_is_a_no_op() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    let report = s.carry_over(date("2026-07-29"));

    assert!(report.is_empty());
    assert!(report.source_dates.is_empty());
}

// ---------------------------------------------------------------------- undo

/// DECISIONS 13: 자동 실행 + 되돌리기 가능.
#[test]
fn undo_restores_dates_and_counts() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "task one", date("2026-07-25")));
    s.add(TodoItem::new("b", "task two", date("2026-07-26")));

    let report = s.carry_over(date("2026-07-29"));
    let restored = s.undo_carry_over(&report);

    assert_eq!(restored, 2);

    let a = s.items().iter().find(|i| i.id == "a").unwrap();
    assert_eq!(a.date, date("2026-07-25"));
    assert_eq!(a.carried_count, 0);

    let b = s.items().iter().find(|i| i.id == "b").unwrap();
    assert_eq!(b.date, date("2026-07-26"));
    assert_eq!(b.carried_count, 0);
}

#[test]
fn undo_preserves_a_previously_accumulated_carried_count() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    let mut item = TodoItem::new("a", "task", date("2026-07-28"));
    item.carried_count = 3; // Already carried three times before.
    s.add(item);

    let report = s.carry_over(date("2026-07-29"));
    assert_eq!(s.items()[0].carried_count, 4);

    s.undo_carry_over(&report);
    // Back to 3, not 0.
    assert_eq!(s.items()[0].carried_count, 3);
}

#[test]
fn undo_skips_items_deleted_since_the_sweep() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "task one", date("2026-07-28")));
    s.add(TodoItem::new("b", "task two", date("2026-07-28")));

    let report = s.carry_over(date("2026-07-29"));
    s.remove("a").unwrap();

    let restored = s.undo_carry_over(&report);

    // An undo must not resurrect something the user deliberately removed.
    assert_eq!(restored, 1);
    assert_eq!(s.items().len(), 1);
    assert_eq!(s.items()[0].id, "b");
}

#[test]
fn undo_skips_items_the_user_moved_since_the_sweep() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "task", date("2026-07-28")));

    let report = s.carry_over(date("2026-07-29"));

    // User drags it to a future date before hitting undo. Their action wins.
    s.get_mut("a").unwrap().date = date("2026-08-01");

    let restored = s.undo_carry_over(&report);

    assert_eq!(restored, 0);
    assert_eq!(s.items()[0].date, date("2026-08-01"));
}

// ------------------------------------------------------------------ backup

/// DECISIONS 10: `todos.json.bak` 1세대. Todo는 유일본 데이터.
#[test]
fn save_rotates_a_one_generation_backup() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "first", date("2026-07-29")));
    s.save().unwrap();

    // First save has nothing to back up yet.
    assert!(!dir.path().join(TODOS_BACKUP_FILE).exists());

    s.add(TodoItem::new("b", "second", date("2026-07-29")));
    s.save().unwrap();

    // Second save rotates the first generation aside.
    let backup = fs::read_to_string(dir.path().join(TODOS_BACKUP_FILE)).unwrap();
    assert!(backup.contains("first"));
    assert!(
        !backup.contains("second"),
        "backup must hold the PREVIOUS contents, not the new ones"
    );

    let current = fs::read_to_string(dir.path().join(TODOS_FILE)).unwrap();
    assert!(current.contains("first") && current.contains("second"));
}

#[test]
fn backup_stays_one_generation_deep() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    for n in 0..5 {
        s.add(TodoItem::new(
            format!("item-{n}"),
            format!("task {n}"),
            date("2026-07-29"),
        ));
        s.save().unwrap();
    }

    let backup = fs::read_to_string(dir.path().join(TODOS_BACKUP_FILE)).unwrap();
    // Holds the state before the last save: items 0..=3, but not 4.
    assert!(backup.contains("item-3"));
    assert!(!backup.contains("item-4"));

    // No .bak.bak or numbered generations accumulate.
    let names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names.len(), 2, "unexpected files: {names:?}");
}

/// The reason the backup exists: recovering a `todos.json` destroyed by
/// something outside our control.
#[test]
fn corrupt_todos_falls_back_to_the_backup() {
    let dir = TempDir::new().unwrap();

    {
        let mut s = store(&dir);
        s.add(TodoItem::new("a", "important task", date("2026-07-29")));
        s.save().unwrap();
        s.add(TodoItem::new("b", "another task", date("2026-07-29")));
        s.save().unwrap();
    }

    // Something mangles the live file.
    fs::write(dir.path().join(TODOS_FILE), "{{{ not json").unwrap();

    let (recovered, outcome) = TodoStore::load(dir.path()).unwrap();

    // The user's data comes back from the backup rather than being lost.
    assert_eq!(recovered.items().len(), 1);
    assert_eq!(recovered.items()[0].text, "important task");

    // And the caller is told, because silent recovery is still silent failure.
    assert!(outcome.is_noteworthy());

    // The corrupt file is preserved, never just deleted.
    let corrupt: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains(".corrupt-"))
        .collect();
    assert_eq!(corrupt.len(), 1, "corrupt file was not quarantined");
}

// ------------------------------------------------------------- persistence

#[test]
fn round_trips_through_disk() {
    let dir = TempDir::new().unwrap();

    {
        let mut s = store(&dir);
        let mut item = TodoItem::new("a", "task", date("2026-07-20"));
        item.carried_count = 3;
        item.date = date("2026-07-29");
        s.add(item);
        s.save().unwrap();
    }

    let s = store(&dir);
    let item = &s.items()[0];
    assert_eq!(item.id, "a");
    assert_eq!(item.text, "task");
    assert_eq!(item.date, date("2026-07-29"));
    assert_eq!(item.origin_date, date("2026-07-20"));
    assert_eq!(item.carried_count, 3);
    assert!(!item.done);
}

#[test]
fn serializes_dates_as_plain_iso_strings() {
    // DECISIONS 13 shows `"date": "2026-07-29"`, and the file is meant to be
    // hand-editable. A serde default that emitted an object would break both.
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);
    s.add(TodoItem::new("a", "task", date("2026-07-29")));
    s.save().unwrap();

    let raw = fs::read_to_string(dir.path().join(TODOS_FILE)).unwrap();
    assert!(raw.contains(r#""date": "2026-07-29""#), "got: {raw}");
    assert!(raw.contains(r#""originDate": "2026-07-29""#), "got: {raw}");
    assert!(raw.contains(r#""carriedCount": 0"#), "got: {raw}");
}

#[test]
fn missing_file_yields_an_empty_store() {
    let dir = TempDir::new().unwrap();
    let (s, outcome) = TodoStore::load(dir.path()).unwrap();

    assert!(s.items().is_empty());
    assert_eq!(outcome, crate::storage::migrate::LoadOutcome::Missing);
    // Nothing is written just by loading.
    assert!(!dir.path().join(TODOS_FILE).exists());
}

#[test]
fn set_done_and_remove_work() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "task", date("2026-07-29")));

    assert!(s.set_done("a", true).unwrap());
    assert!(s.items()[0].done);

    assert!(!s.set_done("a", false).unwrap());
    assert!(!s.items()[0].done);

    let removed = s.remove("a").unwrap();
    assert_eq!(removed.id, "a");
    assert!(s.items().is_empty());

    assert!(s.remove("nope").is_err());
}

#[test]
fn items_on_filters_by_date() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "today", date("2026-07-29")));
    s.add(TodoItem::new("b", "today too", date("2026-07-29")));
    s.add(TodoItem::new("c", "tomorrow", date("2026-07-30")));

    assert_eq!(s.items_on(date("2026-07-29")).len(), 2);
    assert_eq!(s.items_on(date("2026-07-30")).len(), 1);
    assert_eq!(s.items_on(date("2026-07-31")).len(), 0);
}

/// A leap day is a real date and must sweep like any other.
#[test]
fn carry_over_handles_leap_day() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "task", date("2028-02-29")));

    let report = s.carry_over(date("2028-03-01"));

    assert_eq!(report.count(), 1);
    assert_eq!(s.items()[0].date, date("2028-03-01"));
    assert_eq!(s.items()[0].origin_date, date("2028-02-29"));
}

/// Carrying across a year boundary is just date comparison, but it is the kind
/// of thing an off-by-one in a manual day-diff would break.
#[test]
fn carry_over_crosses_a_year_boundary() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);

    s.add(TodoItem::new("a", "new year task", date("2026-12-31")));

    let report = s.carry_over(date("2027-01-01"));

    assert_eq!(report.count(), 1);
    assert_eq!(s.items()[0].date, date("2027-01-01"));
    assert_eq!(s.items()[0].carried_count, 1);
}

// ---------------------------------------------------------------------------
// 순서 변경 (드래그)
// ---------------------------------------------------------------------------
//
// 순서가 곧 배열 순서다(별도 정렬 키가 없다). 그래서 인덱스 산술이 틀리면
// 항목이 사라지거나 다른 날짜 사이에 끼어든다 — 유일본 데이터에서 가장
// 위험한 종류의 버그라 경계를 촘촘히 고정한다.

fn ids_on(s: &TodoStore, d: &str) -> Vec<String> {
    s.items_on(date(d)).iter().map(|i| i.id.clone()).collect()
}

fn seeded(dir: &TempDir) -> TodoStore {
    let mut s = store(dir);
    for id in ["a", "b", "c"] {
        s.add(TodoItem::new(id, id, date("2026-08-02")));
    }
    s
}

#[test]
fn moves_an_item_down_within_its_date() {
    let dir = TempDir::new().unwrap();
    let mut s = seeded(&dir);

    assert!(s.reorder_within_date("a", 2));
    assert_eq!(ids_on(&s, "2026-08-02"), ["b", "c", "a"]);
}

#[test]
fn moves_an_item_up_within_its_date() {
    let dir = TempDir::new().unwrap();
    let mut s = seeded(&dir);

    assert!(s.reorder_within_date("c", 0));
    assert_eq!(ids_on(&s, "2026-08-02"), ["c", "a", "b"]);
}

#[test]
fn moving_to_its_own_position_is_a_no_op() {
    let dir = TempDir::new().unwrap();
    let mut s = seeded(&dir);

    assert!(!s.reorder_within_date("b", 1), "안 움직였으면 false여야 저장을 건너뛴다");
    assert_eq!(ids_on(&s, "2026-08-02"), ["a", "b", "c"]);
}

#[test]
fn unknown_id_changes_nothing() {
    let dir = TempDir::new().unwrap();
    let mut s = seeded(&dir);

    assert!(!s.reorder_within_date("없는-id", 0));
    assert_eq!(ids_on(&s, "2026-08-02"), ["a", "b", "c"]);
}

/// 뷰와 스토어가 길이를 다르게 알고 있을 때. 거부하지 않고 끝으로 보낸다.
#[test]
fn out_of_range_index_lands_at_the_end() {
    let dir = TempDir::new().unwrap();
    let mut s = seeded(&dir);

    assert!(s.reorder_within_date("a", 99));
    assert_eq!(ids_on(&s, "2026-08-02"), ["b", "c", "a"]);
}

/// **가장 중요한 경계.** 다른 날짜 항목이 사이에 끼어 있어도 그 순서가
/// 흐트러지면 안 된다 — 8/1 항목이 8/2 사이로 밀려들면 날짜 화면이 뒤섞인다.
#[test]
fn reordering_one_date_leaves_other_dates_alone() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);
    // 두 날짜를 번갈아 넣어 배열에서 서로 끼어 있게 만든다.
    s.add(TodoItem::new("x1", "x1", date("2026-08-01")));
    s.add(TodoItem::new("y1", "y1", date("2026-08-02")));
    s.add(TodoItem::new("x2", "x2", date("2026-08-01")));
    s.add(TodoItem::new("y2", "y2", date("2026-08-02")));
    s.add(TodoItem::new("y3", "y3", date("2026-08-02")));

    assert!(s.reorder_within_date("y3", 0));

    assert_eq!(ids_on(&s, "2026-08-02"), ["y3", "y1", "y2"]);
    assert_eq!(ids_on(&s, "2026-08-01"), ["x1", "x2"], "다른 날짜는 그대로");
    assert_eq!(s.items().len(), 5, "항목이 사라지거나 늘면 안 된다");
}

#[test]
fn reordering_survives_a_save_and_reload() {
    let dir = TempDir::new().unwrap();
    {
        let mut s = seeded(&dir);
        s.reorder_within_date("c", 0);
        s.save().unwrap();
    }
    let (reloaded, _) = TodoStore::load(dir.path()).unwrap();
    assert_eq!(ids_on(&reloaded, "2026-08-02"), ["c", "a", "b"]);
}

#[test]
fn single_item_cannot_be_reordered() {
    let dir = TempDir::new().unwrap();
    let mut s = store(&dir);
    s.add(TodoItem::new("only", "only", date("2026-08-02")));

    assert!(!s.reorder_within_date("only", 0));
    assert_eq!(s.items().len(), 1);
}
