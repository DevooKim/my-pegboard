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
    const result = await commands.jiraIsConfigured()
    if (result.status === 'ok') {
      set({ jiraConfigured: result.data })
    }
  },

  setJiraAuthFailed: (failed) => set({ jiraAuthFailed: failed }),
}))
