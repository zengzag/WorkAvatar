import { describe, expect, it } from 'vitest'
import { tokenizeFileName, tokenizeQueryTerm } from '../../../electron/main/services/kms/kms-text-tokens'

describe('kms-text-tokens', () => {
  it('为中文文件名生成单字和二元 token', () => {
    const tokens = tokenizeFileName('季度报告.docx', 'C:/资料/2026')
    expect(tokens).toContain('季')
    expect(tokens).toContain('季度')
    expect(tokens).toContain('docx')
  })

  it('中文查询生成可命中二元 token', () => {
    expect(tokenizeQueryTerm('季度')).toEqual(['季度'])
  })

  it('英文查询保留完整词', () => {
    expect(tokenizeQueryTerm('report')).toEqual(['report'])
  })
})
