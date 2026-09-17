import { describe, it, expect } from 'vitest'
import {
  formatFileSize,
  parseNaturalTime,
  generateUUID,
  formatDate,
  safeCalculate,
} from '../../../electron/main/services/agent/tools/utils'

/**
 * 补充 tools-utils 的边界行为（基础用例见 tools-utils.test.ts）。
 * 重点：数值类型/非法值、日期回绕、数字串与数字的语义差异。
 */

describe('agent/tools/utils / formatFileSize 边界', () => {
  it('非法数值（NaN/±Infinity）与负数均返回 0 B', () => {
    expect(formatFileSize(NaN)).toBe('0 B')
    expect(formatFileSize(Infinity)).toBe('0 B')
    expect(formatFileSize(-Infinity)).toBe('0 B')
    expect(formatFileSize(-1)).toBe('0 B')
    expect(formatFileSize(-1024)).toBe('0 B')
  })

  it('小于 1KB 时保留原始字节数', () => {
    expect(formatFileSize(1)).toBe('1 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('小数字节四舍五入到 2 位（跟随 toFixed）', () => {
    expect(formatFileSize(1.5)).toBe('1.5 B')
    expect(formatFileSize(1024 + 0.4)).toBe('1 KB')
  })

  it('最大单位 TB：超过 TB 不再升级单位', () => {
    expect(formatFileSize(1024 ** 4)).toBe('1 TB')
    expect(formatFileSize(1024 ** 5)).toBe('1024 TB')
  })

  it('2 位小数后为 0 时省略（5.5KB 而非 5.50KB）', () => {
    expect(formatFileSize(1024 * 5.5)).toBe('5.5 KB')
    expect(formatFileSize(1024 * 1024 * 3)).toBe('3 MB')
  })
})

describe('agent/tools/utils / parseNaturalTime 边界', () => {
  it('非有限数值（±Infinity/NaN）返回 null（不再原样返回）', () => {
    // 修复前只判 isNaN，Infinity 会原样返回，下游时间戳计算会得到无效时间
    expect(parseNaturalTime(Infinity)).toBeNull()
    expect(parseNaturalTime(-Infinity)).toBeNull()
    expect(parseNaturalTime(NaN)).toBeNull()
  })

  it('数值语义与数字串统一：绝对值 ≥ 1e12 视为毫秒折算为秒，否则视为秒', () => {
    expect(parseNaturalTime(0)).toBe(0)
    expect(parseNaturalTime(-100)).toBe(-100)
    expect(parseNaturalTime(1750000000)).toBe(1750000000)
    expect(parseNaturalTime(1750000000000)).toBe(1750000000)
  })

  it('13 位毫秒数字串与同值 number 语义一致（均按毫秒折算）', () => {
    expect(parseNaturalTime('1750000000000')).toBe(1750000000)
    expect(parseNaturalTime(1750000000000)).toBe(1750000000)
  })

  it('布尔/对象等非数字非字符串输入回退 Date 解析后返回 null', () => {
    expect(parseNaturalTime(true)).toBeNull()
    expect(parseNaturalTime({})).toBeNull()
    expect(parseNaturalTime([])).toBeNull()
  })

  it('9/11/12 位数字串不按 unix 时间处理', () => {
    expect(parseNaturalTime('123456789')).toBeNull()
    expect(parseNaturalTime('17500000001')).toBeNull()
    expect(parseNaturalTime('175000000012')).toBeNull()
  })

  it('带小数的数字串无法解析', () => {
    expect(parseNaturalTime('1750000000.9')).toBeNull()
  })

  it('日期时间允许 1 位月/日与缺秒（本地时区）', () => {
    const expected = Math.floor(new Date(2026, 6, 4, 9, 5, 0).getTime() / 1000)
    expect(parseNaturalTime('2026-7-4 9:05')).toBe(expected)
    expect(parseNaturalTime('2026.7.4 09：05')).toBe(expected)
  })

  it('非法日期（JS Date 静默回绕）改为返回 null', () => {
    // 2026-02-30 会被 Date 回绕为 3/2，回读校验发现年月日不一致 → null
    expect(parseNaturalTime('2026-02-30')).toBeNull()
    // 全零日期同样不再是 1899-11-30
    expect(parseNaturalTime('0000-00-00')).toBeNull()
  })

  it('合法日期（含闰日）仍正常解析，未过度拒绝', () => {
    expect(parseNaturalTime('2024-02-29')).toBe(Math.floor(new Date(2024, 1, 29).getTime() / 1000))
    expect(parseNaturalTime('2024-02-29 08:30')).toBe(Math.floor(new Date(2024, 1, 29, 8, 30).getTime() / 1000))
  })

  it('日期时间正则未锚定结尾，尾部多余内容被忽略', () => {
    const expected = Math.floor(new Date(2026, 6, 24, 15, 30, 0).getTime() / 1000)
    expect(parseNaturalTime('2026-07-24 15:30 多余文本')).toBe(expected)
  })

  it('月日超界的纯日期模式返回 null（2026-13-45）', () => {
    expect(parseNaturalTime('2026-13-45')).toBeNull()
  })

  it('ISO 带时区偏移的字符串交给 Date 兜底解析', () => {
    const iso = '2026-07-24T15:30:00+08:00'
    expect(parseNaturalTime(iso)).toBe(Math.floor(new Date(iso).getTime() / 1000))
  })
})

describe('agent/tools/utils / 其它导出', () => {
  it('generateUUID 返回 24 位 hex（96bit）且不重复', () => {
    const a = generateUUID()
    const b = generateUUID()
    expect(a).toMatch(/^[0-9a-f]{24}$/)
    expect(a).not.toBe(b)
  })

  it('formatDate 填充 2 位并替换全部占位符', () => {
    const d = new Date(2026, 0, 5, 7, 8, 9)
    expect(formatDate(d, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-01-05 07:08:09')
    expect(formatDate(d, 'YYYY/MM/DD')).toBe('2026/01/05')
    // 未识别的占位符原样保留
    expect(formatDate(d, 'YYYY-MM')).toBe('2026-01')
  })

  it('safeCalculate 支持百分号/幂运算，非法表达式抛错', () => {
    expect(safeCalculate('1+2*3')).toBe(7)
    expect(safeCalculate('50%')).toBe(0.5)
    expect(safeCalculate('2^3')).toBe(8)
    expect(() => safeCalculate('')).toThrow()
    expect(() => safeCalculate('abc')).toThrow()
  })
})
