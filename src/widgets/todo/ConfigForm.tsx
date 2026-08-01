import type { WidgetConfigFormProps } from '#/widgets/types'
import type { TodoWidgetConfig } from './index'

/**
 * Todo 설정.
 *
 * 설정할 것이 제목뿐인 이유: 다른 위젯의 설정은 대부분 **무엇을 가져올지**
 * (쿼리·프로젝트·갱신 주기)인데, Todo는 가져올 것이 하나뿐이다.
 * 보는 날짜는 설정이 아니라 세션 상태다 — 헤더의 `◀ ▶`로 옮긴다.
 */
export function TodoConfigForm({ config, onChange }: WidgetConfigFormProps<TodoWidgetConfig>) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <label className="flex flex-col gap-1">
        <span className="text-caption text-text-secondary">위젯 이름</span>
        <input
          value={config.title ?? ''}
          onChange={(e) => onChange({ ...config, title: e.target.value || null })}
          placeholder="할 일"
          className="rounded border border-border-subtle bg-surface-inset px-2 py-1
                     text-body text-text-primary
                     focus-visible:outline-2 focus-visible:outline-accent"
        />
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={config.autoCarryOver ?? true}
          onChange={(e) => onChange({ ...config, autoCarryOver: e.target.checked })}
          className="mt-0.5 accent-accent"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-body text-text-primary">미완료 항목 자동 이월</span>
          <span className="text-caption text-text-tertiary">
            날짜가 바뀌면 지난 미완료 항목을 오늘로 옮깁니다. 끄면 과거에 그대로 남고, 위젯 헤더의 ↓
            버튼으로 필요할 때만 가져옵니다.
          </span>
        </span>
      </label>

      <p className="text-caption text-text-tertiary">
        날짜는 위젯 헤더의 ◀ ▶로 옮깁니다. 앱을 다시 켜면 오늘로 돌아옵니다.
      </p>
    </div>
  )
}
