import { ToolDefinition } from './tool.types'
import { exec, execSync } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const execAsync = promisify(exec)

const IS_WINDOWS = process.platform === 'win32'

export function createBuiltinTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = []

  const calculator: ToolDefinition = {
    id: 'calculator',
    name: 'calculator',
    title: '计算器',
    description: '执行数学计算，支持加减乘除、百分比、幂运算等',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '数学表达式，如 "100 * 1.13 + 50"'
        }
      },
      required: ['expression']
    },
    handler: (args: any) => {
      try {
        const result = safeCalculate(args.expression)
        return { success: true, result: String(result) }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    },
    source: 'builtin'
  }
  tools.push(calculator)

  const dateTime: ToolDefinition = {
    id: 'date_time',
    name: 'date_time',
    title: '日期时间',
    description: '获取当前日期和时间，或进行日期计算',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['now', 'format', 'add_days'],
          description: '操作类型'
        },
        format: {
          type: 'string',
          description: '日期格式，如 "YYYY-MM-DD"'
        },
        days: {
          type: 'number',
          description: '要添加的天数'
        }
      },
      required: ['operation']
    },
    handler: (args: any) => {
      const now = new Date()
      if (args.operation === 'now') {
        return {
          date: now.toISOString().split('T')[0],
          time: now.toTimeString().split(' ')[0],
          datetime: now.toISOString(),
          timestamp: now.getTime()
        }
      }
      if (args.operation === 'format') {
        const fmt = args.format || 'YYYY-MM-DD HH:mm:ss'
        return { formatted: formatDate(now, fmt) }
      }
      if (args.operation === 'add_days' && typeof args.days === 'number') {
        const target = new Date(now.getTime() + args.days * 24 * 60 * 60 * 1000)
        return { result: target.toISOString().split('T')[0] }
      }
      return { error: 'Unknown operation' }
    },
    source: 'builtin'
  }
  tools.push(dateTime)

  const stringUtils: ToolDefinition = {
    id: 'string_utils',
    name: 'string_utils',
    title: '字符串工具',
    description: '字符串处理工具：截取、替换、统计、格式化等',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['length', 'substring', 'replace', 'split', 'trim', 'uppercase', 'lowercase', 'reverse', 'pad_start', 'pad_end', 'includes', 'index_of', 'count'],
          description: '操作类型'
        },
        text: { type: 'string', description: '输入文本' },
        start: { type: 'number', description: '起始位置' },
        end: { type: 'number', description: '结束位置' },
        search: { type: 'string', description: '搜索字符串' },
        replacement: { type: 'string', description: '替换字符串' },
        delimiter: { type: 'string', description: '分隔符' },
        target_length: { type: 'number', description: '目标长度（用于pad操作）' },
        pad_string: { type: 'string', description: '填充字符（用于pad操作）' }
      },
      required: ['operation', 'text']
    },
    handler: (args: any) => {
      const { operation, text } = args
      switch (operation) {
        case 'length':
          return { result: text.length }
        case 'substring':
          return { result: text.substring(args.start || 0, args.end || text.length) }
        case 'replace':
          return { result: text.replaceAll(args.search || '', args.replacement || '') }
        case 'split':
          return { result: text.split(args.delimiter || ',') }
        case 'trim':
          return { result: text.trim() }
        case 'uppercase':
          return { result: text.toUpperCase() }
        case 'lowercase':
          return { result: text.toLowerCase() }
        case 'reverse':
          return { result: text.split('').reverse().join('') }
        case 'pad_start':
          return { result: text.padStart(args.target_length || 0, args.pad_string || ' ') }
        case 'pad_end':
          return { result: text.padEnd(args.target_length || 0, args.pad_string || ' ') }
        case 'includes':
          return { result: text.includes(args.search || '') }
        case 'index_of':
          return { result: text.indexOf(args.search || '') }
        case 'count': {
          const matches = text.match(new RegExp(args.search || '', 'g'))
          return { result: matches ? matches.length : 0 }
        }
        default:
          return { error: 'Unknown operation' }
      }
    },
    source: 'builtin'
  }
  tools.push(stringUtils)

  const shellExec: ToolDefinition = {
    id: 'shell_exec',
    name: 'shell_exec',
    title: 'Shell命令执行',
    description: `执行系统shell命令并返回输出。${IS_WINDOWS ? '当前运行在Windows环境，支持PowerShell和CMD命令。' : '当前运行在类Unix环境，支持Bash命令。'}支持常用文件操作、系统信息查询、网络测试等。禁止执行格式化磁盘、删除系统文件等危险操作。`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的shell命令。Windows下可用dir、type、findstr、ipconfig等；避免使用rm -rf、format等危险命令'
        },
        working_dir: {
          type: 'string',
          description: '可选的工作目录'
        },
        timeout: {
          type: 'number',
          description: '超时时间（秒），默认30秒，最大300秒',
          minimum: 1,
          maximum: 300
        }
      },
      required: ['command']
    },
    handler: async (args: any) => {
      try {
        const command = String(args.command || '').trim()
        if (!command) {
          return { success: false, error: '命令不能为空' }
        }

        const dangerousPatterns = [
          /\brm\s+-[rf]{1,2}\b/i,
          /\bdel\s+\/f\b/i,
          /\brmdir\s+\/s\b/i,
          /\bformat\s+[a-z]:/i,
          /\bdiskpart\b/i,
          /\bdd\s+if=/i,
          /\bshutdown\b/i,
          /\breboot\b/i,
          /:.*?\(\)\s*\{.*?\};\s*:/,
        ]

        for (const pattern of dangerousPatterns) {
          if (pattern.test(command)) {
            return { success: false, error: '命令被安全策略拦截：检测到潜在危险操作' }
          }
        }

        const cwd = args.working_dir || process.cwd()
        const timeout = Math.min(Math.max((args.timeout || 30), 1), 300) * 1000

        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout,
          encoding: 'utf-8',
          windowsHide: true,
          env: { ...process.env }
        })

        const output: string[] = []
        if (stdout) output.push(stdout)
        if (stderr) output.push(`STDERR:\n${stderr}`)

        const result = output.join('\n') || '(命令执行成功，无输出)'
        const maxOutput = 10000
        const finalOutput = result.length > maxOutput
          ? result.substring(0, maxOutput / 2) + `\n\n... (${result.length - maxOutput} 字符已截断) ...\n\n` + result.substring(result.length - maxOutput / 2)
          : result

        return { success: true, output: finalOutput }
      } catch (error: any) {
        return {
          success: false,
          error: `命令执行失败: ${error.message || error}`,
          stderr: error.stderr || '',
          stdout: error.stdout || ''
        }
      }
    },
    source: 'builtin'
  }
  tools.push(shellExec)

  const askUser: ToolDefinition = {
    id: 'ask_user',
    name: 'ask_user',
    title: '询问用户',
    description: '当任务需要用户提供额外信息、做出选择或确认时，暂停并询问用户。支持自由文本回答或选项选择。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要向用户提出的问题'
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '可选的预设选项，用户也可以自由输入其他回答'
        }
      },
      required: ['question']
    },
    handler: (args: any) => {
      return {
        success: true,
        interrupt: true,
        type: 'ask_user',
        question: args.question,
        options: args.options || []
      }
    },
    source: 'builtin'
  }
  tools.push(askUser)

  const readFile: ToolDefinition = {
    id: 'read_file',
    name: 'read_file',
    title: '读取文件',
    description: '读取本地文件的内容。支持文本文件，可指定读取的起始行和最大行数。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件绝对路径'
        },
        offset: {
          type: 'number',
          description: '起始行号（从1开始，默认1）',
          minimum: 1
        },
        limit: {
          type: 'number',
          description: '最大读取行数（默认500）',
          minimum: 1,
          maximum: 5000
        }
      },
      required: ['path']
    },
    handler: (args: any) => {
      try {
        const filePath = String(args.path || '').trim()
        if (!filePath) {
          return { success: false, error: '文件路径不能为空' }
        }

        const resolved = path.resolve(filePath)
        if (!fs.existsSync(resolved)) {
          return { success: false, error: `文件不存在: ${filePath}` }
        }
        if (!fs.statSync(resolved).isFile()) {
          return { success: false, error: `路径不是文件: ${filePath}` }
        }

        const content = fs.readFileSync(resolved, 'utf-8')
        const lines = content.replace(/\r\n/g, '\n').split('\n')
        const total = lines.length

        const offset = Math.max(1, args.offset || 1)
        const limit = Math.min(Math.max(args.limit || 500, 1), 5000)

        if (offset > total) {
          return { success: false, error: `起始行 ${offset} 超出文件总行数 ${total}` }
        }

        const start = offset - 1
        const end = Math.min(start + limit, total)
        const selected = lines.slice(start, end)
        const numbered = selected.map((line, i) => `${start + i + 1}| ${line}`)
        let result = numbered.join('\n')

        if (end < total) {
          result += `\n\n(显示第 ${offset}-${end} 行，共 ${total} 行。使用 offset=${end + 1} 继续读取)`
        } else {
          result += `\n\n(文件结束 — 共 ${total} 行)`
        }

        return { success: true, output: result }
      } catch (error: any) {
        return { success: false, error: `读取文件失败: ${error.message || error}` }
      }
    },
    source: 'builtin'
  }
  tools.push(readFile)

  const writeFile: ToolDefinition = {
    id: 'write_file',
    name: 'write_file',
    title: '写入文件',
    description: '将内容写入到本地文件。如果文件已存在则覆盖，会自动创建父目录。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件绝对路径'
        },
        content: {
          type: 'string',
          description: '要写入的内容'
        }
      },
      required: ['path', 'content']
    },
    handler: (args: any) => {
      try {
        const filePath = String(args.path || '').trim()
        if (!filePath) {
          return { success: false, error: '文件路径不能为空' }
        }

        const resolved = path.resolve(filePath)
        const dir = path.dirname(resolved)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        fs.writeFileSync(resolved, String(args.content || ''), 'utf-8')
        return { success: true, output: `成功写入 ${resolved}，共 ${String(args.content || '').length} 字符` }
      } catch (error: any) {
        return { success: false, error: `写入文件失败: ${error.message || error}` }
      }
    },
    source: 'builtin'
  }
  tools.push(writeFile)

  const listDir: ToolDefinition = {
    id: 'list_dir',
    name: 'list_dir',
    title: '列出目录',
    description: '列出指定目录下的文件和子目录。支持递归列出，自动忽略常见的临时目录。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录绝对路径'
        },
        recursive: {
          type: 'boolean',
          description: '是否递归列出子目录内容（默认false）'
        },
        max_entries: {
          type: 'number',
          description: '最大返回条目数（默认200）',
          minimum: 1,
          maximum: 1000
        }
      },
      required: ['path']
    },
    handler: (args: any) => {
      try {
        const dirPath = String(args.path || '').trim()
        if (!dirPath) {
          return { success: false, error: '目录路径不能为空' }
        }

        const resolved = path.resolve(dirPath)
        if (!fs.existsSync(resolved)) {
          return { success: false, error: `目录不存在: ${dirPath}` }
        }
        if (!fs.statSync(resolved).isDirectory()) {
          return { success: false, error: `路径不是目录: ${dirPath}` }
        }

        const ignoreDirs = new Set([
          '.git', 'node_modules', '__pycache__', '.venv', 'venv',
          'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache',
          '.ruff_cache', '.coverage', 'htmlcov', '.idea', '.vs',
          'out', 'target', 'bin', 'obj'
        ])

        const recursive = args.recursive === true
        const maxEntries = Math.min(Math.max(args.max_entries || 200, 1), 1000)
        const items: string[] = []
        let total = 0

        if (recursive) {
          const walk = (current: string, prefix: string) => {
            const entries = fs.readdirSync(current, { withFileTypes: true })
              .filter(e => !ignoreDirs.has(e.name))
              .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))

            for (const entry of entries) {
              if (total >= maxEntries) break
              total++
              const fullPath = path.join(current, entry.name)
              const display = prefix ? `${prefix}/${entry.name}` : entry.name
              if (entry.isDirectory()) {
                items.push(`📁 ${display}/`)
                walk(fullPath, display)
              } else {
                const stats = fs.statSync(fullPath)
                const size = formatFileSize(stats.size)
                items.push(`📄 ${display} (${size})`)
              }
            }
          }
          walk(resolved, '')
        } else {
          const entries = fs.readdirSync(resolved, { withFileTypes: true })
            .filter(e => !ignoreDirs.has(e.name))
            .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))

          for (const entry of entries) {
            total++
            if (items.length < maxEntries) {
              if (entry.isDirectory()) {
                items.push(`📁 ${entry.name}/`)
              } else {
                const fullPath = path.join(resolved, entry.name)
                const stats = fs.statSync(fullPath)
                const size = formatFileSize(stats.size)
                items.push(`📄 ${entry.name} (${size})`)
              }
            }
          }
        }

        if (items.length === 0) {
          return { success: true, output: `目录 ${dirPath} 为空` }
        }

        let result = items.join('\n')
        if (total > maxEntries) {
          result += `\n\n(已截断，显示前 ${maxEntries} 条，共 ${total} 条)`
        }
        return { success: true, output: result }
      } catch (error: any) {
        return { success: false, error: `列出目录失败: ${error.message || error}` }
      }
    },
    source: 'builtin'
  }
  tools.push(listDir)

  const systemInfo: ToolDefinition = {
    id: 'system_info',
    name: 'system_info',
    title: '系统信息',
    description: '获取当前操作系统的基本信息，包括平台、CPU、内存、磁盘等。',
    parameters: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['basic', 'cpu', 'memory', 'disk', 'network', 'all'],
          description: '信息详细程度：basic基础信息、cpu处理器、memory内存、disk磁盘、network网络、all全部'
        }
      },
      required: ['detail']
    },
    handler: (args: any) => {
      try {
        const detail = args.detail || 'basic'
        const result: Record<string, any> = {}

        if (detail === 'basic' || detail === 'all') {
          result.platform = process.platform
          result.arch = process.arch
          result.hostname = os.hostname()
          result.userInfo = os.userInfo().username
          result.nodeVersion = process.version
          result.cwd = process.cwd()
          result.uptime = `${Math.floor(os.uptime() / 3600)}小时`
        }

        if (detail === 'cpu' || detail === 'all') {
          result.cpus = os.cpus().map(c => `${c.model} @ ${c.speed}MHz`)
          result.cpuCount = os.cpus().length
        }

        if (detail === 'memory' || detail === 'all') {
          const total = os.totalmem()
          const free = os.freemem()
          result.memory = {
            total: formatBytes(total),
            free: formatBytes(free),
            used: formatBytes(total - free),
            usagePercent: `${((total - free) / total * 100).toFixed(1)}%`
          }
        }

        if (detail === 'disk' || detail === 'all') {
          try {
            const drives: any[] = []
            if (IS_WINDOWS) {
              const stdout = execSync('wmic logicaldisk get DeviceID,Size,FreeSpace /format:csv', { encoding: 'utf-8', windowsHide: true })
              const lines = stdout.trim().split('\n').slice(1)
              for (const line of lines) {
                const parts = line.trim().split(',')
                if (parts.length >= 4 && parts[1]) {
                  const size = parseInt(parts[2]) || 0
                  const free = parseInt(parts[3]) || 0
                  drives.push({
                    drive: parts[1],
                    total: formatBytes(size),
                    free: formatBytes(free),
                    used: formatBytes(size - free)
                  })
                }
              }
            } else {
              const stdout = execSync('df -h /', { encoding: 'utf-8' })
              drives.push({ info: stdout.trim() })
            }
            result.disks = drives
          } catch (e: any) {
            result.diskError = e.message
          }
        }

        if (detail === 'network' || detail === 'all') {
          const interfaces = os.networkInterfaces()
          result.network = Object.entries(interfaces).map(([name, addrs]) => ({
            name,
            addresses: (addrs || []).map(a => ({
              family: a.family,
              address: a.address,
              internal: a.internal
            }))
          }))
        }

        return { success: true, output: JSON.stringify(result, null, 2) }
      } catch (error: any) {
        return { success: false, error: `获取系统信息失败: ${error.message || error}` }
      }
    },
    source: 'builtin'
  }
  tools.push(systemInfo)

  const webSearch: ToolDefinition = {
    id: 'web_search',
    name: 'web_search',
    title: '网络搜索',
    description: '使用DuckDuckGo进行网络搜索，返回搜索结果的标题、链接和摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词'
        },
        count: {
          type: 'number',
          description: '返回结果数量（1-10，默认5）',
          minimum: 1,
          maximum: 10
        }
      },
      required: ['query']
    },
    handler: async (args: any) => {
      try {
        const query = String(args.query || '').trim()
        if (!query) {
          return { success: false, error: '搜索关键词不能为空' }
        }
        const count = Math.min(Math.max(args.count || 5, 1), 10)

        const encodedQuery = encodeURIComponent(query)
        const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        })

        if (!response.ok) {
          return { success: false, error: `搜索请求失败: ${response.status}` }
        }

        const html = await response.text()
        const results: Array<{ title: string; url: string; snippet: string }> = []

        const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi
        const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi

        const titles: Array<{ url: string; title: string }> = []
        let match
        while ((match = resultRegex.exec(html)) !== null && titles.length < count) {
          const rawUrl = match[1]
          const title = match[2].replace(/<[^>]+>/g, '').trim()
          let url = rawUrl
          if (rawUrl.startsWith('//')) url = 'https:' + rawUrl
          else if (rawUrl.startsWith('/')) url = 'https://duckduckgo.com' + rawUrl
          titles.push({ url, title })
        }

        const snippets: string[] = []
        while ((match = snippetRegex.exec(html)) !== null && snippets.length < count) {
          snippets.push(match[1].replace(/<[^>]+>/g, '').trim())
        }

        for (let i = 0; i < titles.length; i++) {
          results.push({
            title: titles[i].title,
            url: titles[i].url,
            snippet: snippets[i] || ''
          })
        }

        if (results.length === 0) {
          return { success: true, output: `未找到关于 "${query}" 的搜索结果` }
        }

        const lines = [`搜索结果: ${query}\n`]
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          lines.push(`${i + 1}. ${r.title}`)
          lines.push(`   链接: ${r.url}`)
          if (r.snippet) lines.push(`   摘要: ${r.snippet}`)
          lines.push('')
        }

        return { success: true, output: lines.join('\n') }
      } catch (error: any) {
        return { success: false, error: `搜索失败: ${error.message || error}` }
      }
    },
    source: 'builtin'
  }
  tools.push(webSearch)

  const webFetch: ToolDefinition = {
    id: 'web_fetch',
    name: 'web_fetch',
    title: '网页获取',
    description: '获取指定URL的网页内容，提取为纯文本或Markdown格式。支持设置最大字符数限制。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要获取的网页URL'
        },
        max_chars: {
          type: 'number',
          description: '最大字符数（默认10000）',
          minimum: 100,
          maximum: 50000
        }
      },
      required: ['url']
    },
    handler: async (args: any) => {
      try {
        const url = String(args.url || '').trim()
        if (!url) {
          return { success: false, error: 'URL不能为空' }
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return { success: false, error: 'URL必须以 http:// 或 https:// 开头' }
        }

        const maxChars = Math.min(Math.max(args.max_chars || 10000, 100), 50000)

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        })

        if (!response.ok) {
          return { success: false, error: `请求失败: ${response.status} ${response.statusText}` }
        }

        const contentType = response.headers.get('content-type') || ''
        if (contentType.includes('application/json')) {
          const data = await response.json()
          const text = JSON.stringify(data, null, 2)
          return {
            success: true,
            output: text.length > maxChars ? text.substring(0, maxChars) + '\n\n(内容已截断)' : text,
            contentType: 'json'
          }
        }

        const html = await response.text()
        let text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim()

        const truncated = text.length > maxChars
        const output = truncated ? text.substring(0, maxChars) + '\n\n(内容已截断)' : text

        return { success: true, output, truncated, contentType: 'html' }
      } catch (error: any) {
        return { success: false, error: `获取网页失败: ${error.message || error}` }
      }
    },
    source: 'builtin'
  }
  tools.push(webFetch)

  const jsonUtils: ToolDefinition = {
    id: 'json_utils',
    name: 'json_utils',
    title: 'JSON工具',
    description: 'JSON数据处理工具：解析、格式化、查询、验证等',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['parse', 'stringify', 'get', 'validate', 'beautify', 'minify'],
          description: '操作类型: parse解析, stringify序列化, get按路径获取, validate验证, beautify格式化, minify压缩'
        },
        data: {
          type: 'string',
          description: 'JSON字符串（parse/validate/beautify/minify时使用）'
        },
        obj: {
          type: 'object',
          description: 'JavaScript对象（stringify时使用）'
        },
        path: {
          type: 'string',
          description: 'JSON路径，如 "users.0.name"（get时使用）'
        },
        indent: {
          type: 'number',
          description: '格式化缩进空格数（默认2）'
        }
      },
      required: ['operation']
    },
    handler: (args: any) => {
      try {
        const { operation } = args
        switch (operation) {
          case 'parse': {
            const parsed = JSON.parse(args.data || '{}')
            return { success: true, result: parsed }
          }
          case 'stringify': {
            const str = JSON.stringify(args.obj || {}, null, args.indent || 2)
            return { success: true, result: str }
          }
          case 'get': {
            const parsed = JSON.parse(args.data || '{}')
            const keys = (args.path || '').split('.')
            let current = parsed
            for (const key of keys) {
              if (current === null || current === undefined) break
              current = current[key]
            }
            return { success: true, result: current }
          }
          case 'validate': {
            JSON.parse(args.data || '{}')
            return { success: true, result: true, message: '有效的JSON' }
          }
          case 'beautify': {
            const parsed = JSON.parse(args.data || '{}')
            return { success: true, result: JSON.stringify(parsed, null, args.indent || 2) }
          }
          case 'minify': {
            const parsed = JSON.parse(args.data || '{}')
            return { success: true, result: JSON.stringify(parsed) }
          }
          default:
            return { success: false, error: 'Unknown operation' }
        }
      } catch (error: any) {
        return { success: false, error: `JSON操作失败: ${error.message || error}` }
      }
    },
    source: 'builtin'
  }
  tools.push(jsonUtils)

  const randomUtils: ToolDefinition = {
    id: 'random_utils',
    name: 'random_utils',
    title: '随机工具',
    description: '生成随机数、UUID、随机选择等工具',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['number', 'uuid', 'choice', 'shuffle', 'boolean'],
          description: '操作类型: number随机数, uuid唯一标识, choice随机选择, shuffle打乱顺序, boolean随机布尔'
        },
        min: {
          type: 'number',
          description: '最小值（number时使用，默认0）'
        },
        max: {
          type: 'number',
          description: '最大值（number时使用，默认100）'
        },
        items: {
          type: 'array',
          description: '选项数组（choice/shuffle时使用）'
        },
        count: {
          type: 'number',
          description: '生成数量（number/uuid/boolean时使用，默认1）'
        }
      },
      required: ['operation']
    },
    handler: (args: any) => {
      try {
        const { operation } = args
        switch (operation) {
          case 'number': {
            const min = args.min ?? 0
            const max = args.max ?? 100
            const count = Math.min(Math.max(args.count || 1, 1), 100)
            const results: number[] = []
            for (let i = 0; i < count; i++) {
              results.push(Math.floor(Math.random() * (max - min + 1)) + min)
            }
            return { success: true, result: count === 1 ? results[0] : results }
          }
          case 'uuid': {
            const count = Math.min(Math.max(args.count || 1, 1), 100)
            const results: string[] = []
            for (let i = 0; i < count; i++) {
              results.push(generateUUID())
            }
            return { success: true, result: count === 1 ? results[0] : results }
          }
          case 'choice': {
            const items = args.items || []
            if (items.length === 0) return { success: false, error: '选项数组不能为空' }
            return { success: true, result: items[Math.floor(Math.random() * items.length)] }
          }
          case 'shuffle': {
            const items = [...(args.items || [])]
            for (let i = items.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [items[i], items[j]] = [items[j], items[i]]
            }
            return { success: true, result: items }
          }
          case 'boolean': {
            const count = Math.min(Math.max(args.count || 1, 1), 100)
            const results: boolean[] = []
            for (let i = 0; i < count; i++) {
              results.push(Math.random() < 0.5)
            }
            return { success: true, result: count === 1 ? results[0] : results }
          }
          default:
            return { success: false, error: 'Unknown operation' }
        }
      } catch (error: any) {
        return { success: false, error: `随机工具失败: ${error.message || error}` }
      }
    },
    source: 'builtin'
  }
  tools.push(randomUtils)

  const envVars: ToolDefinition = {
    id: 'env_vars',
    name: 'env_vars',
    title: '环境变量',
    description: '读取系统环境变量。出于安全考虑，只能读取允许列表中的环境变量。',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: '要读取的环境变量名称列表'
        }
      },
      required: ['names']
    },
    handler: (args: any) => {
      try {
        const allowedPrefixes = ['PATH', 'HOME', 'USER', 'COMPUTERNAME', 'OS', 'TEMP', 'TMP', 'NODE', 'npm']
        const names = (args.names || []).filter((n: string) => {
          const upper = n.toUpperCase()
          return allowedPrefixes.some(p => upper.startsWith(p)) || upper === 'PLATFORM'
        })

        const result: Record<string, string | undefined> = {}
        for (const name of names) {
          result[name] = process.env[name]
        }

        return { success: true, output: JSON.stringify(result, null, 2) }
      } catch (error: any) {
        return { success: false, error: `读取环境变量失败: ${error.message || error}` }
      }
    },
    source: 'builtin'
  }
  tools.push(envVars)

  return tools
}

function safeCalculate(expression: string): number {
  const sanitized = expression
    .replace(/[^0-9+\-*/().\s%^]/g, '')
    .replace(/\^/g, '**')
    .replace(/%/g, '/100')

  if (!sanitized || sanitized.length === 0) {
    throw new Error('Invalid expression')
  }

  const result = Function('"use strict"; return (' + sanitized + ')')()
  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error('Calculation error')
  }
  return result
}

function formatDate(date: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return format
    .replace('YYYY', String(date.getFullYear()))
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()))
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function formatBytes(bytes: number): string {
  return formatFileSize(bytes)
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}
