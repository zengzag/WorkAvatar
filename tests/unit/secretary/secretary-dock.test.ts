import { describe, it, expect } from 'vitest'
import {
  SECRETARY_DOCK_HOVER_PADDING,
  SECRETARY_DOCK_ISLAND_HEIGHT,
  SECRETARY_DOCK_ISLAND_WIDTH,
  SECRETARY_DOCK_STRIP_LENGTH,
  SECRETARY_DOCK_STRIP_THICKNESS,
  isSecretaryDockEdge,
} from '../../../electron/shared/channels/secretary'
import {
  dockBodyInWindow,
  dockDistance,
  dockHitRectInWindow,
  dockWindowPosition,
  isPointInDockHit,
  nearestDockEdge,
  panelPositionForDock,
} from '../../../electron/shared/secretary-dock'

/**
 * 贴边模式几何：
 * - 贴边条必须贴住工作区边缘，展开时向内生长
 * - 命中区在收起态要扩出热区
 * - 面板沿边对齐贴边条并夹在工作区内
 */

const WINDOW_W = 408
const WINDOW_H = 238
const AREA = { x: 0, y: 0, width: 1920, height: 1040 }

describe('dockBodyInWindow', () => {
  it('左右贴边：细条贴边、垂直居中', () => {
    expect(dockBodyInWindow('right', WINDOW_W, WINDOW_H, false)).toEqual({
      x: WINDOW_W - SECRETARY_DOCK_STRIP_THICKNESS,
      y: (WINDOW_H - SECRETARY_DOCK_STRIP_LENGTH) / 2,
      width: SECRETARY_DOCK_STRIP_THICKNESS,
      height: SECRETARY_DOCK_STRIP_LENGTH,
    })
    expect(dockBodyInWindow('left', WINDOW_W, WINDOW_H, false).x).toBe(0)
  })

  it('左右贴边展开：灵动岛从边缘向内生长', () => {
    const right = dockBodyInWindow('right', WINDOW_W, WINDOW_H, true)
    expect(right.x).toBe(WINDOW_W - SECRETARY_DOCK_ISLAND_WIDTH)
    expect(right.y).toBe((WINDOW_H - SECRETARY_DOCK_ISLAND_HEIGHT) / 2)
    expect(right.width).toBe(SECRETARY_DOCK_ISLAND_WIDTH)
    expect(right.height).toBe(SECRETARY_DOCK_ISLAND_HEIGHT)
  })

  it('上下贴边：细条贴边、水平居中', () => {
    const top = dockBodyInWindow('top', WINDOW_W, WINDOW_H, false)
    expect(top.y).toBe(0)
    expect(top.x).toBe((WINDOW_W - SECRETARY_DOCK_STRIP_LENGTH) / 2)
    expect(top.width).toBe(SECRETARY_DOCK_STRIP_LENGTH)
    expect(top.height).toBe(SECRETARY_DOCK_STRIP_THICKNESS)
    const bottom = dockBodyInWindow('bottom', WINDOW_W, WINDOW_H, true)
    expect(bottom.y).toBe(WINDOW_H - SECRETARY_DOCK_ISLAND_HEIGHT)
    expect(bottom.x).toBe((WINDOW_W - SECRETARY_DOCK_ISLAND_WIDTH) / 2)
  })
})

describe('dockHitRectInWindow', () => {
  it('收起态向屏幕内侧与两端扩出热区', () => {
    const body = dockBodyInWindow('right', WINDOW_W, WINDOW_H, false)
    const hit = dockHitRectInWindow('right', WINDOW_W, WINDOW_H, false)
    expect(hit.x).toBe(body.x - SECRETARY_DOCK_HOVER_PADDING)
    expect(hit.y).toBe(body.y - SECRETARY_DOCK_HOVER_PADDING)
    expect(hit.width).toBe(body.width + SECRETARY_DOCK_HOVER_PADDING)
    expect(hit.height).toBe(body.height + SECRETARY_DOCK_HOVER_PADDING * 2)
  })

  it('展开后热区覆盖收起态热区，避免边缘处展开 / 收起抖动', () => {
    const collapsed = dockHitRectInWindow('right', WINDOW_W, WINDOW_H, false)
    const expanded = dockHitRectInWindow('right', WINDOW_W, WINDOW_H, true)
    expect(expanded.y).toBeLessThanOrEqual(collapsed.y)
    expect(expanded.y + expanded.height).toBeGreaterThanOrEqual(collapsed.y + collapsed.height)
    expect(expanded.x).toBeLessThanOrEqual(collapsed.x)
    const body = dockBodyInWindow('right', WINDOW_W, WINDOW_H, true)
    expect(expanded.width).toBe(body.width + SECRETARY_DOCK_HOVER_PADDING)
  })
})

describe('dockWindowPosition', () => {
  it('右贴边：窗口右边缘贴住工作区右侧，沿边中心对齐锚点', () => {
    const pos = dockWindowPosition('right', AREA, WINDOW_W, WINDOW_H, { x: 100, y: 600 })
    expect(pos.x).toBe(AREA.width - WINDOW_W)
    expect(pos.y).toBe(Math.round(600 - WINDOW_H / 2))
  })

  it('沿边方向夹在工作区内', () => {
    const top = dockWindowPosition('top', AREA, WINDOW_W, WINDOW_H, { x: -100, y: 0 })
    expect(top.y).toBe(0)
    expect(top.x).toBe(0)
    const bottom = dockWindowPosition('bottom', AREA, WINDOW_W, WINDOW_H, { x: 5000, y: 0 })
    expect(bottom.y).toBe(AREA.height - WINDOW_H)
    expect(bottom.x).toBe(AREA.width - WINDOW_W)
  })
})

describe('dockDistance / nearestDockEdge', () => {
  it('贴住边缘距离为 0，越出屏幕为负', () => {
    expect(dockDistance({ x: 1911, y: 0, width: 9, height: 68 }, AREA, 'right')).toBe(0)
    expect(dockDistance({ x: 1915, y: 0, width: 9, height: 68 }, AREA, 'right')).toBe(-4)
  })

  it('只把推进边缘的挂件判为贴边，靠近不贴边', () => {
    expect(nearestDockEdge({ x: 1919, y: 500, width: 128, height: 128 }, AREA, 4)).toBe('right')
    expect(nearestDockEdge({ x: 1700, y: 500, width: 128, height: 128 }, AREA, 4)).toBeNull()
    // 四角同时满足时取距离最小的一条边
    expect(nearestDockEdge({ x: -1, y: -2, width: 128, height: 128 }, AREA, 4)).toBe('top')
  })
})

describe('panelPositionForDock', () => {
  const PANEL = { width: 372, height: 420 }

  it('左右贴边：面板贴对应屏幕边缘', () => {
    const stripRight = { x: 1911, y: 500, width: 9, height: 68 }
    expect(panelPositionForDock('right', stripRight, AREA, PANEL.width, PANEL.height).x)
      .toBe(AREA.width - 12 - PANEL.width)
    expect(panelPositionForDock('left', { ...stripRight, x: 0 }, AREA, PANEL.width, PANEL.height).x)
      .toBe(12)
  })

  it('上下贴边：面板贴上下边缘并沿边居中', () => {
    const stripTop = { x: 900, y: 0, width: 68, height: 9 }
    const top = panelPositionForDock('top', stripTop, AREA, PANEL.width, PANEL.height)
    expect(top.y).toBe(12)
    expect(top.x).toBe(Math.round(934 - PANEL.width / 2))
    const bottom = panelPositionForDock('bottom', { ...stripTop, y: 1031 }, AREA, PANEL.width, PANEL.height)
    expect(bottom.y).toBe(AREA.height - 12 - PANEL.height)
  })

  it('面板不会跑出工作区', () => {
    const edgeStrip = { x: 0, y: 10, width: 9, height: 68 }
    const pos = panelPositionForDock('left', edgeStrip, AREA, PANEL.width, PANEL.height)
    expect(pos.y).toBe(12)
    expect(pos.x).toBe(12)
  })
})

describe('isPointInDockHit', () => {
  const strip = { x: 1911, y: 100, width: SECRETARY_DOCK_STRIP_THICKNESS, height: SECRETARY_DOCK_STRIP_LENGTH }

  it('右贴边：热区向屏幕内侧与两端扩出，超出即不再悬停', () => {
    expect(isPointInDockHit('right', strip, strip.x - SECRETARY_DOCK_HOVER_PADDING, 134)).toBe(true)
    expect(isPointInDockHit('right', strip, strip.x - SECRETARY_DOCK_HOVER_PADDING - 1, 134)).toBe(false)
    expect(isPointInDockHit('right', strip, strip.x + strip.width, strip.y - SECRETARY_DOCK_HOVER_PADDING)).toBe(true)
    expect(isPointInDockHit('right', strip, strip.x + strip.width, strip.y + strip.height + SECRETARY_DOCK_HOVER_PADDING + 1)).toBe(false)
  })

  it('上下贴边：热区向下 / 向上扩出', () => {
    const top = { x: 900, y: 0, width: SECRETARY_DOCK_STRIP_LENGTH, height: SECRETARY_DOCK_STRIP_THICKNESS }
    expect(isPointInDockHit('top', top, 934, top.height + SECRETARY_DOCK_HOVER_PADDING)).toBe(true)
    expect(isPointInDockHit('top', top, 934, top.height + SECRETARY_DOCK_HOVER_PADDING + 1)).toBe(false)
    const bottom = { x: 900, y: 231, width: SECRETARY_DOCK_STRIP_LENGTH, height: SECRETARY_DOCK_STRIP_THICKNESS }
    expect(isPointInDockHit('bottom', bottom, 934, 231 - SECRETARY_DOCK_HOVER_PADDING)).toBe(true)
  })
})

describe('isSecretaryDockEdge', () => {
  it('只接受四条边', () => {
    expect(isSecretaryDockEdge('left')).toBe(true)
    expect(isSecretaryDockEdge('bottom')).toBe(true)
    expect(isSecretaryDockEdge('diagonal')).toBe(false)
    expect(isSecretaryDockEdge(null)).toBe(false)
  })
})
