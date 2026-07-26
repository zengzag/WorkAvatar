import type { ToolDefinition } from './types'
import type { GeneratedFileInfo } from '../../../../shared/types'
import * as vm from 'vm'
import * as path from 'path'
import * as fs from 'fs'
import { isPathInWorkspace, confirmOutsideWorkspace, getWorkspacePath } from './fs-tools'
import { moveToTrash } from '../../common-utils'
import { interactionContext } from '../../unified-interaction.service'

const OFFICE_MODULES: Record<string, any> = {}
const MODULE_LOAD_ERRORS: Record<string, string> = {}

function loadOfficeModules() {
  // 必须用字符串字面量 require，Vite 才能正确外部化（变量 require 会被打包导致 ESM 模块加载失败）
  try { OFFICE_MODULES['docx'] = require('docx') } catch (e: any) { MODULE_LOAD_ERRORS['docx'] = e.message || String(e) }
  try { OFFICE_MODULES['pptxgenjs'] = require('pptxgenjs') } catch (e: any) { MODULE_LOAD_ERRORS['pptxgenjs'] = e.message || String(e) }
  try { OFFICE_MODULES['xlsx'] = require('xlsx') } catch (e: any) { MODULE_LOAD_ERRORS['xlsx'] = e.message || String(e) }
  try { OFFICE_MODULES['adm-zip'] = require('adm-zip') } catch (e: any) { MODULE_LOAD_ERRORS['adm-zip'] = e.message || String(e) }
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

  // 1. file 对象写方法：路径为第一个字符串参数（file.save/append/delete/createFolder 第1参，file.copy/move 第2参即 dest）
  const fileWriteRe = /file\.(save|append|delete|createFolder)\s*\(\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = fileWriteRe.exec(code)) !== null) {
    if (!m[2].includes('node_modules')) paths.push(m[2])
  }
  const fileCopyMoveRe = /file\.(copy|move)\s*\([^,]*,\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = fileCopyMoveRe.exec(code)) !== null) {
    if (!m[2].includes('node_modules')) paths.push(m[2])
  }

  // 2. xlsx.writeFile / xlsx.writeFileSync：第二个参数为 outputPath
  const xlsxWriteRe = /(?:XLSX|xlsx)\.(?:writeFile|writeFileSync)\s*\(\s*[^,]+,\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = xlsxWriteRe.exec(code)) !== null) {
    if (!m[1].includes('node_modules')) paths.push(m[1])
  }

  // 3. pptxgenjs writeFile({ fileName: "..." })
  const pptxWriteRe = /\.writeFile\s*\(\s*\{[^}]*fileName\s*:\s*["'`]([A-Za-z]:[\\/][^"'`\n]*|\/[^"'`\n]+)["'`]/g
  while ((m = pptxWriteRe.exec(code)) !== null) {
    if (!m[1].includes('node_modules')) paths.push(m[1])
  }

  return [...new Set(paths)]
}

/** 语法检查结果 */
interface SyntaxCheckResult {
  valid: boolean
  error?: string
  line?: number
  column?: number
  context?: string
  hint?: string
}

/**
 * 检查 JS 代码语法（不执行）。
 * 用 vm.Script 预编译，语法错误在此阶段抛出，避免完整执行后才发现 SyntaxError。
 */
function checkCodeSyntax(code: string): SyntaxCheckResult {
  const wrappedCode = `(async () => {\n${code}\n})()`
  try {
    new vm.Script(wrappedCode, { filename: 'office-exec.js' })
    return { valid: true }
  } catch (e: any) {
    const errorMsg = e.message || String(e)
    const stack = e.stack || ''

    let line: number | undefined
    let column: number | undefined
    const lineMatch = stack.match(/office-exec\.js:(\d+)(?::(\d+))?/)
    if (lineMatch) {
      line = parseInt(lineMatch[1], 10)
      if (lineMatch[2]) column = parseInt(lineMatch[2], 10)
      if (line > 1) line -= 1 // 用户代码从第 2 行开始（第 1 行是 async 包装）
    }

    let context: string | undefined
    if (line && line > 0) {
      const codeLines = code.split('\n')
      const errorIdx = line - 1
      if (errorIdx >= 0 && errorIdx < codeLines.length) {
        const startIdx = Math.max(0, errorIdx - 3)
        const endIdx = Math.min(codeLines.length - 1, errorIdx + 2)
        const ctxLines: string[] = []
        for (let i = startIdx; i <= endIdx; i++) {
          const marker = i === errorIdx ? ' >>> ' : '     '
          ctxLines.push(`${marker}${i + 1} | ${codeLines[i]}`)
        }
        context = ctxLines.join('\n')
      }
    }

    let hint = ''
    if (/Unterminated string literal|Unexpected string|Unexpected identifier/i.test(errorMsg)) {
      hint = "常见原因：字符串引号冲突。建议：1) 外层用单引号 '...'；2) 或用反引号 `...`（支持多行）；3) 或转义内部双引号 \\\""
    } else if (/Unexpected token/i.test(errorMsg)) {
      hint = '常见原因：特殊字符未转义。检查字符串中是否含未转义的引号、反斜杠等'
    } else if (/is not defined/i.test(errorMsg)) {
      hint = '变量未定义。检查拼写、是否忘记 require 模块。沙箱可用模块：docx、pptxgenjs、xlsx、adm-zip、fs、path、file'
    } else if (/Unexpected end of input/i.test(errorMsg)) {
      hint = '代码不完整（括号/引号未闭合）。检查是否缺少闭合的 )、}、]、\'、"、`'
    }

    return { valid: false, error: errorMsg, line, column, context, hint }
  }
}

/**
 * 创建沙箱只读 fs：保留读方法，写方法替换为抛错提示用 `file` 对象。
 * 写操作不再走 fs（同步方法无法 await 异步弹窗），改由注入的 `file` 异步对象处理。
 */
function createSandboxedReadOnlyFs(): any {
  const realFs = require('fs')
  const wrappedFs: any = {}
  // 写/删方法黑名单：这些方法不暴露给沙箱
  const blockedMethods = new Set([
    'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync',
    'mkdirSync', 'copyFileSync', 'renameSync', 'createWriteStream',
    'truncateSync', 'ftruncateSync',
    'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir',
    'mkdir', 'copyFile', 'rename', 'truncate',
  ])
  const blockedMsg = 'office_exec 沙箱中 fs 不支持写/删操作。请使用注入的 `file` 对象（如 await file.save(path, content)）进行文件写入。'
  for (const key of Object.keys(realFs)) {
    if (blockedMethods.has(key)) {
      wrappedFs[key] = () => { throw new Error(blockedMsg) }
    } else {
      wrappedFs[key] = realFs[key]
    }
  }
  // fs.promises：写方法同样替换
  if (realFs.promises) {
    const realPromises = realFs.promises
    const wrappedPromises: any = {}
    for (const key of Object.keys(realPromises)) {
      if (blockedMethods.has(key)) {
        wrappedPromises[key] = () => Promise.reject(new Error(blockedMsg))
      } else {
        wrappedPromises[key] = realPromises[key]
      }
    }
    wrappedFs.promises = wrappedPromises
  }
  return wrappedFs
}

/**
 * 创建异步 `file` 对象：沙箱代码用 `await file.save(path, content)` 等异步方法写文件。
 * 内部先 await confirmOutsideWorkspace（统一弹窗），再调用真实 fs，并追踪 writtenFiles。
 */
function createSandboxedFile(workspacePath: string, authorizedPaths: Set<string>, writtenFiles: Set<string>): any {
  const workspaceRoot = path.resolve(workspacePath)

  const checkAndTrack = async (operation: string, targetPath: string): Promise<void> => {
    if (typeof targetPath !== 'string') return
    let resolved: string
    try { resolved = path.resolve(targetPath) } catch { return }
    const isInWorkspace = resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep)
    if (isInWorkspace) {
      try { writtenFiles.add(resolved) } catch { /* 忽略 */ }
      return
    }
    if (authorizedPaths.has(resolved.toLowerCase())) {
      try { writtenFiles.add(resolved) } catch { /* 忽略 */ }
      return
    }
    const result = await confirmOutsideWorkspace(operation, resolved)
    if (!result.ok) {
      throw new Error(result.error || `用户取消了${operation}工作区外文件的操作`)
    }
    authorizedPaths.add(resolved.toLowerCase())
    try { writtenFiles.add(resolved) } catch { /* 忽略 */ }
  }

  return {
    save: async (filePath: string, content: string | Buffer): Promise<void> => {
      await checkAndTrack('写入', filePath)
      fs.writeFileSync(filePath, content)
    },
    append: async (filePath: string, content: string | Buffer): Promise<void> => {
      await checkAndTrack('追加', filePath)
      fs.appendFileSync(filePath, content)
    },
    copy: async (src: string, dest: string): Promise<void> => {
      await checkAndTrack('复制至', dest)
      fs.copyFileSync(src, dest)
    },
    move: async (src: string, dest: string): Promise<void> => {
      await checkAndTrack('移动至', dest)
      fs.renameSync(src, dest)
    },
    delete: async (filePath: string): Promise<void> => {
      await checkAndTrack('删除', filePath)
      await moveToTrash(filePath)
    },
    createFolder: async (folderPath: string): Promise<void> => {
      await checkAndTrack('创建文件夹于', folderPath)
      fs.mkdirSync(folderPath, { recursive: true })
    },
    exists: (filePath: string): boolean => {
      return fs.existsSync(filePath)
    },
  }
}

/**
 * 包装 xlsx / pptxgenjs 模块：写函数改为异步，内部先 await confirmOutsideWorkspace。
 */
function createSandboxedRequire(workspacePath: string, authorizedPaths: Set<string>, writtenFiles: Set<string>, sandboxFile: any) {
  let cachedFs: any = null
  let cachedXlsx: any = null
  let cachedPptxgenjs: any = null

  /** 检查路径权限并追踪，工作区外路径异步弹窗确认 */
  const checkAndTrack = async (operation: string, targetPath: string): Promise<void> => {
    if (typeof targetPath !== 'string') return
    let resolved: string
    try { resolved = path.resolve(targetPath) } catch { return }
    const workspaceRoot = path.resolve(workspacePath)
    const isInWorkspace = resolved === workspaceRoot || resolved.startsWith(workspaceRoot + path.sep)
    if (isInWorkspace) {
      try { writtenFiles.add(resolved) } catch { /* 忽略 */ }
      return
    }
    if (authorizedPaths.has(resolved.toLowerCase())) {
      try { writtenFiles.add(resolved) } catch { /* 忽略 */ }
      return
    }
    const result = await confirmOutsideWorkspace(operation, resolved)
    if (!result.ok) {
      throw new Error(result.error || `用户取消了${operation}工作区外文件的操作`)
    }
    authorizedPaths.add(resolved.toLowerCase())
  }

  return (moduleName: string) => {
    // xlsx：writeFile 是同步方法，包装为异步
    if (moduleName === 'xlsx' && OFFICE_MODULES['xlsx']) {
      if (!cachedXlsx) {
        const rawXlsx = OFFICE_MODULES['xlsx']
        const originalWriteFile = rawXlsx.writeFile
        const originalWriteFileSync = rawXlsx.writeFileSync || rawXlsx.writeFile
        cachedXlsx = { ...rawXlsx }
        cachedXlsx.writeFile = async (wb: any, filename: string, opts?: any) => {
          await checkAndTrack('写入', filename)
          return originalWriteFile.call(rawXlsx, wb, filename, opts)
        }
        cachedXlsx.writeFileSync = async (wb: any, filename: string, opts?: any) => {
          await checkAndTrack('写入', filename)
          return originalWriteFileSync.call(rawXlsx, wb, filename, opts)
        }
      }
      return cachedXlsx
    }
    // pptxgenjs：实例方法 writeFile({ fileName }) 返回 Promise
    if (moduleName === 'pptxgenjs' && OFFICE_MODULES['pptxgenjs']) {
      if (!cachedPptxgenjs) {
        cachedPptxgenjs = class extends OFFICE_MODULES['pptxgenjs'] {
          writeFile(options: any) {
            const fileName = typeof options === 'string' ? options : options?.fileName
            return checkAndTrack('写入', fileName).then(() => super.writeFile(options))
          }
        }
      }
      return cachedPptxgenjs
    }
    // 其他 OFFICE_MODULES 直接返回（不涉及文件写入）
    if (OFFICE_MODULES[moduleName] && moduleName !== 'xlsx' && moduleName !== 'pptxgenjs') {
      return OFFICE_MODULES[moduleName]
    }
    if (moduleName === 'fs') {
      if (!cachedFs) cachedFs = createSandboxedReadOnlyFs()
      return cachedFs
    }
    if (moduleName === 'file') {
      return sandboxFile
    }
    if (ALLOWED_NODE_MODULES.includes(moduleName)) return require(moduleName)
    const available = [
      ...Object.keys(OFFICE_MODULES).filter(k => OFFICE_MODULES[k]),
      'fs', 'file',
      ...ALLOWED_NODE_MODULES,
    ]
    throw new Error(
      `Module "${moduleName}" is not available in the office sandbox. Available modules: ${available.join(', ')}`
    )
  }
}

const PREVIEWABLE_EXTS = new Set([
  'docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt',
  'xlsx', 'xltx', 'xlsm', 'xlsb', 'xls', 'csv', 'ods',
  'pptx', 'pptm', 'potx', 'ppsx', 'ppsm', 'odp',
  'pdf', 'ofd',
  'txt', 'md', 'json', 'xml', 'html', 'htm', 'yaml', 'yml',
  'gif', 'jpg', 'jpeg', 'bmp', 'tiff', 'tif', 'png', 'svg', 'webp', 'ico', 'heic',
])

function collectGeneratedFiles(writtenFiles: Set<string>): GeneratedFileInfo[] {
  const result: GeneratedFileInfo[] = []
  for (const filePath of writtenFiles) {
    try {
      if (!fs.existsSync(filePath)) continue
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) continue
      const ext = path.extname(filePath).slice(1).toLowerCase()
      if (!PREVIEWABLE_EXTS.has(ext)) continue
      result.push({
        path: filePath,
        name: path.basename(filePath),
        ext,
        size: stat.size,
        mtime: stat.mtimeMs,
      })
    } catch { /* 忽略 stat 失败的文件 */ }
  }
  return result
}

export const officeExecTool: ToolDefinition = {
  id: 'office_exec',
  name: 'office_exec',
  title: 'Office文档生成',
  summary: '在 Node.js 沙箱中执行 JS 代码生成或编辑 Office 文档（Word/PPT/Excel）。执行前自动语法预检查。处理 Office 文档时必须用此工具。',
  description: `在Node.js沙箱中执行JavaScript代码，创建或编辑Office文档（Word/PowerPoint/Excel）。内置 docx/pptxgenjs/xlsx/adm-zip 模块。

**处理Office文档时必须用此工具，不要用 shell_exec 调 python/node 脚本。**

**语法预检查**：执行前自动校验 JS 语法，语法错误立即返回（不执行），含行号、代码上下文、修复建议。

**长文档分步执行**：生成超长文档（≥1500字）时**必须分步**：先写骨架代码生成基础文档，再用 file_edit 追加章节内容，逐步完善。禁止一次性生成超长代码，极易出现语法错误。

**使用前先调 list_available_tools(tool_name=["office_exec"]) 获取规则与陷阱清单。**

短代码（<800字符）直接传 code 参数；长代码建议先用 file_write 写入 .js 文件再传 code_file 参数执行。`,
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的JavaScript代码，支持async/await。短代码（<800字符）建议直接传此参数' },
      code_file: { type: 'string', description: '本地 .js 文件绝对路径，读取该文件内容作为代码执行。长代码（≥800字符）建议先用 file_write 写入文件再传此参数，避免 JSON 转义导致引号错误。code 与 code_file 二选一，同时传时 code_file 优先' },
      working_dir: { type: 'string', description: '工作目录（文件操作基准路径），默认为当前员工工作区' },
      timeout: { type: 'number', description: '超时时间（秒），默认60秒，最大300秒', minimum: 1, maximum: 300 },
    },
    required: [],
  },
  handler: async (args: any) => {
    let code: string
    const codeFile = String(args.code_file || '').trim()
    if (codeFile) {
      const resolvedCodeFile = path.resolve(codeFile)
      if (!fs.existsSync(resolvedCodeFile)) return { success: false, error: `代码文件不存在: ${codeFile}` }
      if (!fs.statSync(resolvedCodeFile).isFile()) return { success: false, error: `路径不是文件: ${codeFile}` }
      try {
        code = fs.readFileSync(resolvedCodeFile, 'utf-8')
      } catch (e: any) {
        return { success: false, error: `读取代码文件失败: ${e.message || e}` }
      }
      if (!code.trim()) return { success: false, error: '代码文件内容为空' }
    } else {
      code = String(args.code || '').trim()
      if (!code) return { success: false, error: '请提供 code 或 code_file 参数' }
    }

    // 语法预检查：执行前校验 JS 语法，语法错误立即返回（不执行）
    // 消除"完整执行后才发现 SyntaxError"的往返开销
    const syntaxResult = checkCodeSyntax(code)
    if (!syntaxResult.valid) {
      const errorLines: string[] = ['语法错误（未执行）：']
      errorLines.push(`  错误: ${syntaxResult.error}`)
      if (syntaxResult.line) {
        const colInfo = syntaxResult.column ? `:${syntaxResult.column}` : ''
        errorLines.push(`  位置: 第 ${syntaxResult.line} 行${colInfo}`)
      }
      if (syntaxResult.context) {
        errorLines.push('')
        errorLines.push('代码上下文：')
        errorLines.push(syntaxResult.context)
      }
      if (syntaxResult.hint) {
        errorLines.push('')
        errorLines.push(`修复建议: ${syntaxResult.hint}`)
      }
      return {
        success: false,
        error: errorLines.join('\n'),
      }
    }

    // 优先使用数字员工工作区目录，其次 LLM 传入的 working_dir，最后 process.cwd()
    const employeeWorkspace = getWorkspacePath()
    const workingDir = String(args.working_dir || employeeWorkspace || process.cwd())
    const timeoutMs = Math.min(Math.max((args.timeout || 60), 1), 300) * 1000

    const consoleOutput: string[] = []

    const ctx = interactionContext.getStore()
    const highPermission = !!ctx?.highPermission

    // 执行前预扫描：提取代码中**写/删上下文**的绝对路径，对非工作区路径弹窗确认
    // 注意：只提取写入/删除路径，不提取读取路径（如 inspect/readFileSync 的参数）
    // 高权限模式下跳过预扫描确认
    const authorizedPaths = new Set<string>()
    const writePaths = extractWritePathsFromCode(code)
    if (!highPermission) {
      for (const p of writePaths) {
        if (!isPathInWorkspace(p)) {
          const result = await confirmOutsideWorkspace('修改', p)
          if (!result.ok) return { success: false, error: result.error }
          try { authorizedPaths.add(path.resolve(p).toLowerCase()) } catch { /* 忽略解析失败的路径 */ }
        }
      }
    } else {
      for (const p of writePaths) {
        try { authorizedPaths.add(path.resolve(p).toLowerCase()) } catch { /* 忽略解析失败的路径 */ }
      }
    }

    const writtenFiles = new Set<string>()
    const sandboxFile = createSandboxedFile(workingDir, authorizedPaths, writtenFiles)
    const sandboxedRequire = createSandboxedRequire(workingDir, authorizedPaths, writtenFiles, sandboxFile)

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
      file: sandboxFile,
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

      const generatedFiles = collectGeneratedFiles(writtenFiles)
      const statusLines: string[] = []
      if (generatedFiles.length > 0) {
        statusLines.push(`[office_exec] 写入成功，共 ${generatedFiles.length} 个文件：`)
        for (const f of generatedFiles) statusLines.push(`  ✓ ${f.path}`)
      }
      const statusBlock = statusLines.join('\n')
      const finalOutput = [statusBlock, output].filter(Boolean).join('\n') || '(无输出)'

      return {
        success: true,
        output: finalOutput,
        generatedFiles,
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

      const generatedFiles = collectGeneratedFiles(writtenFiles)
      const statusLines: string[] = []
      if (generatedFiles.length > 0) {
        statusLines.push(`[office_exec] 错误前已写入 ${generatedFiles.length} 个文件：`)
        for (const f of generatedFiles) statusLines.push(`  ✓ ${f.path}`)
      } else {
        statusLines.push('[office_exec] 错误：未写入任何文件')
      }
      const statusBlock = statusLines.join('\n')
      const finalOutput = [statusBlock, output].filter(Boolean).join('\n')

      return {
        success: false,
        error: errorMessage,
        output: finalOutput || undefined,
        generatedFiles,
      }
    }
  },
  source: 'builtin',
  onDemand: true,
  timeoutMs: 120000,
}

export function getOfficeModuleStatus(): Record<string, { loaded: boolean; error?: string }> {
  const status: Record<string, { loaded: boolean; error?: string }> = {}
  for (const name of ['docx', 'pptxgenjs', 'xlsx', 'adm-zip']) {
    status[name] = {
      loaded: !!OFFICE_MODULES[name],
      error: MODULE_LOAD_ERRORS[name],
    }
  }
  return status
}
