/**
 * 悬浮字幕窗口，由宿主 subtitle-window.service 迁移而来。
 * - 窗口经 ctx.services.windows.create 创建（自动纳入广播目标）
 * - 内容为内联 HTML data URL，渲染端用 window.electronAPI.plugin.onEvent('voice', cb) 订阅
 *   （宿主 preload 的 plugin.onEvent 回调参数为 { event, payload }，HTML 按 event 名分发）
 * - 字幕/配置更新统一用 ctx.ipc.broadcast 推送（handle.send 与插件桥通道不一致，收不到）
 */
import { screen } from 'electron'
import type { PluginContext, PluginLogger, PluginWindowHandle } from '../../../plugin-sdk/src'

export interface VoiceSubtitleConfig {
  /** 是否启用悬浮字幕 */
  enabled: boolean
  /** 字体大小（px） */
  fontSize: number
  /** 文字颜色 */
  textColor: string
  /** 背景颜色 */
  backgroundColor: string
  /** 背景不透明度（0-100） */
  backgroundOpacity: number
  /** 窗口宽度 */
  windowWidth: number
  /** 窗口高度 */
  windowHeight: number
}

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
  private static instance: SubtitleWindowService | null = null

  private logger: PluginLogger
  private subtitleWindow: PluginWindowHandle | null = null
  private currentConfig: VoiceSubtitleConfig = { ...DEFAULT_SUBTITLE_CONFIG }
  private currentTexts: Map<string, string> = new Map()

  private constructor(private ctx: PluginContext) {
    this.logger = ctx.services.logger
  }

  static getInstance(ctx?: PluginContext): SubtitleWindowService {
    if (!SubtitleWindowService.instance) {
      if (!ctx) throw new Error('SubtitleWindowService requires ctx on first init')
      SubtitleWindowService.instance = new SubtitleWindowService(ctx)
    }
    return SubtitleWindowService.instance
  }

  /** 创建悬浮字幕窗口（经宿主 services.windows.create，默认置底居中） */
  private createWindow(): PluginWindowHandle {
    const config = this.currentConfig
    const display = screen.getPrimaryDisplay()
    const workArea = display.workArea

    // 默认放置在屏幕底部居中
    const x = Math.round(workArea.x + (workArea.width - config.windowWidth) / 2)
    const y = Math.round(workArea.y + workArea.height - config.windowHeight - 60)

    const handle = this.ctx.services.windows!.create({
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
      url: this.getDataUrl(),
    })

    handle.onClosed(() => {
      this.subtitleWindow = null
    })

    return handle
  }

  /** 生成内联 HTML data URL（经插件桥 plugin.onEvent 订阅主进程广播） */
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
  if (!api || !api.plugin || !api.plugin.onEvent) { el.textContent = 'Subtitle API not available'; return; }
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
  function applyStyle(cfg) {
    if (!cfg) return;
    el.style.fontSize = (cfg.fontSize || 28) + 'px';
    el.style.color = cfg.textColor || '#fff';
    var opacity = (cfg.backgroundOpacity != null ? cfg.backgroundOpacity : 60) / 100;
    var bg = cfg.backgroundColor || '#000';
    var n = parseInt(bg.slice(1), 16);
    document.body.style.background = 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + opacity + ')';
  }
  // 宿主 plugin.onEvent(pluginId, cb) 回调参数为 { event, payload }，按 event 名分发
  api.plugin.onEvent('voice', function(msg) {
    if (!msg) return;
    if (msg.event === 'subtitle-text') {
      var data = msg.payload || {};
      var src = data.source || '_default';
      if (data.text) { texts[src] = data.text; }
      else { delete texts[src]; }
      render();
    } else if (msg.event === 'subtitle-settings') {
      applyStyle(msg.payload);
    }
  });
})();
</script>
</body>
</html>`
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
  }

  /** 将当前配置与全部字幕文本推送到渲染端（仅窗口可见时） */
  private pushState(): void {
    if (!this.subtitleWindow || !this.subtitleWindow.isVisible()) return
    this.ctx.ipc.broadcast('subtitle-settings', this.currentConfig)
    this.currentTexts.forEach((text, source) => {
      this.ctx.ipc.broadcast('subtitle-text', { text, source })
    })
  }

  /** 显示悬浮字幕窗口 */
  show(config?: VoiceSubtitleConfig): void {
    if (config) {
      this.currentConfig = { ...this.currentConfig, ...config }
    }

    if (!this.subtitleWindow) {
      this.subtitleWindow = this.createWindow()
    }

    const handle = this.subtitleWindow
    if (!handle) return

    // 应用窗口尺寸
    handle.setSize(this.currentConfig.windowWidth, this.currentConfig.windowHeight)

    if (!handle.isVisible()) {
      handle.show()
    }

    // 发送最新配置与当前文本
    this.pushState()
    // 首次创建时窗口内容可能尚未加载，延迟补发一次确保订阅后能收到初始配置与文本
    setTimeout(() => this.pushState(), 300)
    this.logger.info('Subtitle window shown')
  }

  /** 隐藏悬浮字幕窗口 */
  hide(): void {
    if (this.subtitleWindow) {
      this.subtitleWindow.hide()
      this.currentTexts.clear()
      this.logger.info('Subtitle window hidden')
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
      this.ctx.ipc.broadcast('subtitle-text', { text, source })
    }
  }

  /** 清除指定来源的字幕文本 */
  clearSource(source: string): void {
    this.currentTexts.delete(source)
    if (this.subtitleWindow && this.subtitleWindow.isVisible()) {
      this.ctx.ipc.broadcast('subtitle-text', { text: '', source })
    }
  }

  /** 更新字幕外观配置 */
  updateConfig(config: VoiceSubtitleConfig): void {
    const prevWidth = this.currentConfig.windowWidth
    const prevHeight = this.currentConfig.windowHeight
    this.currentConfig = { ...this.currentConfig, ...config }

    if (this.subtitleWindow) {
      const handle = this.subtitleWindow
      // 更新窗口尺寸
      if (config.windowWidth !== prevWidth || config.windowHeight !== prevHeight) {
        handle.setSize(config.windowWidth, config.windowHeight)
      }
      // 发送新配置
      this.ctx.ipc.broadcast('subtitle-settings', this.currentConfig)
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
      this.subtitleWindow.close()
      this.subtitleWindow = null
    }
  }
}

export default SubtitleWindowService
