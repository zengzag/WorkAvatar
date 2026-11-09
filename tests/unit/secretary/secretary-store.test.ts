import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 小秘书任务 store：
 * - 落盘恢复：执行中 / 等待确认的任务在渲染进程重建后必须标记为中断（否则挂件会一直转圈）
 * - 挂件状态汇总优先级：等待确认 > 执行中 > 未查看结果 > 空闲
 * - 落盘时剥掉头像 data URL（30 条任务会把 localStorage 撑满）
 */

const STORAGE_KEY = 'wa.secretary.tasks'
const storage = new Map<string, string>()

vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)) },
  removeItem: (key: string) => { storage.delete(key) },
})

const makeTask = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `task-${id}`,
  employee: { id: 'e1', name: '员工', avatarColor: '#4C8DFF' },
  status,
  step: '正在处理',
  startedAt: 1,
  viewed: true,
  conversationId: `c-${id}`,
  ...extra,
})

storage.set(STORAGE_KEY, JSON.stringify([
  makeTask('running', 'running'),
  makeTask('waiting', 'waiting'),
  makeTask('done', 'done', { viewed: false }),
  makeTask('failed', 'failed', { viewed: false }),
]))

const {
  useSecretaryStore,
  selectRunningTasks,
  selectUnreadTasks,
  selectBusSummary,
} = await import('../../../src/components/secretary/secretary.store')

describe('secretary.store 落盘恢复', () => {
  it('执行中 / 等待确认的任务恢复为中断失败', () => {
    const tasks = useSecretaryStore.getState().tasks
    const running = tasks.find((t) => t.id === 'running')
    const waiting = tasks.find((t) => t.id === 'waiting')
    expect(running?.status).toBe('failed')
    expect(running?.error).toBe('interrupted')
    expect(running?.step).toBe('')
    expect(waiting?.status).toBe('failed')
    expect(waiting?.error).toBe('interrupted')
  })

  it('已完成 / 已失败的任务保持原状态与查看标记', () => {
    const tasks = useSecretaryStore.getState().tasks
    expect(tasks.find((t) => t.id === 'done')?.status).toBe('done')
    expect(tasks.find((t) => t.id === 'done')?.viewed).toBe(false)
    expect(tasks.find((t) => t.id === 'failed')?.status).toBe('failed')
  })
})

describe('secretary.store 任务操作', () => {
  beforeEach(() => {
    useSecretaryStore.setState({ tasks: [], notices: [] })
  })

  it('addTask 新任务排在最前并限制 30 条', () => {
    for (let i = 0; i < 35; i++) {
      useSecretaryStore.getState().addTask(makeTask(`t${i}`, 'running') as any)
    }
    const tasks = useSecretaryStore.getState().tasks
    expect(tasks).toHaveLength(30)
    expect(tasks[0].id).toBe('t34')
  })

  it('markViewed / removeTask / patchTask 只影响目标任务', () => {
    useSecretaryStore.getState().addTask(makeTask('a', 'done', { viewed: false }) as any)
    useSecretaryStore.getState().addTask(makeTask('b', 'done', { viewed: false }) as any)
    useSecretaryStore.getState().markViewed('a')
    useSecretaryStore.getState().patchTask('b', { status: 'failed', error: 'x' })
    const tasks = useSecretaryStore.getState().tasks
    expect(tasks.find((t) => t.id === 'a')?.viewed).toBe(true)
    expect(tasks.find((t) => t.id === 'b')?.status).toBe('failed')
    useSecretaryStore.getState().removeTask('a')
    expect(useSecretaryStore.getState().tasks.map((t) => t.id)).toEqual(['b'])
  })

  it('落盘时剥掉头像 data URL，避免撑满 localStorage', () => {
    useSecretaryStore.getState().addTask({
      ...makeTask('img', 'done'),
      employee: { id: 'e1', name: '员工', avatarImage: 'data:image/png;base64,AAAA' },
    } as any)
    const persisted = JSON.parse(storage.get(STORAGE_KEY) || '[]')
    const item = persisted.find((t: any) => t.id === 'img')
    expect(item).toBeTruthy()
    expect(item.employee.avatarImage).toBeUndefined()
  })
})

describe('secretary.store 通知操作', () => {
  beforeEach(() => {
    useSecretaryStore.setState({ tasks: [], notices: [] })
  })

  it('addNotice / markNoticeViewed / removeNotice 只影响目标通知', () => {
    const notice = { id: 'n1', title: '日历提醒', body: '10:00 开会', createdAt: 1, viewed: false }
    useSecretaryStore.getState().addNotice(notice)
    useSecretaryStore.getState().addNotice({ ...notice, id: 'n2' })
    expect(useSecretaryStore.getState().notices.map((n) => n.id)).toEqual(['n2', 'n1'])
    useSecretaryStore.getState().markNoticeViewed('n1')
    expect(useSecretaryStore.getState().notices.find((n) => n.id === 'n1')?.viewed).toBe(true)
    useSecretaryStore.getState().removeNotice('n2')
    expect(useSecretaryStore.getState().notices.map((n) => n.id)).toEqual(['n1'])
  })

  it('未读通知计入挂件角标，但不改变任务状态', () => {
    const summary = selectBusSummary([], [
      { id: 'n1', title: 'T', body: 'B', createdAt: 1, viewed: false },
      { id: 'n2', title: 'T', body: 'B', createdAt: 2, viewed: true },
    ])
    expect(summary.status).toBe('idle')
    expect(summary.unreadCount).toBe(1)
    // 通知与任务结果分开计数：挂件气泡据此区分「通知待查看」与「结果等你来看」
    expect(summary.unreadTaskCount).toBe(0)
    expect(summary.unreadNoticeCount).toBe(1)
  })

  it('任务结果与通知分别计数，角标为两者之和', () => {
    const summary = selectBusSummary(
      [{ id: 't1', title: 'T', employee: { id: 'e1', name: '员工' }, status: 'done', step: '', startedAt: 1, viewed: false, conversationId: 'c1' } as any],
      [{ id: 'n1', title: 'T', body: 'B', createdAt: 1, viewed: false }],
    )
    expect(summary.unreadTaskCount).toBe(1)
    expect(summary.unreadNoticeCount).toBe(1)
    expect(summary.unreadCount).toBe(2)
  })
})

describe('secretary 选择器', () => {
  const running = (id: string) => makeTask(id, 'running') as any
  const waiting = (id: string) => makeTask(id, 'waiting') as any
  const done = (id: string, viewed = false) => makeTask(id, 'done', { viewed }) as any
  const failed = (id: string, viewed = false) => makeTask(id, 'failed', { viewed }) as any

  it('执行中列表包含等待确认的任务', () => {
    expect(selectRunningTasks([running('a'), waiting('b'), done('c')]).map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('未查看列表只包含已结束且未查看的任务', () => {
    expect(selectUnreadTasks([done('a'), failed('b'), done('c', true), running('d')]).map((t) => t.id))
      .toEqual(['a', 'b'])
  })

  it('空闲：无任务时状态为 idle', () => {
    const summary = selectBusSummary([])
    expect(summary.status).toBe('idle')
    expect(summary.runningCount).toBe(0)
    expect(summary.unreadCount).toBe(0)
    expect(summary.latest).toBeUndefined()
    expect(summary.waiting).toBeUndefined()
  })

  it('等待确认优先级高于执行中（即使等待任务不在首位）', () => {
    const summary = selectBusSummary([running('a'), waiting('b')])
    expect(summary.status).toBe('waiting')
    expect(summary.waiting?.id).toBe('b')
    expect(summary.latest?.id).toBe('a')
    expect(summary.runningCount).toBe(2)
  })

  it('只有执行中任务时为 running', () => {
    const summary = selectBusSummary([running('a'), done('b')])
    expect(summary.status).toBe('running')
    expect(summary.latest?.id).toBe('a')
    expect(summary.unreadCount).toBe(1)
  })

  it('空闲时按首条未查看结果给出 done / failed', () => {
    expect(selectBusSummary([done('a')]).status).toBe('done')
    expect(selectBusSummary([failed('a')]).status).toBe('failed')
    expect(selectBusSummary([done('a')]).unreadFirst?.id).toBe('a')
  })
})
