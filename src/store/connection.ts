import { create } from 'zustand'
import { commands } from '#/ipc/bindings'

/**
 * 연결 상태. 토큰은 여기 없다 — 키체인에 있고 Rust만 본다.
 * 프론트가 아는 것은 "설정됐는가"와 링크를 만들 base URL뿐이다.
 */
interface ConnectionState {
  jiraConfigured: boolean
  jiraBaseUrl: string | null
  /** 401이 발생했는가. 전역 배너를 한 번만 띄우기 위한 플래그. */
  jiraAuthFailed: boolean

  refresh: () => Promise<void>
  setJiraAuthFailed: (failed: boolean) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  jiraConfigured: false,
  jiraBaseUrl: null,
  jiraAuthFailed: false,

  refresh: async () => {
    // baseUrl까지 함께 받는다. 예전에는 configured만 읽어서 jiraBaseUrl이
    // 영원히 null이었고, 그 탓에 티켓 링크가 만들어지지 않았다.
    const result = await commands.jiraConnection()
    if (result.status === 'ok') {
      set({
        jiraConfigured: result.data.configured,
        jiraBaseUrl: result.data.baseUrl ?? null,
      })
    }
  },

  setJiraAuthFailed: (failed) => set({ jiraAuthFailed: failed }),
}))
