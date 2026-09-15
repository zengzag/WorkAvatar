// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { resolveModelLabel } from '../../../src/components/workbench/message-shared'

/**
 * src/components/workbench/message-shared：对比模式模型显示名解析（纯函数）
 * 该模块依赖 antd / react-markdown，需 DOM 环境。
 */

const providers = [
  { id: 'p1', models_json: JSON.stringify([{ model: 'm1', name: '模型一号' }, { model: 'm2', name: '' }]) },
  { id: 'p2', models_json: 'not-json' },
  { id: 'p3' },
]

describe('message-shared / resolveModelLabel', () => {
  it('缺少 providerId 或 modelId 时返回空串', () => {
    expect(resolveModelLabel({}, providers)).toBe('')
    expect(resolveModelLabel({ comparisonProviderId: 'p1' }, providers)).toBe('')
    expect(resolveModelLabel({ comparisonModelId: 'm1' }, providers)).toBe('')
    expect(resolveModelLabel({ comparisonProviderId: '', comparisonModelId: '' }, providers)).toBe('')
  })

  it('provider 不存在时回退为模型 id', () => {
    expect(resolveModelLabel({ comparisonProviderId: 'nope', comparisonModelId: 'm1' }, providers)).toBe('m1')
    expect(resolveModelLabel({ comparisonProviderId: 'p1', comparisonModelId: 'm1' }, [])).toBe('m1')
  })

  it('命中 provider 与模型时返回模型显示名', () => {
    expect(resolveModelLabel({ comparisonProviderId: 'p1', comparisonModelId: 'm1' }, providers)).toBe('模型一号')
  })

  it('模型名称为空串时回退为模型 id', () => {
    expect(resolveModelLabel({ comparisonProviderId: 'p1', comparisonModelId: 'm2' }, providers)).toBe('m2')
  })

  it('模型不在列表中时回退为模型 id', () => {
    expect(resolveModelLabel({ comparisonProviderId: 'p1', comparisonModelId: 'm9' }, providers)).toBe('m9')
  })

  it('models_json 非法 / 缺省时回退（不抛错）', () => {
    expect(resolveModelLabel({ comparisonProviderId: 'p2', comparisonModelId: 'm1' }, providers)).toBe('m1')
    expect(resolveModelLabel({ comparisonProviderId: 'p3', comparisonModelId: 'm1' }, providers)).toBe('m1')
  })

  it('models_json 解析为非数组（对象/null/字符串）时按空列表兜底，回退模型 id', () => {
    for (const json of [JSON.stringify({ m1: 'x' }), 'null', JSON.stringify('m1')]) {
      const bad = [{ id: 'p4', models_json: json }]
      expect(resolveModelLabel({ comparisonProviderId: 'p4', comparisonModelId: 'm1' }, bad)).toBe('m1')
    }
  })

  it('providers 为 undefined / 非数组时回退模型 id（不抛错）', () => {
    expect(resolveModelLabel({ comparisonProviderId: 'p1', comparisonModelId: 'm1' }, undefined as any)).toBe('m1')
    expect(resolveModelLabel({ comparisonProviderId: 'p1', comparisonModelId: 'm1' }, {} as any)).toBe('m1')
  })
})
