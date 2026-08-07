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

  githubConfigured: boolean
  /** GitHub 401. Jira와 따로 둔다 — 한쪽이 죽었다고 다른 쪽 배너를 띄우면 안 된다. */
  githubAuthFailed: boolean

  linearConfigured: boolean
  /** Linear 401. 서비스마다 따로 두는 이유는 위와 같다. */
  linearAuthFailed: boolean

  refresh: () => Promise<void>
  setJiraAuthFailed: (failed: boolean) => void
  setGithubAuthFailed: (failed: boolean) => void
  setLinearAuthFailed: (failed: boolean) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  jiraConfigured: false,
  jiraBaseUrl: null,
  jiraAuthFailed: false,
  githubConfigured: false,
  githubAuthFailed: false,
  linearConfigured: false,
  linearAuthFailed: false,

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

    // GitHub은 base URL이 없다(github.com 고정). 설정 여부만 본다.
    const github = await commands.githubIsConfigured()
    if (github.status === 'ok') set({ githubConfigured: github.data })

    // Linear도 base URL이 없다(api.linear.app 고정).
    const linear = await commands.linearIsConfigured()
    if (linear.status === 'ok') set({ linearConfigured: linear.data })
  },

  setJiraAuthFailed: (failed) => set({ jiraAuthFailed: failed }),
  setGithubAuthFailed: (failed) => set({ githubAuthFailed: failed }),
  setLinearAuthFailed: (failed) => set({ linearAuthFailed: failed }),
}))
