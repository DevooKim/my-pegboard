/**
 * Tauri 안에서 실행 중인가.
 *
 * dev 서버를 브라우저로 열어 UI만 보는 경우가 있다. 그때 IPC 커맨드는
 * 응답하지 않으므로, 영원히 로딩 상태로 두는 대신 이유를 표시해야 한다.
 */
export const IN_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
