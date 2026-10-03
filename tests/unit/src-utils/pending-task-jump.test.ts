import { describe, it, expect, beforeEach } from 'vitest'

// node 环境补齐 localStorage 最小实现
const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
})

import { requestPendingTaskJump, subscribePendingTaskJump } from '../../../src/utils/pending-task-jump'

it('监听中的消费者立即收到跳转请求', () => {
  const received: unknown[] = []
  const off = subscribePendingTaskJump((j) => received.push(j))
  off
  requestPendingTaskJump('emp1', 'conv1')
  expect(received).toEqual([{ employeeId: 'emp1', conversationId: 'conv1' }])
  off()
})

it('导航前写入的持久化残留由后续订阅者兜底消费（一次性）', () => {
  requestPendingTaskJump('emp2', 'conv2')
  const received: unknown[] = []
  const off = subscribePendingTaskJump((j) => received.push(j))
  expect(received).toEqual([{ employeeId: 'emp2', conversationId: 'conv2' }])
  off()
  // 消费后不再重复触发
  const again: unknown[] = []
  const off2 = subscribePendingTaskJump((j) => again.push(j))
  expect(again).toEqual([])
  off2()
})

it('畸形的持久化数据被忽略不抛错', () => {
  localStorage.setItem('tasks:pendingTaskJump', 'not-json')
  const received: unknown[] = []
  const off = subscribePendingTaskJump((j) => received.push(j))
  expect(received).toEqual([])
  off()
})

it('取消订阅后不再接收', () => {
  const received: unknown[] = []
  const off = subscribePendingTaskJump((j) => received.push(j))
  off()
  requestPendingTaskJump('e', 'c')
  expect(received).toEqual([])
})

it('有活跃消费者时直接分发且不残留持久化数据（重挂载不重复跳转）', () => {
  const received: unknown[] = []
  const off = subscribePendingTaskJump((j) => received.push(j))
  received.length = 0
  requestPendingTaskJump('emp3', 'conv3')
  expect(received).toEqual([{ employeeId: 'emp3', conversationId: 'conv3' }])
  off()

  // 不残留：新订阅者不应再收到
  const again: unknown[] = []
  const off2 = subscribePendingTaskJump((j) => again.push(j))
  expect(again).toEqual([])
  off2()
})
