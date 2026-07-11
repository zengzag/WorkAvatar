// scripts/generate-build-info.mjs
//
// 在 dev/build 启动前自动执行，读取 package.json 版本号 + git commit 短哈希 + 当前时间，
// 写入 build-info.json，供 vite define 与 electron 主进程日志共用，避免散落多处手动维护。
//
// - 不引入新依赖（仅使用 node 内置 fs/path/child_process）
// - 非 git 环境（下载的源码包、CI 容器等）下 commit 字段为 "unknown"，不阻断流程
// - build-info.json 已在 .gitignore 忽略，本地重新生成即可
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const projectRoot = process.cwd()
const pkgPath = path.join(projectRoot, 'package.json')
const outPath = path.join(projectRoot, 'build-info.json')

function readVersion() {
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(raw)
    return pkg.version || '0.0.0'
  } catch (err) {
    console.warn(`[build-info] 无法读取 ${pkgPath}：${err.message}，使用 0.0.0`)
    return '0.0.0'
  }
}

function readCommit() {
  try {
    // 7 位短哈希（与 git 默认 --short 一致），包含 dirty 后缀便于识别未提交改动
    const short = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    let suffix = ''
    try {
      // 轻量判断工作区是否有未提交修改
      execFileSync('git', ['diff-index', '--quiet', 'HEAD', '--'], {
        cwd: projectRoot,
        stdio: 'ignore',
      })
    } catch {
      suffix = '-dirty'
    }
    return `${short}${suffix}`
  } catch {
    return 'unknown'
  }
}

const version = readVersion()
const commit = readCommit()
const buildTime = new Date().toISOString()

const buildInfo = { version, commit, buildTime }

fs.writeFileSync(outPath, JSON.stringify(buildInfo, null, 2) + '\n', 'utf8')
console.log(`[build-info] 生成 ${outPath}（version=${version} commit=${commit} buildTime=${buildTime}）`)
