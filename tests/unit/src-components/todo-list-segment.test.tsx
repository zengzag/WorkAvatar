// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider, App as AntApp } from 'antd'

import TodoListSegment, {
  parseTodoItems,
  calcTodoProgress,
} from '../../../src/components/workbench/TodoListSegment'
import type { MessageSegment } from '../../../src/components/workbench/types'
import { getToolDisplayName } from '../../../src/utils/tool-display'

/**
 * todo_write 段的前端展示：
 * 纯逻辑（入参解析/进度计算）+ 卡片渲染（默认展开、折叠预览、
 * 流式加载态、非法参数回退通用工具视图、同一消息仅最后一次默认展开）。
 */

beforeAll(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
})

const todos = [
  { content: '收集需求文档', status: 'completed', priority: 'high' },
  { content: '搭建项目骨架', status: 'in_progress', priority: 'medium' },
  { content: '编写测试报告', status: 'pending', priority: 'low' },
]

const makeSeg = (over: Partial<MessageSegment> = {}): MessageSegment => ({
  type: 'tool_call',
  id: 'seg_todo',
  toolName: 'todo_write',
  toolArgs: { todos },
  isToolComplete: true,
  collapsed: true,
  ...over,
})

const pendings: Array<() => Promise<void>> = []
afterEach(async () => {
  while (pendings.length) await pendings.pop()!()
  vi.restoreAllMocks()
})

async function renderTodo(seg: MessageSegment, props: { defaultCollapsed?: boolean; isActive?: boolean } = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <ConfigProvider>
        <AntApp>
          <TodoListSegment
            seg={seg}
            onToggle={() => { /* 直渲染场景无父级消息态 */ }}
            getToolDisplayName={getToolDisplayName}
            defaultCollapsed={props.defaultCollapsed}
            isActive={props.isActive}
          />
        </AntApp>
      </ConfigProvider>
    )
  })
  pendings.push(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })
  return container
}

const clickHeader = (container: HTMLElement, title: string) => {
  const spans = Array.from(container.querySelectorAll('span'))
  const titleSpan = spans.find(s => s.textContent === title)
  expect(titleSpan).toBeTruthy()
  act(() => {
    titleSpan!.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('parseTodoItems', () => {
  it('解析合法列表并补默认值（status→pending，priority→medium），content 去首尾空白', () => {
    const items = parseTodoItems({
      todos: [
        { content: '  写文档  ' },
        { content: '写代码', status: 'in_progress', priority: 'high' },
      ],
    })
    expect(items).toEqual([
      { content: '写文档', status: 'pending', priority: 'medium' },
      { content: '写代码', status: 'in_progress', priority: 'high' },
    ])
  })

  it('任一项非法即整体返回空（触发回退）', () => {
    expect(parseTodoItems({ todos: [{ content: 'a' }, { content: '' }] })).toEqual([])
    expect(parseTodoItems({ todos: [{ content: 'a' }, 'bad'] })).toEqual([])
    expect(parseTodoItems({ todos: [{ content: 'a', status: 'doing' }] })).toEqual([])
    expect(parseTodoItems({ todos: [{ content: 'a', priority: 'urgent' }] })).toEqual([])
  })

  it('非对象入参 / todos 非数组 / 数组元素非对象 → 返回空', () => {
    expect(parseTodoItems(null)).toEqual([])
    expect(parseTodoItems('x')).toEqual([])
    expect(parseTodoItems({ todos: 'nope' })).toEqual([])
    expect(parseTodoItems({ todos: [null] })).toEqual([])
  })
})

describe('calcTodoProgress', () => {
  it('统计完成数、当前进行项与百分比', () => {
    const p = calcTodoProgress(parseTodoItems({ todos }))
    expect(p.total).toBe(3)
    expect(p.done).toBe(1)
    expect(p.current?.content).toBe('搭建项目骨架')
    expect(p.percent).toBe(33)
    expect(p.allDone).toBe(false)
  })

  it('全部完成 → allDone；空列表 → percent 0 且非 allDone', () => {
    const done = calcTodoProgress(parseTodoItems({
      todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }],
    }))
    expect(done.allDone).toBe(true)
    expect(done.percent).toBe(100)

    const empty = calcTodoProgress([])
    expect(empty.percent).toBe(0)
    expect(empty.allDone).toBe(false)
  })
})

describe('TodoListSegment 渲染', () => {
  it('默认展开：展示全部条目、进度文案与高优先级标记', async () => {
    const c = await renderTodo(makeSeg())
    expect(c.textContent).toContain('更新任务清单')
    expect(c.textContent).toContain('收集需求文档')
    expect(c.textContent).toContain('搭建项目骨架')
    expect(c.textContent).toContain('编写测试报告')
    expect(c.textContent).toContain('1/3 已完成')
    expect(c.querySelectorAll('.anticon-check-circle').length).toBeGreaterThan(0)
    expect(c.querySelectorAll('.anticon-flag').length).toBe(1)
  })

  it('isActive=true → in_progress 项转圈', async () => {
    const c = await renderTodo(makeSeg(), { isActive: true })
    expect(c.querySelectorAll('.anticon-loading').length).toBeGreaterThan(0)
  })

  it('isActive=false（历史快照/消息已结束）→ in_progress 项静态实心点，不转圈', async () => {
    const c = await renderTodo(makeSeg())
    expect(c.querySelectorAll('.anticon-loading').length).toBe(0)
    // 静态实心点（background 内联样式的 span），与 pending 空心圆区分
    expect(c.querySelector('span[style*="background"]')).toBeTruthy()
  })

  it('全部完成 → 头部显示「全部完成」', async () => {
    const c = await renderTodo(makeSeg({
      toolArgs: { todos: [{ content: '收尾', status: 'completed', priority: 'medium' }] },
    }))
    expect(c.textContent).toContain('全部完成')
    expect(c.textContent).not.toContain('已完成')
  })

  it('点击头部折叠：条目隐藏，预览行显示当前进行项；再点击恢复', async () => {
    const c = await renderTodo(makeSeg())
    clickHeader(c, '更新任务清单')
    expect(c.textContent).not.toContain('收集需求文档')
    expect(c.textContent).toContain('进行中: 搭建项目骨架')

    clickHeader(c, '更新任务清单')
    expect(c.textContent).toContain('收集需求文档')
  })

  it('defaultCollapsed=true → 初始折叠，仅头部与预览', async () => {
    const c = await renderTodo(makeSeg(), { defaultCollapsed: true })
    expect(c.textContent).not.toContain('收集需求文档')
    expect(c.textContent).toContain('进行中: 搭建项目骨架')
  })

  it('参数流式生成中（流式活跃）→ 加载态，不渲染条目', async () => {
    const c = await renderTodo(makeSeg({ isToolArgsStreaming: true, toolArgsRaw: '{"todos":[{"con' }), { isActive: true })
    expect(c.textContent).toContain('正在生成任务清单…')
    expect(c.textContent).not.toContain('收集需求文档')
  })

  it('参数流式残留但消息已结束 → 不显示生成中转圈', async () => {
    const c = await renderTodo(makeSeg({ isToolArgsStreaming: true, toolArgsRaw: '{"todos":[{"con' }))
    expect(c.textContent).not.toContain('正在生成任务清单…')
  })

  it('todos 非法 → 回退通用工具调用视图（展示原始参数）', async () => {
    const c = await renderTodo(makeSeg({ toolArgs: { todos: 'bad' }, collapsed: false }))
    expect(c.textContent).toContain('todos')
    expect(c.textContent).not.toContain('1/3 已完成')
  })

  it('toolError → 回退通用工具调用视图并展示错误信息', async () => {
    const c = await renderTodo(makeSeg({ toolError: '已取消', collapsed: false }))
    expect(c.textContent).toContain('已取消')
    expect(c.textContent).not.toContain('1/3 已完成')
  })
})
