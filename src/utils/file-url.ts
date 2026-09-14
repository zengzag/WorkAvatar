/**
 * 将本地文件绝对路径转换为 app-file:// 协议 URL，供渲染进程 fetch 访问。
 * 逐段 encodeURIComponent：encodeURI 不转义 # 与 ?，含这些字符的路径会被截断为 fragment/query。
 */
export function pathToAppFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((seg, i) => {
      const e = encodeURIComponent(seg)
      // 盘符冒号（C:）不编码，保证 app-file:///C:/... 的 URL 形式
      return i === 0 ? e.replace(/%3A/i, ':') : e
    })
    .join('/')
  return `app-file:///${encoded}`
}
