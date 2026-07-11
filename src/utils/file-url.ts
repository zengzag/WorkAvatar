/**
 * 将本地文件绝对路径转换为 app-file:// 协议 URL，供渲染进程 fetch 访问
 */
export function pathToAppFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return `app-file:///${encodeURI(normalized)}`
}
