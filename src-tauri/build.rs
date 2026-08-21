fn main() {
    #[cfg(target_os = "macos")]
    build_mediaremote_adapter();

    tauri_build::build()
}

/// vendor/mediaremote-adapter를 clang으로 빌드해 프레임워크 번들을 만든다.
///
/// # 왜 build.rs인가
///
/// 이 프레임워크는 "지금 재생 중" 위젯의 데이터 원천 전부다. 별도 스크립트로
/// 빼면 "clone 직후 `bun run dev`를 했는데 위젯만 조용히 죽는" 상태가 생긴다 —
/// cargo 빌드에 묶어두면 빌드가 되는 한 프레임워크도 있다.
///
/// # 왜 cmake가 아닌가
///
/// 업스트림은 cmake를 쓰지만 이 기기에는 cmake가 없고, Tauri 개발에 필수인
/// Xcode CLT의 clang만으로 충분하다. 업스트림 CMakeLists의 옵션
/// (`-fobjc-arc -fvisibility=default`, Foundation·AppKit·UniformTypeIdentifiers)을
/// 그대로 옮겼다. 소스가 안 바뀌면 건너뛰므로 증분 빌드에 초를 더하지 않는다.
#[cfg(target_os = "macos")]
fn build_mediaremote_adapter() {
    use std::path::Path;
    use std::process::Command;

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let vendor = Path::new(&manifest_dir).join("vendor/mediaremote-adapter");
    let fw = vendor.join("build/MediaRemoteAdapter.framework");
    let dylib = fw.join("Versions/A/MediaRemoteAdapter");

    // 소스 목록. 디렉토리 단위로 훑으면 파일이 추가돼도 여기를 안 고쳐도 된다.
    let mut sources: Vec<std::path::PathBuf> = Vec::new();
    for dir in ["src/adapter", "src/private", "src/utility"] {
        let dir = vendor.join(dir);
        println!("cargo:rerun-if-changed={}", dir.display());
        for entry in std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("어댑터 소스 디렉토리를 읽을 수 없습니다 {dir:?}: {e}"))
        {
            let path = entry.expect("디렉토리 항목").path();
            if path.extension().is_some_and(|ext| ext == "m") {
                sources.push(path);
            }
        }
    }
    sources.sort();

    // 산출물이 모든 소스보다 새로우면 건너뛴다.
    if let Ok(out_meta) = std::fs::metadata(&dylib) {
        let out_mtime = out_meta.modified().ok();
        let stale = sources.iter().any(|s| {
            let src_mtime = std::fs::metadata(s).and_then(|m| m.modified()).ok();
            match (src_mtime, out_mtime) {
                (Some(s), Some(o)) => s > o,
                _ => true,
            }
        });
        if !stale {
            return;
        }
    }

    let versions_a = fw.join("Versions/A");
    let resources = versions_a.join("Resources");
    std::fs::create_dir_all(&resources).expect("프레임워크 디렉토리 생성 실패");

    // 릴리즈는 aarch64만 배포하지만(릴리즈 에셋 참조), 컴파일 대상 아키텍처를
    // 그대로 따라가면 어느 쪽으로 빌드해도 어긋나지 않는다.
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x86_64",
        _ => "arm64",
    };

    let status = Command::new("clang")
        .arg("-dynamiclib")
        .arg("-fobjc-arc")
        .arg("-fvisibility=default")
        .args(["-arch", arch])
        .arg(format!("-I{}", vendor.join("include").display()))
        .arg(format!("-I{}", vendor.join("src").display()))
        .args(&sources)
        .args(["-framework", "Foundation"])
        .args(["-framework", "AppKit"])
        .args(["-framework", "UniformTypeIdentifiers"])
        .args([
            "-install_name",
            "@rpath/MediaRemoteAdapter.framework/Versions/A/MediaRemoteAdapter",
        ])
        .arg("-o")
        .arg(&dylib)
        .status()
        .expect("clang을 실행할 수 없습니다 — Xcode Command Line Tools가 필요합니다");
    assert!(status.success(), "MediaRemoteAdapter.framework 컴파일 실패");

    std::fs::write(
        resources.join("Info.plist"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.vandenbe.MediaRemoteAdapter</string>
  <key>CFBundleName</key><string>MediaRemoteAdapter</string>
  <key>CFBundleExecutable</key><string>MediaRemoteAdapter</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
</dict>
</plist>
"#,
    )
    .expect("Info.plist 쓰기 실패");

    // 표준 프레임워크 번들 심링크. 이미 있으면 만들지 않는다.
    let links: &[(&str, &str)] = &[
        ("Versions/Current", "A"),
        ("MediaRemoteAdapter", "Versions/Current/MediaRemoteAdapter"),
        ("Resources", "Versions/Current/Resources"),
    ];
    for (link, target) in links {
        let link_path = fw.join(link);
        if std::fs::symlink_metadata(&link_path).is_err() {
            std::os::unix::fs::symlink(target, &link_path).expect("프레임워크 심링크 생성 실패");
        }
    }

    // ad-hoc 서명. 릴리즈 번들에서는 tauri가 앱 서명 시 다시 서명한다.
    // 서명이 아예 없으면 dev에서 dlopen이 거부될 수 있다.
    let status = Command::new("codesign")
        .args(["--force", "--deep", "--sign", "-"])
        .arg(&fw)
        .status()
        .expect("codesign을 실행할 수 없습니다");
    assert!(status.success(), "MediaRemoteAdapter.framework 서명 실패");
}
