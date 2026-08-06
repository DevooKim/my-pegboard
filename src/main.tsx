import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '#/App'
import '#/styles/index.css'
// 위젯 레지스트리 등록 — import 자체가 부수효과다
import '#/widgets/album'
import '#/widgets/github'
import '#/widgets/jira'
import '#/widgets/todo'
import '#/widgets/web'

const root = document.getElementById('root')
if (!root) throw new Error('#root 엘리먼트를 찾을 수 없습니다')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
