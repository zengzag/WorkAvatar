import { describe, it, expect } from 'vitest'
import { parseVersion, engineSatisfies, PLUGIN_PROTOCOL_VERSION } from '../../../electron/main/services/plugin/plugin-host.service'

describe('parseVersion', () => {
  it('解析完整 x.y.z', () => {
    expect(parseVersion('0.2.0')).toEqual([0, 2, 0])
    expect(parseVersion('1.10.3')).toEqual([1, 10, 3])
  })

  it('忽略前后空白与后缀', () => {
    expect(parseVersion('  0.2.0 ')).toEqual([0, 2, 0])
    expect(parseVersion('0.2.0-beta.1')).toEqual([0, 2, 0])
  })

  it('非版本串返回 null', () => {
    expect(parseVersion('abc')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('0.2')).toBeNull()
  })
})

describe('engineSatisfies', () => {
  const host = PLUGIN_PROTOCOL_VERSION // 宿主协议版本 0.2.0

  it('* 与空范围恒满足', () => {
    expect(engineSatisfies('*', host)).toBe(true)
    expect(engineSatisfies('', host)).toBe(true)
  })

  it('裸版本按 >= 语义', () => {
    expect(engineSatisfies('0.2.0', '0.2.0')).toBe(true)
    expect(engineSatisfies('0.2.1', '0.2.0')).toBe(false)
    expect(engineSatisfies('0.1.0', host)).toBe(true)
  })

  it('比较符语义', () => {
    expect(engineSatisfies('>=0.2.0', host)).toBe(true)
    expect(engineSatisfies('>=0.3.0', host)).toBe(false)
    expect(engineSatisfies('<=0.2.0', host)).toBe(true)
    expect(engineSatisfies('<=0.1.0', host)).toBe(false)
    expect(engineSatisfies('>0.1.0', host)).toBe(true)
    expect(engineSatisfies('<0.2.0', host)).toBe(false)
    expect(engineSatisfies('<0.3.0', host)).toBe(true)
  })

  it('^ 只能同主版本', () => {
    expect(engineSatisfies('^0.2.0', '0.2.5')).toBe(true)
    expect(engineSatisfies('^0.2.0', '0.3.0')).toBe(false)
    expect(engineSatisfies('^1.0.0', '1.2.3')).toBe(true)
    expect(engineSatisfies('^1.0.0', '2.0.0')).toBe(false)
  })

  it('^ 对 0.x 锁定次版本、0.0.x 锁定补丁', () => {
    expect(engineSatisfies('^0.2.0', '0.2.0')).toBe(true)
    expect(engineSatisfies('^0.2.0', '0.1.9')).toBe(false)
    expect(engineSatisfies('^0.0.3', '0.0.3')).toBe(true)
    expect(engineSatisfies('^0.0.3', '0.0.4')).toBe(false)
    expect(engineSatisfies('^0.0.3', '0.1.0')).toBe(false)
  })

  it('空白分隔多段需全满足（AND）', () => {
    expect(engineSatisfies('>=0.1.0 <0.3.0', '0.2.0')).toBe(true)
    expect(engineSatisfies('>=0.1.0 <0.2.0', '0.2.0')).toBe(false)
    expect(engineSatisfies('>=0.1.0 ^0.2.0', '0.2.5')).toBe(true)
  })

  it('* 段跳过比较', () => {
    expect(engineSatisfies('>=*', host)).toBe(true)
    expect(engineSatisfies('* <0.3.0', '0.2.0')).toBe(true)
  })

  it('非法范围/宿主版本返回 false，不抛错', () => {
    expect(engineSatisfies('abc', host)).toBe(false)
    expect(engineSatisfies('0.2.0 0.3.0', host)).toBe(false) // 双版本且之间无比较符 → 整体假
    expect(engineSatisfies('>=0.2.0', 'not-a-version')).toBe(false)
  })

  it('跨主版本边界比较正确', () => {
    expect(engineSatisfies('>=2.0.0 <3.0.0', '2.5.0')).toBe(true)
    expect(engineSatisfies('>=2.0.0 <3.0.0', '3.0.0')).toBe(false)
    expect(engineSatisfies('>=1.9.0', '2.0.0')).toBe(true)
  })
})