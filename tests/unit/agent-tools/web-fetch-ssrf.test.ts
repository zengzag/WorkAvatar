import { describe, it, expect, vi, afterEach } from 'vitest'
import { isPrivateOrLocalTarget, resolveRedirectTarget, fetchWithGuardedRedirects } from '../../../electron/main/services/agent/tools/web-fetch.tool'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 构造仅含实现所需字段的假 Response */
const mkResponse = (status: number, location?: string) => ({
  status,
  headers: { get: (k: string) => (k.toLowerCase() === 'location' ? (location ?? null) : null) },
  body: { cancel: vi.fn(async () => {}) },
}) as unknown as Response

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

describe('agent/tools/web-fetch / 重定向防护（防 30x 跳向内网绕过 SSRF）', () => {
  it('resolveRedirectTarget 拒绝内网/本机目标', () => {
    expect(() => resolveRedirectTarget('http://127.0.0.1/x', 'https://a.com/', 0)).toThrow()
    expect(() => resolveRedirectTarget('http://169.254.169.254/latest', 'https://a.com/', 0)).toThrow()
    expect(() => resolveRedirectTarget('http://[::ffff:127.0.0.1]/', 'https://a.com/', 0)).toThrow()
    expect(() => resolveRedirectTarget('http://localhost/', 'https://a.com/', 0)).toThrow()
  })

  it('resolveRedirectTarget 拒绝非法协议与无效 Location', () => {
    expect(() => resolveRedirectTarget('file:///etc/passwd', 'https://a.com/', 0)).toThrow()
    expect(() => resolveRedirectTarget('ftp://a.com/x', 'https://a.com/', 0)).toThrow()
    expect(() => resolveRedirectTarget('http://[::bad', 'https://a.com/', 0)).toThrow()
  })

  it('resolveRedirectTarget 放行公网目标并支持相对路径解析', () => {
    expect(resolveRedirectTarget('https://b.com/x', 'https://a.com/', 0).href).toBe('https://b.com/x')
    expect(resolveRedirectTarget('/next', 'https://a.com/dir/', 0).href).toBe('https://a.com/next')
  })

  it('resolveRedirectTarget 超过跳数上限拒绝', () => {
    expect(() => resolveRedirectTarget('https://b.com/', 'https://a.com/', 5)).toThrow(/上限/)
  })

  it('fetchWithGuardedRedirects 拒绝 302 跳向内网', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mkResponse(302, 'http://127.0.0.1/')))
    await expect(fetchWithGuardedRedirects('https://evil.com/')).rejects.toThrow()
  })

  it('fetchWithGuardedRedirects 正常跟随外网 302 链，且全程 redirect=manual', async () => {
    const f = vi.fn(async (url: string) => (url === 'https://a.com/' ? mkResponse(302, 'https://b.com/') : mkResponse(200)))
    vi.stubGlobal('fetch', f)
    const res = await fetchWithGuardedRedirects('https://a.com/')
    expect(res.status).toBe(200)
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('fetchWithGuardedRedirects 超过 5 跳拒绝', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => { n++; return mkResponse(302, `https://h${n}.com/`) }))
    await expect(fetchWithGuardedRedirects('https://a.com/')).rejects.toThrow(/上限/)
  })

  it('fetchWithGuardedRedirects 无 Location 的 3xx 原样返回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mkResponse(301)))
    const res = await fetchWithGuardedRedirects('https://a.com/')
    expect(res.status).toBe(301)
  })
})
