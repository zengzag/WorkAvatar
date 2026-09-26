import { describe, it, expect } from 'vitest'
import {
  TodoStore,
  createTodoWriteTool,
  validateTodoItems,
  buildTodoReminderIfDue,
  MAX_TODO_ITEMS,
  TODO_REMINDER_FIRST_TURN,
  TODO_REMINDER_INTERVAL,
  TODO_FINAL_PHASE_TURNS,
} from '../../../electron/main/services/agent/tools/todo.tool'

const item = (over: Partial<{ content: string; status: string; priority: string }> = {}) => ({
  content: 'do something',
  status: 'pending',
  priority: 'medium',
  ...over,
})

describe('todo.tool / validateTodoItems', () => {
  it('合法列表规范化通过（默认值补全）', () => {
    const r = validateTodoItems([{ content: 'a' }, { content: 'b', status: 'in_progress', priority: 'high' }])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items[0]).toEqual({ content: 'a', status: 'pending', priority: 'medium' })
      expect(r.items[1]).toEqual({ content: 'b', status: 'in_progress', priority: 'high' })
    }
  })

  it('非数组 / 空 content / 超长 content 被拒', () => {
    expect(validateTodoItems('x').ok).toBe(false)
    expect((validateTodoItems([{}]) as any).error).toMatch(/content is required/)
    expect((validateTodoItems([{ content: '   ' }]) as any).error).toMatch(/content is required/)
    const long = { content: 'x'.repeat(501), status: 'pending' }
    expect((validateTodoItems([long]) as any).error).toMatch(/exceeds 500/)
  })

  it('非法 status/priority 枚举被拒', () => {
    expect((validateTodoItems([{ content: 'a', status: 'done' }]) as any).error).toMatch(/status/)
    expect((validateTodoItems([{ content: 'a', priority: 'urgent' }]) as any).error).toMatch(/priority/)
  })

  it('超过上限被拒并提示上限', () => {
    const r = validateTodoItems(Array.from({ length: MAX_TODO_ITEMS + 1 }, (_, i) => ({ content: `t${i}` })))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(String(MAX_TODO_ITEMS))
  })

  it('重复 content 被拒', () => {
    const r = validateTodoItems([{ content: 'dup' }, { content: 'dup' }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Duplicate/)
  })

  it('同时存在多个 in_progress 被拒', () => {
    const r = validateTodoItems([
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'in_progress' },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Exactly one item may be in_progress/)
  })

  it('空数组合法（清空清单）', () => {
    expect(validateTodoItems([])).toEqual({ ok: true, items: [] })
  })
})

describe('todo.tool / createTodoWriteTool handler', () => {
  it('合法调用写入 store 并返回清单文本', async () => {
    const store = new TodoStore()
    const tool = createTodoWriteTool(store)
    const r = await tool.handler!({ todos: [{ content: 'a', status: 'in_progress', priority: 'high' }] }, undefined as any)
    expect(r.success).toBe(true)
    expect(r.output).toContain('[in progress]')
    expect(r.output).toContain('(high) a')
    expect(store.getItems()).toHaveLength(1)
    expect(store.getItems()[0].content).toBe('a')
  })

  it('全量替换语义：第二次调用完全覆盖第一次', async () => {
    const store = new TodoStore()
    const tool = createTodoWriteTool(store)
    await tool.handler!({ todos: [{ content: 'a' }, { content: 'b' }] }, undefined as any)
    await tool.handler!({ todos: [{ content: 'c', status: 'completed' }] }, undefined as any)
    expect(store.getItems().map(i => i.content)).toEqual(['c'])
  })

  it('非法调用返回 success=false 且不写入 store', async () => {
    const store = new TodoStore()
    await createTodoWriteTool(store).handler!({ todos: [{ content: 'a' }] }, undefined as any)
    const r = await createTodoWriteTool(store).handler!({
      todos: [{ content: 'b', status: 'in_progress' }, { content: 'c', status: 'in_progress' }],
    }, undefined as any)
    expect(r.success).toBe(false)
    expect(store.getItems().map(i => i.content)).toEqual(['a'])
  })

  it('工具元数据：常驻（非 onDemand）、safe 权限、名称 todo_write', () => {
    const tool = createTodoWriteTool(new TodoStore())
    expect(tool.name).toBe('todo_write')
    expect(tool.onDemand).toBeFalsy()
    expect(tool.permission).toBe('safe')
    expect(tool.description).toMatch(/COMPLETE list/i)
  })
})

describe('todo.tool / buildTodoReminderIfDue 节流', () => {
  const items = [{ content: 'a', status: 'in_progress' as const, priority: 'medium' as const }]

  it('无 todo 时不提醒', () => {
    expect(buildTodoReminderIfDue({ turn: 50, maxIterations: 100, items: [], lastReminderTurn: 0 })).toBeUndefined()
  })

  it(`未到首次提醒轮次（< ${TODO_REMINDER_FIRST_TURN}）不提醒`, () => {
    expect(buildTodoReminderIfDue({ turn: TODO_REMINDER_FIRST_TURN - 1, maxIterations: 100, items, lastReminderTurn: 0 })).toBeUndefined()
  })

  it(`到达第 ${TODO_REMINDER_FIRST_TURN} 轮提醒，文本为 system-reminder 包裹且含任务项`, () => {
    const r = buildTodoReminderIfDue({ turn: TODO_REMINDER_FIRST_TURN, maxIterations: 100, items, lastReminderTurn: 0 })
    expect(r).toBeTruthy()
    expect(r).toContain('<system-reminder>')
    expect(r).toContain('not a user message')
    expect(r).toContain('[in progress] (medium) a')
    expect(r).toContain('todo_write')
    expect(r).toContain('</system-reminder>')
  })

  it(`间隔不足 ${TODO_REMINDER_INTERVAL} 轮不重复提醒`, () => {
    expect(buildTodoReminderIfDue({ turn: 15, maxIterations: 100, items, lastReminderTurn: 10 })).toBeUndefined()
  })

  it('达到间隔后再次提醒', () => {
    expect(buildTodoReminderIfDue({ turn: 20, maxIterations: 100, items, lastReminderTurn: 10 })).toBeTruthy()
  })

  it(`进入收尾窗口（剩余 < ${TODO_FINAL_PHASE_TURNS}）即使未到节奏也提醒，并给出收尾指令`, () => {
    const r = buildTodoReminderIfDue({ turn: 98, maxIterations: 100, items, lastReminderTurn: 90 })
    expect(r).toBeTruthy()
    expect(r).toMatch(/remain before this run stops/)
  })

  it('收尾窗口外不出现收尾指令', () => {
    const r = buildTodoReminderIfDue({ turn: 10, maxIterations: 100, items, lastReminderTurn: 0 })!
    expect(r).not.toMatch(/remain before this run stops/)
  })
})

describe('todo.tool / TodoStore', () => {
  it('reset 清空清单与提醒轮次', () => {
    const store = new TodoStore()
    store.replace([{ content: 'a', status: 'pending', priority: 'low' }])
    store.markReminded(10)
    store.reset()
    expect(store.getItems()).toEqual([])
    expect(store.hasItems()).toBe(false)
    expect(store.getLastReminderTurn()).toBe(0)
  })

  it('getItems 返回副本，外部修改不污染内部状态', () => {
    const store = new TodoStore()
    store.replace([{ content: 'a', status: 'pending', priority: 'low' }])
    const got = store.getItems()
    got[0].content = 'mutated'
    expect(store.getItems()[0].content).toBe('a')
  })
})
