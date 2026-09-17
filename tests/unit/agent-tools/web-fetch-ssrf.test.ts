import { describe, it, expect } from 'vitest'
import { isPrivateOrLocalTarget } from '../../../electron/main/services/agent/tools/web-fetch.tool'

describe('agent/tools/web-fetch / isPrivateOrLocalTarget（SSRF 防护）', () => {
  it('拒绝 localhost 与内网域名', () => {
    expect(isPrivateOrLocalTarget('localhost')).toBe(true)
    expect(isPrivateOrLocalTarget('a.localhost')).toBe(true)
    expect(isPrivateOrLocalTarget('foo.local')).toBe(true)
    expect(isPrivateOrLocalTarget('svc.internal')).toBe(true)
  })

  it('拒绝 loopback/私网/链路本地/保留段 IPv4', () => {
    expect(isPrivateOrLocalTarget('127.0.0.1')).toBe(true)
    expect(isPrivateOrLocalTarget('10.0.0.5')).toBe(true)
    expect(isPrivateOrLocalTarget('172.16.0.1')).toBe(true)
    expect(isPrivateOrLocalTarget('172.31.255.255')).toBe(true)
    expect(isPrivateOrLocalTarget('192.168.1.1')).toBe(true)
    expect(isPrivateOrLocalTarget('169.254.169.254')).toBe(true) // 云 metadata
    expect(isPrivateOrLocalTarget('0.0.0.0')).toBe(true)
    expect(isPrivateOrLocalTarget('224.0.0.1')).toBe(true) // 组播
  })

  it('放行公网 IPv4', () => {
    expect(isPrivateOrLocalTarget('8.8.8.8')).toBe(false)
    expect(isPrivateOrLocalTarget('1.2.3.4')).toBe(false)
    expect(isPrivateOrLocalTarget('172.32.0.1')).toBe(false)
  })

  it('非标准 IPv4 字面量（inet_aton 变体）归一化判定', () => {
    // 127.1 / 2130706433 / 0x7f000001 均解析为 127.0.0.1
    expect(isPrivateOrLocalTarget('127.1')).toBe(true)
    expect(isPrivateOrLocalTarget('2130706433')).toBe(true)
    expect(isPrivateOrLocalTarget('0x7f000001')).toBe(true)
    // 公网整数形式放行
    expect(isPrivateOrLocalTarget('134744072')).toBe(false) // 8.8.8.8
    // 十六进制 mapped IPv6
    expect(isPrivateOrLocalTarget('::ffff:7f00:1')).toBe(true)
  })

  it('拒绝 IPv6 loopback/链路本地/唯一本地', () => {
    expect(isPrivateOrLocalTarget('::1')).toBe(true)
    expect(isPrivateOrLocalTarget('fe80::1')).toBe(true)
    expect(isPrivateOrLocalTarget('fc00::1')).toBe(true)
    expect(isPrivateOrLocalTarget('fd12:3456::1')).toBe(true)
    expect(isPrivateOrLocalTarget('::ffff:127.0.0.1')).toBe(true)
  })

  it('放行公网 IPv6', () => {
    expect(isPrivateOrLocalTarget('2606:4700::1111')).toBe(false)
  })

  it('空主机名拒绝', () => {
    expect(isPrivateOrLocalTarget('')).toBe(true)
  })
})
