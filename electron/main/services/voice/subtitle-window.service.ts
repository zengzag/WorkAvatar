import { BrowserWindow, app, screen } from 'electron'
import path from 'path'
import { createLogger } from '../logger'
import type { VoiceSubtitleConfig } from '../../../shared/ipc-channels'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'

const logger = createLogger('SubtitleWindow')

const DEFAULT_SUBTITLE_CONFIG: VoiceSubtitleConfig = {
  enabled: false,
  fontSize: 28,
  textColor: '#ffffff',
  backgroundColor: '#000000',
  backgroundOpacity: 60,
  windowWidth: 600,
  windowHeight: 120,
}

class SubtitleWindowService {
  private static instance: SubtitleWindowService
  private subtitleWindow: BrowserWindow | null = null
  private currentConfig: VoiceSubtitleConfig = { ...DEFAULT_SUBTITLE_CONFIG }
  private currentTexts: Map<string, string> = new Map()

  private constructor() {}

  static getInstance(): SubtitleWindowService {
    if (!SubtitleWindowService.instance) {
      SubtitleWindowService.instance = new SubtitleWindowService()
    }
    return SubtitleWindowService.instance
  }

  private getPreloadPath(): string {
    const isDev = !app.isPackaged
    if (isDev) {
      return path.join(process.cwd(), 'dist-electron', 'preload', 'index.js')
    }
    return path.join(__dirname, '..', 'preload', 'index.js')
  }

  /** 创建悬浮字幕窗口 */
  private createWindow(): BrowserWindow {
    const config = this.currentConfig
    const display = screen.getPrimaryDisplay()
    const workArea = display.workArea

    // 默认放置在屏幕底部居中
    const x = Math.round(workArea.x + (workArea.width - config.windowWidth) / 2)
    const y = Math.round(workArea.y + workArea.height - config.windowHeight - 60)

    const win = new BrowserWindow({
      width: config.windowWidth,
      height: config.windowHeight,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: this.getPreloadPath(),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
    })

    // 窗口失焦时不隐藏（保持始终可见）
    win.setAlwaysOnTop(true, 'screen-saver')

    win.on('closed', () => {
      this.subtitleWindow = null
    })

    // 加载字幕页面（使用 data URL，内联 HTML+CSS+JS）
    win.loadURL(this.getDataUrl())

    win.webContents.on('did-finish-load', () => {
      // 发送当前配置和文本
      win.webContents.send(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_SETTINGS, this.currentConfig)
      this.currentTexts.forEach((text, source) => {
        win.webContents.send(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_TEXT, { text, source })
      })
    })

    return win
  }

  /** 生成内联 HTML data URL（使用 preload 暴露的 electronAPI） */
  private getDataUrl(): string {
    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: transparent; overflow: hidden; user-select: none; -webkit-app-region: drag; border-radius: 12px; transition: background 0.2s; }
#subtitle { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: stretch; justify-content: flex-end; padding: 12px 20px; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; text-align: center; word-break: break-all; line-height: 1.5; transition: font-size 0.2s, color 0.2s; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; -ms-overflow-style: none; }
#subtitle::-webkit-scrollbar { display: none; }
.subtitle-line { display: flex; align-items: center; justify-content: center; gap: 6px; flex-shrink: 0; }
.subtitle-line + .subtitle-line { margin-top: 4px; }
.subtitle-icon { flex-shrink: 0; }
</style>
</head>
<body>
<div id="subtitle"></div>
<script>
(function() {
  var el = document.getElementById('subtitle');
  var api = window.electronAPI;
  var texts = {};
  if (!api || !api.voice) { el.textContent = 'Subtitle API not available'; return; }
  function render() {
    var keys = Object.keys(texts);
    if (keys.length === 0) { el.innerHTML = ''; return; }
    var html = '';
    var hasMultiple = keys.length > 1;
    for (var i = 0; i < keys.length; i++) {
      var src = keys[i];
      var txt = texts[src];
      if (!txt) continue;
      var icon = '';
      if (hasMultiple) {
        if (src === 'mic') { icon = '<span class="subtitle-icon">\uD83C\uDFA4</span>'; }
        else if (src === 'system') { icon = '<span class="subtitle-icon">\uD83D\uDD0A</span>'; }
      }
      html += '<div class="subtitle-line">' + icon + '<span>' + escHtml(txt) + '</span></div>';
    }
    el.innerHTML = html || '';
    // 自动滚动到最新字幕
    el.scrollTop = el.scrollHeight;
  }
  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  api.voice.onSubtitleText(function(data) {
    var src = data.source || '_default';
    if (data.text) { texts[src] = data.text; }
    else { delete texts[src]; }
    render();
  });
  api.voice.onSubtitleSettings(function(cfg) {
    if (!cfg) return;
    el.style.fontSize = (cfg.fontSize || 28) + 'px';
    el.style.color = cfg.textColor || '#fff';
    var opacity = (cfg.backgroundOpacity != null ? cfg.backgroundOpacity : 60) / 100;
    var bg = cfg.backgroundColor || '#000';
    var n = parseInt(bg.slice(1), 16);
    document.body.style.background = 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + opacity + ')';
  });
})();
</script>
</body>
</html>`
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
  }

  /** 显示悬浮字幕窗口 */
  show(config?: VoiceSubtitleConfig): void {
    if (config) {
      this.currentConfig = { ...this.currentConfig, ...config }
    }

    if (!this.subtitleWindow) {
      this.subtitleWindow = this.createWindow()
    }

    const win = this.subtitleWindow
    if (!win) return

    // 应用窗口尺寸
    win.setSize(this.currentConfig.windowWidth, this.currentConfig.windowHeight)

    if (!win.isVisible()) {
      win.show()
    }

    // 发送最新配置
    win.webContents.send(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_SETTINGS, this.currentConfig)
    logger.info('Subtitle window shown')
  }

  /** 隐藏悬浮字幕窗口 */
  hide(): void {
    if (this.subtitleWindow) {
      this.subtitleWindow.hide()
      this.currentTexts.clear()
      logger.info('Subtitle window hidden')
    }
  }

  /** 切换悬浮字幕窗口显示状态 */
  toggle(): boolean {
    if (this.subtitleWindow && this.subtitleWindow.isVisible()) {
      this.hide()
      return false
    }
    this.show()
    return true
  }

  /** 更新字幕文本 */
  updateText(text: string, source?: 'mic' | 'system'): void {
    const key = source || '_default'
    this.currentTexts.set(key, text)
    if (this.subtitleWindow && this.subtitleWindow.isVisible()) {
      this.subtitleWindow.webContents.send(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_TEXT, { text, source })
    }
  }

  /** 清除指定来源的字幕文本 */
  clearSource(source: string): void {
    this.currentTexts.delete(source)
    if (this.subtitleWindow && this.subtitleWindow.isVisible()) {
      this.subtitleWindow.webContents.send(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_TEXT, { text: '', source })
    }
  }

  /** 更新字幕外观配置 */
  updateConfig(config: VoiceSubtitleConfig): void {
    this.currentConfig = { ...this.currentConfig, ...config }

    if (this.subtitleWindow) {
      const win = this.subtitleWindow
      // 更新窗口尺寸
      if (win.getSize()[0] !== config.windowWidth || win.getSize()[1] !== config.windowHeight) {
        win.setSize(config.windowWidth, config.windowHeight)
      }
      // 发送新配置
      win.webContents.send(IPC_CHANNELS.VOICE_SUBTITLE_UPDATE_SETTINGS, this.currentConfig)
    }

    // 如果配置中禁用了字幕，隐藏窗口
    if (!config.enabled && this.subtitleWindow && this.subtitleWindow.isVisible()) {
      this.hide()
    }
  }

  /** 获取窗口当前是否可见 */
  isVisible(): boolean {
    return !!this.subtitleWindow && this.subtitleWindow.isVisible()
  }

  /** 销毁窗口（应用退出时调用） */
  destroy(): void {
    if (this.subtitleWindow) {
      this.subtitleWindow.destroy()
      this.subtitleWindow = null
    }
  }
}

export default SubtitleWindowService
