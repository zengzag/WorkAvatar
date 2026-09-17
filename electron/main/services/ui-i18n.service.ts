/**
 * 主进程 UI 文案：系统托盘、原生对话框、系统通知等无法交给渲染端本地化的文案。
 * 语言初始取自渲染端写入的 settings KV `appearance_locale`；渲染端调用 setLocale 后以显式设置为准
 * （否则"先 setLocale 后写库"期间会被库中旧语言覆盖），变更时通知订阅者刷新（如托盘菜单）。
 */
import { EventEmitter } from 'node:events'
import DatabaseService from './database.service'
import { createLogger } from './logger'

const logger = createLogger('MainUiI18n')

export type MainLocale = 'zh-CN' | 'en-US'

const SETTINGS_KEY_LOCALE = 'appearance_locale'

const STRINGS = {
  trayTooltip: { 'zh-CN': 'WorkAvatar 数字员工', 'en-US': 'WorkAvatar Digital Employees' },
  trayShowWindow: { 'zh-CN': '显示窗口', 'en-US': 'Show Window' },
  trayQuit: { 'zh-CN': '退出程序', 'en-US': 'Quit' },

  pluginLoadTitle: { 'zh-CN': '加载插件', 'en-US': 'Load Plugin' },
  pluginLoadMessage: { 'zh-CN': '是否加载这个插件？', 'en-US': 'Load this plugin?' },
  pluginLoadDetail: {
    'zh-CN': '{{name}}\n确认后将安装并加载该插件。',
    'en-US': '{{name}}\nThe plugin will be installed and loaded after confirmation.',
  },
  pluginLoadConfirm: { 'zh-CN': '加载', 'en-US': 'Load' },
  pluginCancel: { 'zh-CN': '取消', 'en-US': 'Cancel' },
  pluginOk: { 'zh-CN': '确定', 'en-US': 'OK' },
  pluginExistsTitle: { 'zh-CN': '插件已存在', 'en-US': 'Plugin Already Installed' },
  pluginExistsMessage: {
    'zh-CN': '已安装相同插件，是否覆盖升级？',
    'en-US': 'The same plugin is already installed. Overwrite and upgrade it?',
  },
  pluginUpgradeConfirm: { 'zh-CN': '覆盖升级', 'en-US': 'Upgrade' },
  pluginLoadedTitle: { 'zh-CN': '插件已加载', 'en-US': 'Plugin Loaded' },
  pluginLoadedMessage: {
    'zh-CN': '插件 {{id}} v{{version}} 已加载',
    'en-US': 'Plugin {{id}} v{{version}} is loaded',
  },
  pluginLoadFailedTitle: { 'zh-CN': '加载失败', 'en-US': 'Load Failed' },

  askUserNotifyTitle: {
    'zh-CN': '数字员工需要您的确认',
    'en-US': 'A digital employee needs your confirmation',
  },

  ocrInitFailedTitle: { 'zh-CN': 'OCR 初始化失败', 'en-US': 'OCR Initialization Failed' },
  ocrRuntimeErrorTitle: { 'zh-CN': 'OCR 运行异常', 'en-US': 'OCR Runtime Error' },
  ocrRecognizeFailedTitle: { 'zh-CN': 'OCR 识别失败', 'en-US': 'OCR Recognition Failed' },
  ocrModelMissing: {
    'zh-CN': 'PaddleOCR 模型文件缺失，OCR 功能不可用',
    'en-US': 'PaddleOCR model files are missing, so OCR is unavailable',
  },
  ocrWorkerInitFailed: {
    'zh-CN': 'PaddleOCR Worker 初始化失败',
    'en-US': 'Failed to initialize the PaddleOCR worker',
  },
  ocrWorkerCrashed: {
    'zh-CN': 'OCR Worker 崩溃退出，图片识别不可用',
    'en-US': 'The OCR worker crashed, so image recognition is unavailable',
  },
  ocrRecognizeFailed: { 'zh-CN': 'PaddleOCR 识别失败', 'en-US': 'PaddleOCR recognition failed' },
  ocrPathLabel: { 'zh-CN': '路径', 'en-US': 'Path' },
  ocrImageLabel: { 'zh-CN': '图片', 'en-US': 'Image' },

  runtimeUvDesc: {
    'zh-CN': 'Python 包管理器，可一键安装并管理 Python 解释器，是脚本运行 Python 的首选依赖',
    'en-US': 'Python package manager that can install and manage Python interpreters in one click; the recommended way to run Python scripts',
  },
  runtimePythonDesc: { 'zh-CN': '运行 Python 脚本（.py 文件）', 'en-US': 'Run Python scripts (.py files)' },
  runtimePythonHint: {
    'zh-CN': '请先安装 uv，再通过 uv 一键安装 Python',
    'en-US': 'Install uv first, then install Python with one click through uv',
  },
  runtimeNodeDesc: {
    'zh-CN': '运行 JavaScript / TypeScript 脚本，并提供 npm 包管理',
    'en-US': 'Run JavaScript / TypeScript scripts and provides npm package management',
  },
  runtimeNodeHint: {
    'zh-CN': '请前往 https://nodejs.org 下载安装',
    'en-US': 'Download and install from https://nodejs.org',
  },
  runtimePipDesc: {
    'zh-CN': 'Python 包管理工具，随 Python 一同安装，用于安装脚本所需的 Python 依赖包',
    'en-US': 'Python package manager installed together with Python, used to install dependencies for scripts',
  },
  runtimePipHint: {
    'zh-CN': 'pip 随 Python 一同安装，请先安装 Python',
    'en-US': 'pip is installed together with Python, so install Python first',
  },
} as const

export type MainUiTextKey = keyof typeof STRINGS

class MainUiI18n {
  private emitter = new EventEmitter()
  private locale: MainLocale = 'zh-CN'
  /** 渲染端显式设置的语言覆盖：优先于 settings，避免"先 setLocale 后写库"期间被库中旧值覆盖 */
  private localeOverride: MainLocale | null = null

  private readLocaleFromDb(): MainLocale | null {
    try {
      const row = DatabaseService.getInstance().getDb()
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(SETTINGS_KEY_LOCALE) as { value?: string } | undefined
      return row?.value === 'en-US' ? 'en-US' : row?.value === 'zh-CN' ? 'zh-CN' : null
    } catch (err) {
      logger.debug('Read locale from settings failed:', err)
      return null
    }
  }

  getLocale(): MainLocale {
    if (this.localeOverride) return this.localeOverride
    const saved = this.readLocaleFromDb()
    if (saved) this.locale = saved
    return this.locale
  }

  /** 渲染端切换语言后调用：更新缓存并通知订阅者重刷 UI */
  setLocale(locale: MainLocale): void {
    const previous = this.getLocale()
    this.localeOverride = locale
    this.locale = locale
    if (locale === previous) return
    this.emitter.emit('locale-change', locale)
  }

  onLocaleChange(callback: (locale: MainLocale) => void): () => void {
    this.emitter.on('locale-change', callback)
    return () => { this.emitter.off('locale-change', callback) }
  }

  t(key: MainUiTextKey, params?: Record<string, string | number>): string {
    let text: string = STRINGS[key][this.getLocale()]
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.split(`{{${name}}}`).join(String(value))
      }
    }
    return text
  }
}

export const mainUiI18n = new MainUiI18n()
export default mainUiI18n
