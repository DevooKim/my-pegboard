# 렌더링 및 초기 로딩 성능 최적화 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. The user explicitly waived new and existing test execution; use typecheck, lint, and production-build measurements as the verification gates.

**Goal:** Preserve unchanged Todo row references and defer closed settings UI so interactions render less work and the initial JavaScript bundle is smaller.

**Architecture:** Reconcile whole-array Todo IPC responses at the Zustand boundary, where previous state is available, and keep server order authoritative. Use React lazy components only at settings boundaries that are not needed for the first board paint; keep widget views eager.

**Tech Stack:** React 19, TypeScript 7, Zustand 5, Vite 8, Bun

---

### Task 1: Preserve unchanged Todo items

**Files:**
- Modify: `src/store/todos.ts`

- [ ] Add a field-wise equality helper for the six persisted `TodoItem` fields.

```ts
function sameTodoItem(a: TodoItem, b: TodoItem): boolean {
  return (
    a.id === b.id &&
    a.text === b.text &&
    a.done === b.done &&
    a.date === b.date &&
    a.originDate === b.originDate &&
    a.carriedCount === b.carriedCount
  )
}
```

- [ ] Add `reconcileTodoItems(current, incoming)` that indexes current items by id, reuses equal objects, and returns incoming order.

```ts
function reconcileTodoItems(current: TodoItem[], incoming: TodoItem[]): TodoItem[] {
  const currentById = new Map(current.map((item) => [item.id, item]))
  return incoming.map((item) => {
    const previous = currentById.get(item.id)
    return previous && sameTodoItem(previous, item) ? previous : item
  })
}
```

- [ ] Route `load`, `add`, `setDone`, `setText`, `remove`, `checkCarryOver`, `carryOverNow`, and `reorder` success payloads through the reconciler using functional Zustand updates.

```ts
set((state) => ({ items: reconcileTodoItems(state.items, r.data), error: null }))
```

- [ ] Confirm the public store API and IPC payload types are unchanged with `bun run typecheck`.

### Task 2: Defer the application settings modal

**Files:**
- Modify: `src/App.tsx`

- [ ] Replace the static component import with a type-only `SettingsTab` import and a module-level `lazy(() => import(...))` component.

```ts
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { SettingsTab } from '#/settings/SettingsModal'

const SettingsModal = lazy(() =>
  import('#/settings/SettingsModal').then((module) => ({ default: module.SettingsModal })),
)
```

- [ ] Render the lazy modal only while `settingsOpen` is true and wrap it in `Suspense` with a non-animated fallback.

```tsx
{settingsOpen && (
  <Suspense fallback={null}>
    <SettingsModal
      open
      initialTab={settingsTab}
      onClose={() => setSettingsOpen(false)}
      onSaved={() => window.dispatchEvent(new CustomEvent('pegboard:refresh-all'))}
    />
  </Suspense>
)}
```

- [ ] Keep `initialTab`, `onClose`, and `onSaved` behavior unchanged.

### Task 3: Defer widget configuration forms

**Files:**
- Modify: `src/widgets/types.ts`
- Modify: `src/widgets/shell/WidgetConfigModal.tsx`
- Modify: `src/widgets/album/index.ts`
- Modify: `src/widgets/github/index.ts`
- Modify: `src/widgets/jira/index.ts`
- Modify: `src/widgets/linear/index.ts`
- Modify: `src/widgets/todo/index.ts`
- Modify: `src/widgets/web/index.ts`

- [ ] Extend the registry's `ConfigForm` type to accept a typed lazy component without weakening its props to `any`.

```ts
type ConfigFormComponent<TConfig> =
  | ComponentType<WidgetConfigFormProps<TConfig>>
  | LazyExoticComponent<ComponentType<WidgetConfigFormProps<TConfig>>>
```

- [ ] Replace each static ConfigForm import with a named-export dynamic import wrapped in `lazy`.

```ts
const JiraConfigForm = lazy(() =>
  import('./ConfigForm').then((module) => ({ default: module.JiraConfigForm })),
)
```

- [ ] Wrap only the form content in `Suspense`; keep the modal shell, controls, validation state, and apply button behavior intact.

```tsx
<Suspense fallback={<p className="text-caption text-text-tertiary">설정을 불러오는 중…</p>}>
  <ConfigForm config={draft as never} onChange={setDraft} onValidityChange={setValid} />
</Suspense>
```

### Task 4: Measure and publish

**Files:**
- Review all files above and both documentation files.

- [ ] Run `bun run typecheck` and expect exit code 0.
- [ ] Run `bun run lint` and expect exit code 0.
- [ ] Run `bun run build`; record initial JavaScript minified/gzip sizes and confirm the 500KB warning is gone.
- [ ] Inspect `git diff --check`, the full diff, and explicit staged paths.
- [ ] Commit with concise Korean messages, push `agent/optimize-rendering-and-startup`, and open a draft PR against the remote default branch.
