import { useCallback, useEffect, useRef } from 'react'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppearanceStore, getEffectiveTheme } from '../../stores/appearance.store'
import type { TerminalEvent } from '../../../electron/shared/ipc-channels'
import type { ITheme } from '@xterm/xterm'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const TERMINAL_FONT_FAMILY = "ui-monospace, 'Cascadia Mono', 'Cascadia Code', Consolas, 'Menlo', monospace"
const TERMINAL_FONT_SIZE = 12.5
const SCROLLBACK = 5000

const ANSI_DARK: Pick<ITheme, 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'> = {
  black: '#3a3a3a', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
  blue: '#3b82f6', magenta: '#a855f7', cyan: '#06b6d4', white: '#e5e7eb',
  brightBlack: '#6b7280', brightRed: '#f87171', brightGreen: '#4ade80', brightYellow: '#facc15',
  brightBlue: '#60a5fa', brightMagenta: '#c084fc', brightCyan: '#22d3ee', brightWhite: '#f9fafb',
}

const ANSI_LIGHT: typeof ANSI_DARK = {
  black: '#1f2328', red: '#cf222e', green: '#116329', yellow: '#9a6700',
  blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#57606a',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#7d4e00',
  brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
}

function buildXtermTheme(dark: boolean, bg: string, fg: string): ITheme {
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: dark ? 'rgba(125, 125, 125, 0.35)' : 'rgba(84, 110, 122, 0.25)',
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  }
}

/** ANSI 包装 */
const ansi = {
  dim: (text: string) => `\x1b[90m${text}\x1b[0m`,
  prompt: (text: string) => `\x1b[32m${text}\x1b[0m`,
  error: (text: string) => `\x1b[31m${text}\x1b[0m`,
  clearLine: '\x1b[2K\r',
}

/** onData 闭包创建早于主题 effect，错误文案经 ref 共享 */
const errorMessageRef = { current: (code?: string) => code || '' }

interface TaskTerminalProps {
  terminalId: string
  rootPath: string
  /** 视图是否可见：隐藏时尺寸为 0，重新可见时重新适配 */
  active: boolean
  /** 每条命令结束后通知父级刷新文件树（命令可能改动了工作区） */
  onCommandFinished?: () => void
}

/**
 * 任务工作区终端：xterm.js 负责终端仿真渲染（完整 ANSI 颜色、光标、
 * 选中复制、自动折行与回滚），数据源仍是命令级执行（terminal:exec/event）。
 */
const TaskTerminal: React.FC<TaskTerminalProps> = ({ terminalId, rootPath, active, onCommandFinished }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const themeMode = useAppearanceStore((s) => s.themeMode)
  const effectiveTheme = getEffectiveTheme(themeMode)

  const hostRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  const cwdRef = useRef(rootPath)
  const inputRef = useRef('')
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const runningRef = useRef(false)
  const lastOutputCharRef = useRef('')
  const finishedRef = useRef(onCommandFinished)
  useEffect(() => { finishedRef.current = onCommandFinished }, [onCommandFinished])

  const writePrompt = useCallback(() => {
    xtermRef.current?.write(`\r\n${ansi.prompt('❯')} `)
  }, [])

  const redrawLine = useCallback(() => {
    xtermRef.current?.write(`\r${ansi.clearLine}${ansi.prompt('❯')} ${inputRef.current}`)
  }, [])

  // 终端实例生命周期：terminalId 变化时整体重建（面板侧以 key 触发）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const dark = effectiveTheme === 'dark'
    const xterm = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: SCROLLBACK,
      convertEol: true,
      theme: buildXtermTheme(dark, dark ? '#171717' : (token.colorBgLayout ?? '#f5f5f5'), dark ? '#d4d4d4' : (token.colorText ?? '#1f1f1f')),
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(host)
    try { fit.fit() } catch { /* 容器尚未布局时忽略 */ }
    xtermRef.current = xterm
    fitRef.current = fit

    cwdRef.current = rootPath
    inputRef.current = ''
    historyIndexRef.current = -1
    runningRef.current = false
    xterm.write(`${ansi.dim(rootPath)}\r\n${ansi.prompt('❯')} `)
    xterm.focus()

    const resizeObserver = new ResizeObserver(() => {
      try { fit.fit() } catch { /* 容器尺寸为 0 时忽略 */ }
    })
    resizeObserver.observe(host)

    const dataDisposer = xterm.onData((data) => {
      // 运行中：Ctrl+C 终止，其余输入丢弃
      if (runningRef.current) {
        if (data === '\x03') window.electronAPI.terminal.stop(terminalId)
        return
      }
      if (data === '\r') {
        const command = inputRef.current.trim()
        inputRef.current = ''
        if (!command) {
          xterm.write('\r\n')
          writePrompt()
          return
        }
        historyRef.current = [...historyRef.current.filter((item) => item !== command), command].slice(-100)
        historyIndexRef.current = historyRef.current.length
        xterm.write('\r\n')
        runningRef.current = true
        lastOutputCharRef.current = ''
        void window.electronAPI.terminal.exec({ terminalId, cwd: cwdRef.current, command })
          .then((result) => {
            if (result?.cwd && result.cwd !== cwdRef.current) {
              cwdRef.current = result.cwd
              xterm.write(`${ansi.dim(result.cwd)}\r\n`)
            }
            if (!result?.ok) {
              xterm.write(`${ansi.error(errorMessageRef.current(result?.error))}\r\n`)
              runningRef.current = false
              writePrompt()
            }
          })
          .catch((error: unknown) => {
            xterm.write(`${ansi.error(String((error as Error)?.message || error))}\r\n`)
            runningRef.current = false
            writePrompt()
          })
        return
      }
      if (data === '\x7f') {
        if (inputRef.current.length === 0) return
        inputRef.current = inputRef.current.slice(0, -1)
        xterm.write('\b \b')
        return
      }
      if (data === '\x03') {
        inputRef.current = ''
        xterm.write('^C')
        writePrompt()
        return
      }
      if (data === '\x1b[A' || data === '\x1b[B') {
        const history = historyRef.current
        if (history.length === 0) return
        if (data === '\x1b[A') {
          historyIndexRef.current = Math.max(0, historyIndexRef.current - 1)
        } else {
          historyIndexRef.current = Math.min(history.length, historyIndexRef.current + 1)
        }
        inputRef.current = history[historyIndexRef.current] ?? ''
        redrawLine()
        return
      }
      // 忽略其余控制序列，只接受可打印输入（行尾编辑模型）
      if (data.startsWith('\x1b')) return
      const printable = data.replace(/[\x00-\x1f\x7f]/g, '')
      if (!printable) return
      inputRef.current += printable
      xterm.write(printable)
    })

    return () => {
      dataDisposer.dispose()
      resizeObserver.disconnect()
      if (runningRef.current) window.electronAPI.terminal.stop(terminalId)
      xterm.dispose()
      xtermRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId])

  // 主题切换：同步 xterm 配色
  useEffect(() => {
    const xterm = xtermRef.current
    if (!xterm) return
    const dark = effectiveTheme === 'dark'
    xterm.options.theme = buildXtermTheme(dark, dark ? '#171717' : (token.colorBgLayout ?? '#f5f5f5'), dark ? '#d4d4d4' : (token.colorText ?? '#1f1f1f'))
  }, [effectiveTheme, token.colorBgLayout, token.colorText])

  // 视图重新可见时重新适配（display:none 期间尺寸为 0）
  useEffect(() => {
    if (!active) return
    const id = requestAnimationFrame(() => {
      try { fitRef.current?.fit() } catch { /* noop */ }
    })
    return () => cancelAnimationFrame(id)
  }, [active])

  // 输出 / 退出事件
  useEffect(() => {
    errorMessageRef.current = (code?: string) => {
      switch (code) {
        case 'busy': return t('workbench.terminalBusy')
        case 'outside': return t('workbench.terminalOutside')
        case 'not-directory': return t('workbench.terminalNotDirectory')
        case 'invalid-cwd': return t('workbench.terminalInvalidCwd')
        default: return code || t('workbench.terminalFailed')
      }
    }

    const unsubscribe = window.electronAPI.terminal.onEvent((event: TerminalEvent) => {
      if (event.terminalId !== terminalId) return
      const xterm = xtermRef.current
      if (!xterm) return
      if (event.type === 'output') {
        // 原样写入（保留 ANSI 颜色与 \r 覆盖语义），交给 xterm 渲染
        xterm.write(event.text)
        const stripped = event.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
        if (stripped.length > 0) lastOutputCharRef.current = stripped[stripped.length - 1]
        return
      }
      // exit：补齐末行换行后回到提示符
      cwdRef.current = event.cwd
      if (lastOutputCharRef.current && lastOutputCharRef.current !== '\n') xterm.write('\r\n')
      if (event.code !== 0) {
        xterm.write(ansi.dim(event.code === null
          ? t('workbench.terminalStopped')
          : t('workbench.terminalExit', { code: event.code })))
        xterm.write('\r\n')
      }
      runningRef.current = false
      writePrompt()
      xterm.scrollToBottom()
      finishedRef.current?.()
    })
    return () => { unsubscribe() }
  }, [terminalId, t, writePrompt])

  // 右击：有选中文本时复制到剪贴板，否则把剪贴板内容粘贴到当前输入行（运行中不可粘贴）
  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const xterm = xtermRef.current
    if (!xterm) return
    const selection = xterm.getSelection()
    if (selection) {
      navigator.clipboard.writeText(selection).catch(() => {})
      xterm.focus()
      return
    }
    if (runningRef.current) return
    navigator.clipboard.readText()
      .then((text) => {
        // 行编辑模型只接受单行可打印字符：换行折成空格、剔除控制字符
        const printable = text.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '')
        if (!printable || xtermRef.current !== xterm || runningRef.current) return
        inputRef.current += printable
        xterm.write(printable)
      })
      .catch(() => { /* 剪贴板不可用时忽略 */ })
      .finally(() => { xtermRef.current?.focus() })
  }, [])

  return (
    <div
      ref={hostRef}
      data-testid="task-terminal"
      onClick={() => xtermRef.current?.focus()}
      onContextMenu={handleContextMenu}
      style={{
        flex: 1,
        minHeight: 0,
        margin: '8px 10px 10px',
        borderRadius: 8,
        overflow: 'hidden',
        border: `1px solid ${token.colorBorderSecondary}`,
      }}
    />
  )
}

export default TaskTerminal
