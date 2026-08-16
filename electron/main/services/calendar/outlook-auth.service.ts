import { BrowserWindow } from 'electron'
import crypto from 'node:crypto'
import DatabaseService from '../database.service'
import { getSafeStorage } from '../llm-client-types'
import { createLogger } from '../logger'
import type { OutlookAccount } from '../../../shared/ipc-channels'

const logger = createLogger('OutlookAuth')

/**
 * Microsoft OAuth2 认证服务（公开客户端 + PKCE）。
 *
 * Azure 应用注册（个人账号需先在 azure.microsoft.com/free 建租户）：
 * - 重定向 URI：移动和桌面应用程序 → https://login.microsoftonline.com/common/oauth2/nativeclient
 * - 委托权限：offline_access / User.Read / Calendars.ReadWrite / Tasks.ReadWrite
 */
const CLIENT_ID = '79213b8d-d48b-4713-bee7-5b1d643fe1d7'
const AUTHORITY = 'https://login.microsoftonline.com/common'
const REDIRECT_URI = `${AUTHORITY}/oauth2/nativeclient`
const SCOPES = ['offline_access', 'User.Read', 'Calendars.ReadWrite', 'Tasks.ReadWrite']
const TOKEN_KEY = 'calendar_outlook_token'

interface StoredToken {
  access_token: string
  refresh_token: string
  /** access_token 过期时间，unix 秒 */
  expires_at: number
  account: OutlookAccount | null
}

class OutlookAuthService {
  private static instance: OutlookAuthService
  private db: any
  private cached: StoredToken | null = null

  private constructor() {
    this.db = DatabaseService.getInstance().getDb()
  }

  static getInstance(): OutlookAuthService {
    if (!OutlookAuthService.instance) {
      OutlookAuthService.instance = new OutlookAuthService()
    }
    return OutlookAuthService.instance
  }

  // ====== token 加密存储（safeStorage） ======

  private encrypt(plain: string): string {
    const safeStorage = getSafeStorage()
    if (safeStorage?.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString('base64')
    }
    return plain
  }

  private decrypt(text: string): string | null {
    try {
      const safeStorage = getSafeStorage()
      if (safeStorage?.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(text, 'base64'))
      }
      return text
    } catch {
      return null
    }
  }

  private loadToken(): StoredToken | null {
    if (this.cached) return this.cached
    try {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(TOKEN_KEY) as { value?: string } | undefined
      if (!row?.value) return null
      const json = this.decrypt(row.value)
      if (!json) return null
      const parsed = JSON.parse(json) as StoredToken
      if (!parsed.access_token || !parsed.refresh_token) return null
      this.cached = parsed
      return parsed
    } catch {
      return null
    }
  }

  private saveToken(token: StoredToken): void {
    this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(TOKEN_KEY, this.encrypt(JSON.stringify(token)))
    this.cached = token
  }

  private clearToken(): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(TOKEN_KEY)
    this.cached = null
  }

  // ====== 状态 ======

  isLoggedIn(): boolean {
    return !!this.loadToken()
  }

  getAccount(): OutlookAccount | null {
    return this.loadToken()?.account ?? null
  }

  logout(): void {
    this.clearToken()
    logger.info('Signed out')
  }

  /** 获取有效 access_token，过期自动刷新（MSA refresh token 每次刷新会轮换） */
  async getAccessToken(): Promise<string | null> {
    const token = this.loadToken()
    if (!token) return null
    if (token.expires_at > Math.floor(Date.now() / 1000) + 60) return token.access_token
    try {
      return await this.refreshAccessToken(token.refresh_token)
    } catch (err: any) {
      logger.error('Token refresh failed:', err?.message)
      // refresh_token 失效（过期/撤销），清除登录态
      this.clearToken()
      return null
    }
  }

  // ====== OAuth2 + PKCE ======

  async login(): Promise<OutlookAccount | { error: string }> {
    const state = crypto.randomBytes(16).toString('hex')
    const verifier = crypto.randomBytes(48).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

    const authUrl = new URL(`${AUTHORITY}/oauth2/v2.0/authorize`)
    authUrl.searchParams.set('client_id', CLIENT_ID)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authUrl.searchParams.set('scope', SCOPES.join(' '))
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('prompt', 'select_account')

    const code = await this.openAuthWindow(authUrl.toString(), state)
    if (typeof code !== 'string') return { error: code.error }

    try {
      const token = await this.exchangeCodeForToken(code, verifier)
      const account = await this.fetchAccount(token.access_token)
      this.saveToken({ ...token, account })
      logger.info(`Signed in: ${account?.email || 'unknown'}`)
      return account ?? { id: '', email: '', display_name: '' }
    } catch (err: any) {
      logger.error('Login failed:', err?.message)
      return { error: err?.message || '登录失败' }
    }
  }

  /** 打开授权窗口，拦截重定向到 nativeclient 的 code */
  private openAuthWindow(authUrl: string, state: string): Promise<string | { error: string }> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result: string | { error: string }) => {
        if (settled) return
        settled = true
        try { if (!win.isDestroyed()) win.close() } catch { /* ignore */ }
        resolve(result)
      }

      const win = new BrowserWindow({
        width: 520,
        height: 700,
        show: false,
        title: 'Outlook 登录',
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      })
      win.once('ready-to-show', () => win.show())

      const handleUrl = (url: string) => {
        if (!url.startsWith(REDIRECT_URI)) return
        const params = new URL(url).searchParams
        if (params.get('state') !== state) {
          finish({ error: 'state 校验失败' })
          return
        }
        const error = params.get('error_description') || params.get('error')
        const code = params.get('code')
        if (error) finish({ error })
        else if (code) finish(code)
      }

      // 授权完成是 302 重定向；SPA 内部导航兜底
      win.webContents.on('will-redirect', (_e, url) => handleUrl(url))
      win.webContents.on('did-navigate', (_e, url) => handleUrl(url))
      win.on('closed', () => finish({ error: '登录窗口已关闭' }))

      win.loadURL(authUrl).catch(err => finish({ error: err?.message || '无法打开登录页' }))
    })
  }

  private async exchangeCodeForToken(code: string, verifier: string): Promise<Omit<StoredToken, 'account'>> {
    return this.requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
    })
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const next = await this.requestToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: SCOPES.join(' '),
    })
    const current = this.loadToken()
    const updated: StoredToken = {
      ...next,
      // 个别情况下响应不含新 refresh_token，沿用旧值
      refresh_token: next.refresh_token || current?.refresh_token || '',
      account: current?.account ?? null,
    }
    this.saveToken(updated)
    return updated.access_token
  }

  private async requestToken(body: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_at: number }> {
    const resp = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    })
    const json: any = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      throw new Error(json.error_description || json.error || `token 请求失败 (${resp.status})`)
    }
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600),
    }
  }

  private async fetchAccount(accessToken: string): Promise<OutlookAccount | null> {
    try {
      const resp = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!resp.ok) return null
      const me: any = await resp.json()
      return {
        id: me.id || '',
        email: me.mail || me.userPrincipalName || '',
        display_name: me.displayName || '',
      }
    } catch {
      return null
    }
  }
}

export default OutlookAuthService
