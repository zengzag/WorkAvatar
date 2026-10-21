import type { CSSProperties } from 'react'
import { createHighlighterCoreSync } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { HighlighterCore, ThemedToken } from 'shiki/core'
import themeLight from '@shikijs/themes/one-light'
import themeDark from '@shikijs/themes/one-dark-pro'
import langTs from '@shikijs/langs/typescript'
import langBash from '@shikijs/langs/shellscript'
import langJson from '@shikijs/langs/json'

/** 代码高亮单行内的文本片段 */
export interface CodeSpan {
  text: string
  style: CSSProperties
}

/** 超过该体积的代码文件回退给 file-viewer，避免长文本高亮阻塞界面 */
export const MAX_CODE_PREVIEW_BYTES = 2 * 1024 * 1024

type LangModule = { default: typeof langTs }

// 扩展名 → 语法 id；与 shiki 语法名保持一致
const LANGUAGE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  shellscript: ['sh', 'bash', 'zsh'],
  fish: ['fish'],
  json: ['json', 'jsonc', 'jsonl', 'ndjson', 'ipynb'],
  csv: ['csv'],
  python: ['py', 'pyw', 'pyi'],
  ruby: ['rb', 'rake', 'gemspec'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
  csharp: ['cs'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  php: ['php'],
  yaml: ['yaml', 'yml'],
  toml: ['toml'],
  ini: ['ini', 'conf', 'cfg', 'properties'],
  dotenv: ['env'],
  log: ['log'],
  diff: ['diff', 'patch'],
  http: ['http'],
  markdown: ['md', 'markdown'],
  mdx: ['mdx'],
  rst: ['rst'],
  latex: ['tex', 'sty', 'cls'],
  bibtex: ['bib'],
  asciidoc: ['adoc'],
  html: ['html', 'htm', 'xhtml'],
  css: ['css'],
  scss: ['scss'],
  less: ['less'],
  sql: ['sql'],
  xml: ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'svg'],
  lua: ['lua'],
  bat: ['bat', 'cmd'],
  powershell: ['ps1', 'psm1', 'psd1'],
  r: ['r'],
  julia: ['jl'],
  dart: ['dart'],
  scala: ['scala'],
  clojure: ['clj', 'cljs', 'edn'],
  erlang: ['erl', 'hrl'],
  elixir: ['ex', 'exs'],
  haskell: ['hs'],
  fsharp: ['fs', 'fsi', 'fsx'],
  vb: ['vb'],
  perl: ['pl', 'pm'],
  verilog: ['v'],
  'system-verilog': ['sv', 'svh'],
  graphql: ['graphql', 'gql'],
  proto: ['proto'],
  hcl: ['tf', 'tfvars', 'hcl'],
  nix: ['nix'],
  vue: ['vue'],
  svelte: ['svelte'],
  make: ['makefile', 'mk'],
  cmake: ['cmake'],
  groovy: ['gradle', 'groovy'],
}

const LANGUAGES = new Map(
  Object.entries(LANGUAGE_EXTENSIONS)
    .flatMap(([language, extensions]) => extensions.map((extension) => [extension, language] as const)),
)

// 围栏语言别名 → 语法 id；JS 家族共用 TypeScript 语法（与 shiki 官方推荐一致）
const HINT_ALIASES: Readonly<Record<string, string>> = {
  javascript: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  shell: 'shellscript',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  cs: 'csharp',
  kt: 'kotlin',
  yml: 'yaml',
  md: 'markdown',
  ps1: 'powershell',
  ps: 'powershell',
  tex: 'latex',
  bib: 'bibtex',
  adoc: 'asciidoc',
  jl: 'julia',
  hs: 'haskell',
  fs: 'fsharp',
  fsi: 'fsharp',
  fsx: 'fsharp',
  vbnet: 'vb',
  clj: 'clojure',
  cljs: 'clojure',
  erl: 'erlang',
  ex: 'elixir',
  exs: 'elixir',
  pl: 'perl',
  pm: 'perl',
  v: 'verilog',
  sv: 'system-verilog',
  svh: 'system-verilog',
  gql: 'graphql',
  protobuf: 'proto',
  tf: 'hcl',
  tfvars: 'hcl',
  makefile: 'make',
  mk: 'make',
  gradle: 'groovy',
  jsonc: 'json',
  jsonl: 'json',
  ndjson: 'json',
  env: 'dotenv',
  patch: 'diff',
  conf: 'ini',
  cfg: 'ini',
  properties: 'ini',
  cmd: 'bat',
  psm1: 'powershell',
  psd1: 'powershell',
  pyw: 'python',
  pyi: 'python',
  mts: 'typescript',
  cts: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  h: 'c',
  cc: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cxx: 'cpp',
  kts: 'kotlin',
  edn: 'clojure',
  hrl: 'erlang',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  plist: 'xml',
}

const HINT_BY_LANGUAGE = new Map<string, string>([
  ...Object.keys(LANGUAGE_EXTENSIONS).map((id) => [id, id] as const),
  ...Object.entries(HINT_ALIASES),
])

// 启动即加载的语法：聊天中最常见的代码块类型
const BOOT_LANGS = [langTs, langBash, langJson]

// 其余语法按需动态加载，不进入首屏包
const LAZY_GRAMMARS = new Map<string, () => Promise<LangModule>>([
  ['python', () => import('@shikijs/langs/python')],
  ['ruby', () => import('@shikijs/langs/ruby')],
  ['go', () => import('@shikijs/langs/go')],
  ['rust', () => import('@shikijs/langs/rust')],
  ['java', () => import('@shikijs/langs/java')],
  ['c', () => import('@shikijs/langs/c')],
  ['cpp', () => import('@shikijs/langs/cpp')],
  ['csharp', () => import('@shikijs/langs/csharp')],
  ['kotlin', () => import('@shikijs/langs/kotlin')],
  ['swift', () => import('@shikijs/langs/swift')],
  ['php', () => import('@shikijs/langs/php')],
  ['yaml', () => import('@shikijs/langs/yaml')],
  ['toml', () => import('@shikijs/langs/toml')],
  ['ini', () => import('@shikijs/langs/ini')],
  ['markdown', () => import('@shikijs/langs/markdown')],
  ['mdx', () => import('@shikijs/langs/mdx')],
  ['html', () => import('@shikijs/langs/html')],
  ['css', () => import('@shikijs/langs/css')],
  ['scss', () => import('@shikijs/langs/scss')],
  ['less', () => import('@shikijs/langs/less')],
  ['sql', () => import('@shikijs/langs/sql')],
  ['xml', () => import('@shikijs/langs/xml')],
  ['lua', () => import('@shikijs/langs/lua')],
  ['bat', () => import('@shikijs/langs/bat')],
  ['powershell', () => import('@shikijs/langs/powershell')],
  ['fish', () => import('@shikijs/langs/fish')],
  ['dotenv', () => import('@shikijs/langs/dotenv')],
  ['log', () => import('@shikijs/langs/log')],
  ['csv', () => import('@shikijs/langs/csv')],
  ['diff', () => import('@shikijs/langs/diff')],
  ['http', () => import('@shikijs/langs/http')],
  ['rst', () => import('@shikijs/langs/rst')],
  ['latex', () => import('@shikijs/langs/latex')],
  ['bibtex', () => import('@shikijs/langs/bibtex')],
  ['asciidoc', () => import('@shikijs/langs/asciidoc')],
  ['r', () => import('@shikijs/langs/r')],
  ['julia', () => import('@shikijs/langs/julia')],
  ['dart', () => import('@shikijs/langs/dart')],
  ['scala', () => import('@shikijs/langs/scala')],
  ['clojure', () => import('@shikijs/langs/clojure')],
  ['erlang', () => import('@shikijs/langs/erlang')],
  ['elixir', () => import('@shikijs/langs/elixir')],
  ['haskell', () => import('@shikijs/langs/haskell')],
  ['fsharp', () => import('@shikijs/langs/fsharp')],
  ['vb', () => import('@shikijs/langs/vb')],
  ['perl', () => import('@shikijs/langs/perl')],
  ['verilog', () => import('@shikijs/langs/verilog')],
  ['system-verilog', () => import('@shikijs/langs/system-verilog')],
  ['graphql', () => import('@shikijs/langs/graphql')],
  ['proto', () => import('@shikijs/langs/proto')],
  ['hcl', () => import('@shikijs/langs/hcl')],
  ['nix', () => import('@shikijs/langs/nix')],
  ['vue', () => import('@shikijs/langs/vue')],
  ['svelte', () => import('@shikijs/langs/svelte')],
  ['make', () => import('@shikijs/langs/make')],
  ['cmake', () => import('@shikijs/langs/cmake')],
  ['groovy', () => import('@shikijs/langs/groovy')],
])

const engine = createJavaScriptRegexEngine({ forgiving: true })

let singleton: HighlighterCore | undefined

function highlighter(): HighlighterCore {
  singleton ??= createHighlighterCoreSync({
    themes: [themeLight, themeDark],
    langs: BOOT_LANGS,
    engine,
  })
  return singleton
}

// 引擎与启动语法构建约上百毫秒，放到下一个任务里预热，避免首个代码块阻塞渲染
setTimeout(() => { highlighter() }, 0)

const requested = new Set<string>()
const listeners = new Set<() => void>()
let loadVersion = 0

/** 懒加载语法注册完成后的订阅入口（配合 useSyncExternalStore） */
export function subscribeGrammarLoaded(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 懒加载语法版本号，变化时触发订阅组件重新渲染 */
export function grammarLoadVersion(): number {
  return loadVersion
}

function ensureGrammar(resolved: string): boolean {
  const load = LAZY_GRAMMARS.get(resolved)
  if (load === undefined) return highlighter().getLoadedLanguages().includes(resolved)
  if (highlighter().getLoadedLanguages().includes(resolved)) return true
  if (!requested.has(resolved)) {
    requested.add(resolved)
    void load()
      .then((mod) => {
        highlighter().loadLanguageSync(mod.default)
        loadVersion += 1
        for (const listener of listeners) listener()
      })
      .catch(() => { /* 语法加载失败保持纯文本降级 */ })
  }
  return false
}

function extensionOf(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? undefined : base.slice(dot + 1).toLowerCase()
}

/** 由文件名推导语法 id */
export function languageForPath(path: string): string | undefined {
  const extension = extensionOf(path)
  return extension === undefined ? undefined : LANGUAGES.get(extension)
}

/** 由围栏语言或语法 id 解析出 shiki 语法名，未知语言返回 undefined */
export function grammarForHint(lang: string | undefined): string | undefined {
  return lang === undefined ? undefined : HINT_BY_LANGUAGE.get(lang.toLowerCase())
}

// 这些扩展名有更合适的专用预览（Markdown 渲染、表格、图片），不进入代码视图
const NON_CODE_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'rst', 'adoc', 'csv', 'svg', 'ipynb'])

/** 是否为代码文件预览（按扩展名判断） */
export function isCodePreviewPath(path: string): boolean {
  const extension = extensionOf(path)
  if (extension === undefined || NON_CODE_EXTENSIONS.has(extension)) return false
  return LANGUAGES.has(extension)
}

const THEME_LIGHT = 'one-light'
const THEME_DARK = 'one-dark-pro'
// 单行超长时代价陡增，超过后该行保持无色但内容完整
const MAX_TOKENIZE_LINE_LENGTH = 1000

function spanStyle(token: ThemedToken): CSSProperties {
  const style: CSSProperties = {}
  if (token.color !== undefined) style.color = token.color
  const bits = token.fontStyle ?? 0
  if ((bits & 1) !== 0) style.fontStyle = 'italic'
  if ((bits & 2) !== 0) style.fontWeight = 'bold'
  const decorations: string[] = []
  if ((bits & 4) !== 0) decorations.push('underline')
  if ((bits & 8) !== 0) decorations.push('line-through')
  if (decorations.length > 0) style.textDecoration = decorations.join(' ')
  return style
}

/**
 * 将源码按行高亮为可渲染的文本片段。
 * 未知语言或语法仍在懒加载时返回 undefined，调用方降级为纯文本。
 */
export function highlightCodeLines(code: string, lang: string | undefined, dark: boolean): CodeSpan[][] | undefined {
  const resolved = grammarForHint(lang)
  if (resolved === undefined || !ensureGrammar(resolved)) return undefined
  const { tokens } = highlighter().codeToTokens(code, {
    lang: resolved,
    theme: dark ? THEME_DARK : THEME_LIGHT,
    tokenizeMaxLineLength: MAX_TOKENIZE_LINE_LENGTH,
  })
  // 末尾换行会多出一行空 token，行号视图不展示它
  const last = tokens[tokens.length - 1]
  const lines = tokens.length > 1 && last !== undefined && last.length === 0 ? tokens.slice(0, -1) : tokens
  return lines.map((line) => line.map((token) => ({ text: token.content, style: spanStyle(token) })))
}
