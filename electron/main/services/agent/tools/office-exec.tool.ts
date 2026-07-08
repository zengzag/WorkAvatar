import type { ToolDefinition } from './types'
import * as vm from 'vm'
import * as path from 'path'
import * as docxTemplateHelper from './docx-template.helper'
import * as pptxTemplateHelper from './pptx-template.helper'
import { isPathInWorkspace, confirmOutsideWorkspace } from './fs-tools'

const OFFICE_MODULES: Record<string, any> = {}
const MODULE_LOAD_ERRORS: Record<string, string> = {}

function loadOfficeModules() {
  const modules = ['docx', 'pptxgenjs', 'xlsx', 'adm-zip']
  for (const name of modules) {
    try {
      OFFICE_MODULES[name] = require(name)
    } catch (e: any) {
      MODULE_LOAD_ERRORS[name] = e.message || String(e)
    }
  }
  // 本地实现的模板/编辑能力模块，基于 adm-zip 操作 OOXML
  OFFICE_MODULES['docx-template'] = docxTemplateHelper
  OFFICE_MODULES['pptx-template'] = pptxTemplateHelper
}

loadOfficeModules()

const ALLOWED_NODE_MODULES = ['fs', 'path', 'os', 'stream', 'buffer', 'util', 'crypto']

/** 沙箱中允许暴露给 LLM 生成代码的环境变量白名单（避免泄漏 API key、数据库路径等敏感信息） */
const ALLOWED_ENV_KEYS = ['PATH', 'Path', 'TEMP', 'TMP', 'OS', 'PLATFORM', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']

const MAX_CONSOLE_OUTPUT = 10000

/**
 * 从 JS 代码中提取**写/删上下文**中的绝对路径（用于执行前预扫描与非工作区确认）。
 * 只提取会被写入/删除的路径，不提取仅读取的路径（如 inspect/readFileSync 的参数）。
 */
function extractWritePathsFromCode(code: string): string[] {
  const paths: string[] = []
  let m: RegExpExecArray | null

  // 1. fs 写/删方法：路径为第一个字符串参数
  const fsWriteRe = /\.(writeFileSync|appendFileSync|unlinkSync|rmSync|rmdirSync|mkdirSync|copyFileSync|renameSync|truncateSync|writeFile|appendFile|unlink|rm|rmdir|mkdir|copyFile|rename|truncate)\s*\(\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = fsWriteRe.exec(code)) !== null) {
    if (!m[2].includes('node_modules')) paths.push(m[2])
  }

  // 2. docx-template / pptx-template 写函数：outputPath 为最后一个字符串参数
  //    函数列表：createFromTemplate, renderTemplate, replaceText, setParagraphText, spliceParagraphs (docx)
  //              replaceText (pptx)
  const tplFuncs = ['createFromTemplate', 'renderTemplate', 'replaceText', 'setParagraphText', 'spliceParagraphs']
  for (const fn of tplFuncs) {
    // 匹配 .fn( ... ) 调用体，提取其中最后一个绝对路径字符串（即 outputPath）
    const re = new RegExp(`\\.${fn}\\s*\\(([^)]*)\\)`, 'g')
    let match: RegExpExecArray | null
    while ((match = re.exec(code)) !== null) {
      const args = match[1]
      const pathRe = /["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
      let lastPath: string | null = null
      let pm: RegExpExecArray | null
      while ((pm = pathRe.exec(args)) !== null) {
        if (!pm[1].includes('node_modules')) lastPath = pm[1]
      }
      if (lastPath) paths.push(lastPath)
    }
  }

  return [...new Set(paths)]
}

/** 创建带路径校验的 fs 包装：写/删操作仅允许工作区内或已确认的路径 */
function createSandboxedFs(workspacePath: string, authorizedPaths: Set<string>): any {
  const realFs = require('fs')
  const workspaceRoot = path.resolve(workspacePath)

  const checkPath = (p: string): void => {
    if (typeof p !== 'string') return
    let resolved: string
    try { resolved = path.resolve(p) } catch { return }
    const isInWorkspace = resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep)
    if (isInWorkspace) return
    if (authorizedPaths.has(resolved.toLowerCase())) return
    throw new Error(
      `安全限制：office_exec 禁止操作工作区外文件 ${resolved}（工作区: ${workspaceRoot}）。` +
      `如需操作工作区外文件，请使用 write_file/delete_item 等文件工具，它们会弹出确认对话框。`
    )
  }

  // 写/删/新建类同步方法
  const writeSyncMethods = new Set([
    'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync',
    'mkdirSync', 'copyFileSync', 'renameSync', 'createWriteStream',
    'truncateSync', 'ftruncateSync',
  ])
  // 写/删/新建类异步方法
  const writeAsyncMethods = new Set([
    'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir',
    'mkdir', 'copyFile', 'rename', 'truncate',
  ])

  const wrapFn = (target: any, method: string, check: (p: string) => void) => {
    const original = target[method]
    if (typeof original !== 'function') return
    target[method] = (...args: any[]) => {
      if (args.length > 0 && typeof args[0] === 'string') check(args[0])
      return original.apply(target, args)
    }
  }

  const wrappedFs: any = {}
  // 拷贝所有属性
  for (const key of Object.keys(realFs)) {
    wrappedFs[key] = realFs[key]
  }
  // 包装同步写/删方法
  for (const method of writeSyncMethods) {
    wrapFn(wrappedFs, method, checkPath)
  }
  for (const method of writeAsyncMethods) {
    wrapFn(wrappedFs, method, checkPath)
  }

  // 包装 fs.promises
  if (realFs.promises) {
    const realPromises = realFs.promises
    const wrappedPromises: any = {}
    for (const key of Object.keys(realPromises)) {
      wrappedPromises[key] = realPromises[key]
    }
    for (const method of writeAsyncMethods) {
      if (typeof realPromises[method] === 'function') {
        wrapFn(wrappedPromises, method, checkPath)
      }
    }
    // promises 中特有的写方法（rmdir 已废弃改为 rm，但都覆盖）
    for (const method of ['mkdir', 'rm', 'unlink', 'copyFile', 'rename', 'writeFile', 'appendFile', 'truncate']) {
      if (typeof realPromises[method] === 'function') {
        wrapFn(wrappedPromises, method, checkPath)
      }
    }
    wrappedFs.promises = wrappedPromises
  }

  return wrappedFs
}

/**
 * 包装 docx-template / pptx-template 模块：写函数（outputPath 为最后一个参数）
 * 在运行时检查输出路径是否在工作区内或已确认，作为预扫描的运行时兜底。
 */
function createSandboxedTemplateModule(
  moduleName: string,
  rawModule: any,
  workspacePath: string,
  authorizedPaths: Set<string>,
): any {
  const workspaceRoot = path.resolve(workspacePath)
  // 这些函数的最后一个参数是 outputPath
  const writeFunctions = new Set([
    'createFromTemplate', 'renderTemplate', 'replaceText',
    'setParagraphText', 'spliceParagraphs',
  ])

  const checkOutputPath = (p: string): void => {
    if (typeof p !== 'string') return
    let resolved: string
    try { resolved = path.resolve(p) } catch { return }
    const isInWorkspace = resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep)
    if (isInWorkspace) return
    if (authorizedPaths.has(resolved.toLowerCase())) return
    throw new Error(
      `安全限制：${moduleName} 输出路径 ${resolved} 在工作区外（工作区: ${workspaceRoot}）。` +
      `请将文件保存到工作区内，或先确认工作区外路径后再执行。`
    )
  }

  const wrapper: any = {}
  for (const key of Object.keys(rawModule)) {
    const original = rawModule[key]
    if (typeof original === 'function' && writeFunctions.has(key)) {
      wrapper[key] = (...args: any[]) => {
        const outputPath = args[args.length - 1]
        if (typeof outputPath === 'string') checkOutputPath(outputPath)
        return original.apply(rawModule, args)
      }
    } else {
      wrapper[key] = original
    }
  }
  return wrapper
}

function createSandboxedRequire(workspacePath: string, authorizedPaths: Set<string>) {
  let cachedFs: any = null
  let cachedDocxTemplate: any = null
  let cachedPptxTemplate: any = null
  return (moduleName: string) => {
    if (moduleName === 'docx-template') {
      if (!cachedDocxTemplate) {
        cachedDocxTemplate = createSandboxedTemplateModule(
          'docx-template', OFFICE_MODULES['docx-template'], workspacePath, authorizedPaths,
        )
      }
      return cachedDocxTemplate
    }
    if (moduleName === 'pptx-template') {
      if (!cachedPptxTemplate) {
        cachedPptxTemplate = createSandboxedTemplateModule(
          'pptx-template', OFFICE_MODULES['pptx-template'], workspacePath, authorizedPaths,
        )
      }
      return cachedPptxTemplate
    }
    // 其他 OFFICE_MODULES 直接返回（不涉及文件写入）
    if (OFFICE_MODULES[moduleName] && moduleName !== 'docx-template' && moduleName !== 'pptx-template') {
      return OFFICE_MODULES[moduleName]
    }
    if (moduleName === 'fs') {
      if (!cachedFs) cachedFs = createSandboxedFs(workspacePath, authorizedPaths)
      return cachedFs
    }
    if (ALLOWED_NODE_MODULES.includes(moduleName)) return require(moduleName)
    const available = [
      ...Object.keys(OFFICE_MODULES).filter(k => OFFICE_MODULES[k]),
      ...ALLOWED_NODE_MODULES,
    ]
    throw new Error(
      `Module "${moduleName}" is not available in the office sandbox. Available modules: ${available.join(', ')}`
    )
  }
}

export const officeExecTool: ToolDefinition = {
  id: 'office_exec',
  name: 'office_exec',
  title: 'Office文档生成',
  description: '在Node.js沙箱中执行JavaScript代码，创建或编辑Office文档（Word/PowerPoint/Excel）。使用前请先调用 office_guide 获取详细使用说明和代码模板。',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的JavaScript代码，支持async/await' },
      working_dir: { type: 'string', description: '工作目录（文件操作基准路径），默认为当前员工工作区' },
      timeout: { type: 'number', description: '超时时间（秒），默认60秒，最大300秒', minimum: 1, maximum: 300 },
    },
    required: ['code'],
  },
  handler: async (args: any) => {
    const code = String(args.code || '').trim()
    if (!code) return { success: false, error: '代码不能为空' }

    const workingDir = String(args.working_dir || process.cwd())
    const timeoutMs = Math.min(Math.max((args.timeout || 60), 1), 300) * 1000

    const consoleOutput: string[] = []

    // 执行前预扫描：提取代码中**写/删上下文**的绝对路径，对非工作区路径弹窗确认
    // 注意：只提取写入/删除路径，不提取读取路径（如 inspect/readFileSync 的参数）
    const authorizedPaths = new Set<string>()
    const writePaths = extractWritePathsFromCode(code)
    for (const p of writePaths) {
      if (!isPathInWorkspace(p)) {
        const result = await confirmOutsideWorkspace('修改', p)
        if (!result.ok) return { success: false, error: result.error }
        try { authorizedPaths.add(path.resolve(p).toLowerCase()) } catch { /* 忽略解析失败的路径 */ }
      }
    }

    const sandboxedRequire = createSandboxedRequire(workingDir, authorizedPaths)

    // 追踪沙箱内创建的定时器，执行结束后统一清理，避免事件循环无法退出
    const trackedTimers: NodeJS.Timeout[] = []
    const wrapTimer = (original: typeof setTimeout | typeof setInterval) => (fn: any, ms?: number, ...args: any[]) => {
      const t = (original as any)(fn, ms, ...args) as NodeJS.Timeout
      trackedTimers.push(t)
      return t
    }
    const wrapImmediate = (original: typeof setImmediate) => (fn: any, ...args: any[]) => {
      const t = (original as any)(fn, ...args) as NodeJS.Timeout
      trackedTimers.push(t)
      return t
    }
    const clearTracked = (t: NodeJS.Timeout) => {
      clearTimeout(t)
      clearInterval(t)
      clearImmediate(t as unknown as NodeJS.Immediate)
      const idx = trackedTimers.indexOf(t)
      if (idx >= 0) trackedTimers.splice(idx, 1)
    }

    const sandbox: Record<string, any> = {
      require: sandboxedRequire,
      console: {
        log: (...a: any[]) => consoleOutput.push(a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ')),
        error: (...a: any[]) => consoleOutput.push('[ERROR] ' + a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ')),
        warn: (...a: any[]) => consoleOutput.push('[WARN] ' + a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ')),
        info: (...a: any[]) => consoleOutput.push(a.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ')),
      },
      __workspaceDir: workingDir,
      __dirname: workingDir,
      process: {
        cwd: () => workingDir,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([k]) => ALLOWED_ENV_KEYS.includes(k))
        ),
        platform: process.platform,
        versions: process.versions,
        nextTick: process.nextTick,
      },
      Buffer,
      Uint8Array,
      ArrayBuffer,
      Int8Array,
      Uint16Array,
      Int16Array,
      Uint32Array,
      Int32Array,
      Float32Array,
      Float64Array,
      DataView,
      setTimeout: wrapTimer(setTimeout),
      clearTimeout: clearTracked,
      setInterval: wrapTimer(setInterval),
      clearInterval: clearTracked,
      setImmediate: wrapImmediate(setImmediate),
      clearImmediate: clearTracked,
      Promise,
      JSON,
      Math,
      Date,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      ReferenceError,
      URIError,
      EvalError,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Symbol,
      Map,
      Set,
      WeakMap,
      WeakSet,
      RegExp,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      TextEncoder,
      TextDecoder,
      undefined,
      NaN,
      Infinity,
    }

    try {
      const context = vm.createContext(sandbox)
      const wrappedCode = `(async () => {\n${code}\n})()`
      const script = new vm.Script(wrappedCode, { filename: 'office-exec.js' })

      const resultPromise = script.runInContext(context, { timeout: timeoutMs })

      let asyncTimer: NodeJS.Timeout | undefined
      const asyncTimeoutPromise = new Promise<never>((_, reject) => {
        asyncTimer = setTimeout(() => reject(new Error('执行超时（异步操作未在规定时间内完成）')), timeoutMs)
      })

      try {
        await Promise.race([resultPromise, asyncTimeoutPromise])
      } finally {
        if (asyncTimer) clearTimeout(asyncTimer)
        for (const t of trackedTimers) {
          clearTimeout(t)
          clearInterval(t)
          clearImmediate(t as unknown as NodeJS.Immediate)
        }
        trackedTimers.length = 0
      }

      let output = consoleOutput.join('\n')
      if (output.length > MAX_CONSOLE_OUTPUT) {
        output = output.substring(0, MAX_CONSOLE_OUTPUT / 2)
          + `\n\n... (${output.length - MAX_CONSOLE_OUTPUT} 字符已截断) ...\n\n`
          + output.substring(output.length - MAX_CONSOLE_OUTPUT / 2)
      }

      return {
        success: true,
        output: output || '(无输出)',
      }
    } catch (error: any) {
      let output = consoleOutput.join('\n')
      if (output.length > MAX_CONSOLE_OUTPUT) {
        output = output.substring(0, MAX_CONSOLE_OUTPUT / 2)
          + `\n\n... (截断) ...\n\n`
          + output.substring(output.length - MAX_CONSOLE_OUTPUT / 2)
      }

      let errorMessage = error.message || String(error)

      if (error.stack) {
        const stackLines = error.stack.split('\n')
        const relevantLines = stackLines.filter(
          (line: string) => line.includes('office-exec.js') || line.includes('Error')
        )
        if (relevantLines.length > 0 && relevantLines.length < stackLines.length) {
          errorMessage = relevantLines.join('\n')
        }
      }

      return {
        success: false,
        error: errorMessage,
        output: output || undefined,
      }
    }
  },
  source: 'builtin',
  timeoutMs: 120000,
}

export function getOfficeModuleStatus(): Record<string, { loaded: boolean; error?: string }> {
  const status: Record<string, { loaded: boolean; error?: string }> = {}
  for (const name of ['docx', 'pptxgenjs', 'xlsx', 'adm-zip', 'docx-template', 'pptx-template']) {
    status[name] = {
      loaded: !!OFFICE_MODULES[name],
      error: MODULE_LOAD_ERRORS[name],
    }
  }
  return status
}
