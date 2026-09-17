import { describe, it, expect, beforeEach, vi } from 'vitest'

/** 通过 mock 交互服务覆盖 ask_user 的参数校验与响应分支 */
const interactionState = vi.hoisted(() => ({
  response: {} as any,
  requests: [] as any[],
  throwOnRequest: false,
}))

vi.mock('../../../electron/main/services/unified-interaction.service', () => ({
  default: {
    getInstance: () => ({
      request: async (req: any) => {
        if (interactionState.throwOnRequest) throw new Error('交互通道不可用')
        interactionState.requests.push(req)
        return interactionState.response
      },
    }),
  },
  INTERACTION_TIMEOUT_MS: 300000,
}))

const { askUserTool } = await import('../../../electron/main/services/agent/tools/ask-user.tool')

const ask = (args: any) => askUserTool.handler!(args) as Promise<any>
const lastRequest = () => interactionState.requests[interactionState.requests.length - 1]

describe('agent/tools/ask-user.tool', () => {
  beforeEach(() => {
    interactionState.response = { cancelled: false, confirmed: true }
    interactionState.requests = []
    interactionState.throwOnRequest = false
  })

  it('消息为空时不发起交互', async () => {
    expect(await ask({ type: 'confirm' })).toMatchObject({ success: false, error: '消息内容不能为空' })
    expect(await ask({ type: 'confirm', message: '' })).toMatchObject({ success: false, error: '消息内容不能为空' })
    expect(interactionState.requests).toHaveLength(0)
  })

  it('type 缺省为 confirm，默认标题「确认」与默认值 no', async () => {
    await ask({ message: '继续吗' })
    expect(lastRequest()).toMatchObject({ type: 'confirm', title: '确认', message: '继续吗', source: 'ask_user', defaultValue: 'no' })
  })

  it('自定义标题优先于默认标题', async () => {
    await ask({ type: 'select', title: '选择方案', message: 'M', options: [{ label: 'A', value: 'a' }] })
    expect(lastRequest().title).toBe('选择方案')
  })

  it('select/input 的默认标题分别为「请选择」「请输入」', async () => {
    await ask({ type: 'select', message: 'M', options: [{ label: 'A', value: 'a' }] })
    expect(lastRequest().title).toBe('请选择')
    interactionState.response = { cancelled: false, inputValue: 'x' }
    await ask({ type: 'input', message: 'M' })
    expect(lastRequest().title).toBe('请输入')
  })

  it('confirm：确认与拒绝分别映射为不同输出', async () => {
    expect(await ask({ type: 'confirm', message: 'M' })).toMatchObject({
      success: true, confirmed: true, output: '用户确认了操作',
    })
    interactionState.response = { cancelled: false, confirmed: false }
    expect(await ask({ type: 'confirm', message: 'M' })).toMatchObject({
      success: true, confirmed: false, output: '用户拒绝了操作',
    })
  })

  it('confirm：confirmed 非严格 true（如字符串）视为拒绝', async () => {
    interactionState.response = { cancelled: false, confirmed: 'yes' }
    expect((await ask({ type: 'confirm', message: 'M' })).confirmed).toBe(false)
  })

  it('select：缺少选项/非数组/空数组均报错且不发起交互', async () => {
    for (const options of [undefined, 'A,B', [], null]) {
      const res = await ask({ type: 'select', message: 'M', options })
      expect(res).toMatchObject({ success: false, error: 'select类型必须提供至少一个选项' })
    }
    expect(interactionState.requests).toHaveLength(0)
  })

  it('select：选项字段做兜底归一（label/value 互相回退，danger 严格判 true）', async () => {
    interactionState.response = { cancelled: false, selectedValue: 'a' }
    await ask({
      type: 'select',
      message: 'M',
      options: [
        { value: 'a' },
        { label: 'B' },
        { label: 'C', value: 'c', description: '', danger: 'yes' },
        { label: 'D', value: 'd', description: '说明', danger: true },
      ],
    })
    expect(lastRequest().options).toEqual([
      { label: 'a', value: 'a', description: undefined, danger: false },
      { label: 'B', value: 'B', description: undefined, danger: false },
      { label: 'C', value: 'c', description: undefined, danger: false },
      { label: 'D', value: 'd', description: '说明', danger: true },
    ])
  })

  it('select：成功时返回所选值与可读输出', async () => {
    interactionState.response = { cancelled: false, selectedValue: 'b' }
    expect(await ask({ type: 'select', message: 'M', options: [{ label: 'B', value: 'b' }] })).toMatchObject({
      success: true, selectedValue: 'b', output: '用户选择了: b',
    })
  })

  it('input：placeholder 与 default_value 空值时不下发；空输入有占位输出', async () => {
    interactionState.response = { cancelled: false, inputValue: '' }
    const res = await ask({ type: 'input', message: 'M', placeholder: '', default_value: '' })
    expect(lastRequest().placeholder).toBeUndefined()
    expect(lastRequest().defaultValue).toBeUndefined()
    expect(res).toMatchObject({ success: true, inputValue: '', output: '(空输入)' })
  })

  it('input：正常回显输入值', async () => {
    interactionState.response = { cancelled: false, inputValue: '42' }
    expect(await ask({ type: 'input', message: 'M', placeholder: '数字', default_value: '1' })).toMatchObject({
      success: true, inputValue: '42', output: '42',
    })
    expect(lastRequest()).toMatchObject({ placeholder: '数字', defaultValue: '1' })
  })

  it('取消（超时）与取消（主动）返回不同错误文案，并带 cancelled 标记', async () => {
    interactionState.response = { cancelled: true, timedOut: true }
    expect(await ask({ type: 'confirm', message: 'M' })).toMatchObject({
      success: false, cancelled: true, error: '用户在5分钟内未响应，可能不在电脑旁',
    })
    interactionState.response = { cancelled: true }
    expect(await ask({ type: 'confirm', message: 'M' })).toMatchObject({
      success: false, cancelled: true, error: '用户取消了交互',
    })
  })

  it('未知交互类型在用户响应后报不支持', async () => {
    interactionState.response = { cancelled: false }
    const res = await ask({ type: 'weird', message: 'M' })
    expect(res).toMatchObject({ success: false, error: '不支持的交互类型: weird' })
  })

  it('交互服务抛错被收敛为可读错误', async () => {
    interactionState.throwOnRequest = true
    expect(await ask({ type: 'confirm', message: 'M' })).toMatchObject({
      success: false, error: '询问用户失败: 交互通道不可用',
    })
  })

  it('工具元信息：noRetry 且超时覆盖交互超时', () => {
    expect(askUserTool.noRetry).toBe(true)
    expect(askUserTool.timeoutMs).toBe(300000 + 5000)
    expect(askUserTool.permission).toBeUndefined()
    expect(askUserTool.onDemand).toBeFalsy()
    expect(askUserTool.parameters.required).toEqual(['type', 'message'])
  })
})
