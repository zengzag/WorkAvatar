import { describe, it, expect, vi } from 'vitest'
import { AgentContext } from '../../../electron/main/services/agent/core/agent-context'
import { AgentEventEmitter } from '../../../electron/main/services/agent/core/agent-events'

describe('agent-context / AgentContext', () => {
  it('默认生成前缀为 ctx_ 的唯一 id，并记录 agentName / createdAt', () => {
    const a = new AgentContext({ agentName: 'A' })
    const b = new AgentContext({ agentName: 'B' })
    expect(a.id).toMatch(/^ctx_[0-9a-f]{24}$/)
    expect(a.id).not.toBe(b.id)
    expect(a.agentName).toBe('A')
    expect(typeof a.createdAt).toBe('number')
    expect(a.createdAt).toBeLessThanOrEqual(Date.now())
  })

  it('显式传入 id 与 eventEmitter 时复用', () => {
    const emitter = new AgentEventEmitter()
    const ctx = new AgentContext({ id: 'fixed-id', agentName: 'A', eventEmitter: emitter })
    expect(ctx.id).toBe('fixed-id')
    expect(ctx.eventEmitter).toBe(emitter)
    const seen: any[] = []
    emitter.on('state:change', e => seen.push(e.data))
    ctx.setState('running')
    expect(seen).toEqual([{ from: 'idle', to: 'running' }])
  })

  it('setState 透传 from/to，连续切换时 from 为上一次状态', () => {
    const ctx = new AgentContext({ agentName: 'A' })
    const seen: any[] = []
    ctx.eventEmitter.on('state:change', e => seen.push(e.data))
    ctx.setState('running')
    ctx.setState('tool_calling')
    ctx.setState('completed')
    expect(seen).toEqual([
      { from: 'idle', to: 'running' },
      { from: 'running', to: 'tool_calling' },
      { from: 'tool_calling', to: 'completed' },
    ])
  })

  it('相同状态重复设置也会发事件（无去重）', () => {
    const ctx = new AgentContext({ agentName: 'A' })
    const handler = vi.fn()
    ctx.eventEmitter.on('state:change', handler)
    ctx.setState('running')
    ctx.setState('running')
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('incrementIteration 返回自增后的值，初始为 0', () => {
    const ctx = new AgentContext({ agentName: 'A' })
    expect(ctx.getIterationCount()).toBe(0)
    expect(ctx.incrementIteration()).toBe(1)
    expect(ctx.incrementIteration()).toBe(2)
    expect(ctx.getIterationCount()).toBe(2)
  })

  it('reset 清空迭代次数并回到 idle，且不发送状态事件', () => {
    const ctx = new AgentContext({ agentName: 'A' })
    const handler = vi.fn()
    ctx.eventEmitter.on('state:change', handler)
    ctx.incrementIteration()
    ctx.setState('error')
    handler.mockClear()
    ctx.reset()
    expect(ctx.getIterationCount()).toBe(0)
    expect(handler).not.toHaveBeenCalled()
    // reset 后再次 setState 的 from 为 idle
    ctx.setState('running')
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ data: { from: 'idle', to: 'running' } }))
  })
})

describe('agent-events / AgentEventEmitter', () => {
  it('emit 生成含 type/timestamp/data 的事件；data 缺省为 null', () => {
    const emitter = new AgentEventEmitter()
    const seen: any[] = []
    emitter.on('run:start', e => seen.push(e))
    emitter.emit('run:start')
    emitter.emit('run:start', { query: 'q' })
    expect(seen[0].type).toBe('run:start')
    expect(seen[0].data).toBeNull()
    expect(seen[1].data).toEqual({ query: 'q' })
    expect(typeof seen[0].timestamp).toBe('number')
    expect(seen[0].timestamp).toBeLessThanOrEqual(Date.now())
    // 显式 null 也归一为 null
    emitter.emit('run:start', null)
    expect(seen[2].data).toBeNull()
  })

  it('未注册的事件名不抛错，data 传 falsy 值原样保留', () => {
    const emitter = new AgentEventEmitter()
    expect(() => emitter.emit('plan:generated')).not.toThrow()
    const seen: any[] = []
    emitter.on('memory:compressed', e => seen.push(e.data))
    emitter.emit('memory:compressed', 0)
    emitter.emit('memory:compressed', false)
    emitter.emit('memory:compressed', '')
    expect(seen).toEqual([0, false, ''])
  })

  it('on 返回的取消函数仅移除自身 handler', () => {
    const emitter = new AgentEventEmitter()
    const a = vi.fn()
    const b = vi.fn()
    const offA = emitter.on('run:end', a)
    emitter.on('run:end', b)
    offA()
    emitter.emit('run:end', {})
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    // 重复取消不抛错
    expect(() => offA()).not.toThrow()
  })

  it('同一 handler 重复注册只触发一次（Set 去重）', () => {
    const emitter = new AgentEventEmitter()
    const handler = vi.fn()
    const off1 = emitter.on('iteration:start', handler)
    emitter.on('iteration:start', handler)
    emitter.emit('iteration:start', { iteration: 1 })
    expect(handler).toHaveBeenCalledTimes(1)
    off1() // 一次取消即移除
    emitter.emit('iteration:start', { iteration: 2 })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('handler 抛错被隔离，不影响后续 handler', () => {
    const emitter = new AgentEventEmitter()
    const after = vi.fn()
    emitter.on('tool:call:start', () => { throw new Error('handler boom') })
    emitter.on('tool:call:start', after)
    expect(() => emitter.emit('tool:call:start', { tool: 't' })).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('enabled=false 时 emit 静默跳过（handler 不触发）', () => {
    const emitter = new AgentEventEmitter({ enabled: false })
    const handler = vi.fn()
    emitter.on('run:start', handler)
    emitter.emit('run:start', { query: 'q' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('enabled 缺省为 true', () => {
    const emitter = new AgentEventEmitter()
    const handler = vi.fn()
    emitter.on('state:change', handler)
    emitter.emit('state:change', { from: 'idle', to: 'running' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('emit 过程中取消尚未执行的 handler：该 handler 本次不再执行（Set 迭代语义）', () => {
    const emitter = new AgentEventEmitter()
    const second = vi.fn()
    let offSecond: () => void = () => {}
    emitter.on('run:end', () => offSecond()) // 先注册者先执行，取消后者
    offSecond = emitter.on('run:end', second)
    emitter.emit('run:end', {})
    expect(second).not.toHaveBeenCalled()
  })

  it('不同事件类型的 handler 互不干扰', () => {
    const emitter = new AgentEventEmitter()
    const runStart = vi.fn()
    const runEnd = vi.fn()
    emitter.on('run:start', runStart)
    emitter.on('run:end', runEnd)
    emitter.emit('run:error', { error: 'x' })
    emitter.emit('run:start', {})
    expect(runStart).toHaveBeenCalledTimes(1)
    expect(runEnd).not.toHaveBeenCalled()
  })
})
