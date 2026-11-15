import {
  SECRETARY_DOCK_EDGES,
  SECRETARY_DOCK_HOVER_PADDING,
  SECRETARY_DOCK_ISLAND_HEIGHT,
  SECRETARY_DOCK_ISLAND_WIDTH,
  SECRETARY_DOCK_STRIP_LENGTH,
  SECRETARY_DOCK_STRIP_THICKNESS,
  type SecretaryDockEdge,
} from './channels/secretary'

/** 主进程与渲染端共用的矩形（窗口坐标或屏幕坐标，取决于调用方） */
export interface SecretaryRect {
  x: number
  y: number
  width: number
  height: number
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max))

/** 贴边条相对窗口左上角的矩形：收起为细条，展开为灵动岛；固定贴在工作区边缘上 */
export function dockBodyInWindow(
  edge: SecretaryDockEdge,
  windowWidth: number,
  windowHeight: number,
  expanded: boolean,
): SecretaryRect {
  const horizontalEdge = edge === 'left' || edge === 'right'
  const width = expanded
    ? SECRETARY_DOCK_ISLAND_WIDTH
    : horizontalEdge ? SECRETARY_DOCK_STRIP_THICKNESS : SECRETARY_DOCK_STRIP_LENGTH
  const height = expanded
    ? SECRETARY_DOCK_ISLAND_HEIGHT
    : horizontalEdge ? SECRETARY_DOCK_STRIP_LENGTH : SECRETARY_DOCK_STRIP_THICKNESS
  if (horizontalEdge) {
    return {
      x: edge === 'left' ? 0 : windowWidth - width,
      y: (windowHeight - height) / 2,
      width,
      height,
    }
  }
  return {
    x: (windowWidth - width) / 2,
    y: edge === 'top' ? 0 : windowHeight - height,
    width,
    height,
  }
}

/**
 * 贴边条命中区：在贴边条 / 灵动岛基础上向屏幕内侧与两端扩出热区。
 * 沿边方向至少覆盖收起态细条的长度：展开态灵动岛比细条矮时热区不能变短，
 * 否则鼠标停在细条两端会出现「展开→移出→收起」的抖动。
 */
export function dockHitBox(
  edge: SecretaryDockEdge,
  body: SecretaryRect,
  pad = SECRETARY_DOCK_HOVER_PADDING,
): SecretaryRect {
  const horizontalEdge = edge === 'left' || edge === 'right'
  const along = Math.max(horizontalEdge ? body.height : body.width, SECRETARY_DOCK_STRIP_LENGTH) + pad * 2
  const inward = (horizontalEdge ? body.width : body.height) + pad
  const alongStart = horizontalEdge
    ? body.y + body.height / 2 - along / 2
    : body.x + body.width / 2 - along / 2
  if (edge === 'left') return { x: body.x, y: alongStart, width: inward, height: along }
  if (edge === 'right') {
    return { x: body.x + body.width - inward, y: alongStart, width: inward, height: along }
  }
  if (edge === 'top') return { x: alongStart, y: body.y, width: along, height: inward }
  return { x: alongStart, y: body.y + body.height - inward, width: along, height: inward }
}

/** 窗口坐标下的命中区（主进程轮询使用） */
export function dockHitRectInWindow(
  edge: SecretaryDockEdge,
  windowWidth: number,
  windowHeight: number,
  expanded: boolean,
): SecretaryRect {
  return dockHitBox(edge, dockBodyInWindow(edge, windowWidth, windowHeight, expanded))
}

/**
 * 贴边时的窗口位置：贴边条贴住工作区边缘，沿边方向以 anchor 为中心并夹在工作区内。
 * 窗口远大于贴边条，位置只需保证贴边条落在边缘上。
 */
export function dockWindowPosition(
  edge: SecretaryDockEdge,
  area: SecretaryRect,
  windowWidth: number,
  windowHeight: number,
  anchor: { x: number; y: number },
): { x: number; y: number } {
  if (edge === 'left' || edge === 'right') {
    const x = edge === 'left' ? area.x : area.x + area.width - windowWidth
    const y = clamp(Math.round(anchor.y - windowHeight / 2), area.y, area.y + area.height - windowHeight)
    return { x: Math.round(x), y }
  }
  const y = edge === 'top' ? area.y : area.y + area.height - windowHeight
  const x = clamp(Math.round(anchor.x - windowWidth / 2), area.x, area.x + area.width - windowWidth)
  return { x, y: Math.round(y) }
}

/** 矩形到指定屏幕边缘的距离（贴住为 0，越出屏幕为负） */
export function dockDistance(rect: SecretaryRect, area: SecretaryRect, edge: SecretaryDockEdge): number {
  if (edge === 'left') return rect.x - area.x
  if (edge === 'right') return area.x + area.width - (rect.x + rect.width)
  if (edge === 'top') return rect.y - area.y
  return area.y + area.height - (rect.y + rect.height)
}

/** 距屏幕边缘最近且在阈值内的那条边；用于把自由挂件推进边缘时决定贴边方向 */
export function nearestDockEdge(
  rect: SecretaryRect,
  area: SecretaryRect,
  threshold: number,
): SecretaryDockEdge | null {
  let best: { edge: SecretaryDockEdge; distance: number } | null = null
  for (const edge of SECRETARY_DOCK_EDGES) {
    const distance = dockDistance(rect, area, edge)
    if (!best || distance < best.distance) best = { edge, distance }
  }
  return best && best.distance <= threshold ? best.edge : null
}

/** 渲染端悬停判定：rect 为贴边条 / 灵动岛 DOM 实测矩形 */
export function isPointInDockHit(
  edge: SecretaryDockEdge,
  rect: SecretaryRect,
  x: number,
  y: number,
  pad = SECRETARY_DOCK_HOVER_PADDING,
): boolean {
  const hit = dockHitBox(edge, rect, pad)
  return x >= hit.x && x <= hit.x + hit.width && y >= hit.y && y <= hit.y + hit.height
}

/** 贴边时面板的落点：贴在对应屏幕边缘、沿边对齐贴边条并夹在工作区内 */
export function panelPositionForDock(
  edge: SecretaryDockEdge,
  stripRect: SecretaryRect,
  area: SecretaryRect,
  panelWidth: number,
  panelHeight: number,
  margin = 12,
): { x: number; y: number } {
  const centerX = stripRect.x + stripRect.width / 2
  const centerY = stripRect.y + stripRect.height / 2
  let x: number
  let y: number
  if (edge === 'left') x = area.x + margin
  else if (edge === 'right') x = area.x + area.width - margin - panelWidth
  else x = centerX - panelWidth / 2
  if (edge === 'top') y = area.y + margin
  else if (edge === 'bottom') y = area.y + area.height - margin - panelHeight
  else y = centerY - panelHeight / 2
  return {
    x: clamp(Math.round(x), area.x + margin, area.x + area.width - margin - panelWidth),
    y: clamp(Math.round(y), area.y + margin, area.y + area.height - margin - panelHeight),
  }
}
