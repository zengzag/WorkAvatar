/*!
 * Liquid Glass 折射层（React 移植版）。
 *
 * 折射场移植自 liquid-glass-js 的 fragment shader
 * (https://github.com/dashersw/liquid-glass-js) — Copyright (c) 2025 Armagan Amcalar, MIT。
 * 该许可声明需随任何拷贝或移植保留；软件按"原样"提供，不附带任何担保。
 *
 * 与 `.wa-glass` 的染色/边光配合使用：CSS 负责玻璃的色与边，
 * 本 hook 负责把背景透过边缘折射一次，让玻璃"液态"而非模糊矩形。
 * 仅 Chromium 支持 SVG 引用的 backdrop-filter；其他引擎静默跳过，CSS 兜底仍生效。
 */
import { useEffect, useRef } from 'react'

interface GlassConfig {
  edgeIntensity: number
  rimIntensity: number
  baseIntensity: number
  edgeDistance: number
  rimDistance: number
  baseDistance: number
  cornerBoost: number
  rippleEffect: number
  blurRadius: number
  warp: boolean
}

const PRESET: GlassConfig = {
  edgeIntensity: 0.015,
  rimIntensity: 0.028,
  baseIntensity: 0.05,
  edgeDistance: 0.5,
  rimDistance: 1.7,
  baseDistance: 0.2,
  cornerBoost: 0.06,
  rippleEffect: 0.26,
  blurRadius: 2,
  warp: false,
}

const SUPERSAMPLE = 2
const MAX_MAP_EDGE = 1400
const BLUR_STD_PER_RADIUS = 0.35

interface FilterEntry {
  id: string
  node: SVGFilterElement
  refs: number
}

const filters = new Map<string, FilterEntry>()
let defsRoot: SVGSVGElement | null = null
let nextId = 0

function isChromium(): boolean {
  const brands = (navigator as any).userAgentData?.brands as { brand: string }[] | undefined
  if (brands) return brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand))
  return /Chrome\//.test(navigator.userAgent)
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function resolveRadius(computed: string, w: number, h: number): number {
  const value = parseFloat(computed) || 0
  return computed.trim().endsWith('%') ? (value / 100) * Math.min(w, h) : value
}

function buildDisplacementMap(
  w: number,
  h: number,
  radius: number,
  pageW: number,
  pageH: number,
  cfg: GlassConfig,
): { mapUrl: string; scale: number } {
  const ss = Math.max(0.25, Math.min(SUPERSAMPLE, MAX_MAP_EDGE / Math.max(w, h)))
  const bw = Math.max(1, Math.round(w * ss))
  const bh = Math.max(1, Math.round(h * ss))
  const r = radius * ss
  const minDim = Math.min(w, h)
  const dx = new Float32Array(bw * bh)
  const dy = new Float32Array(bw * bh)
  let maxAbs = 0

  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      const cx = (px + 0.5) / bw
      const cy = (py + 0.5) / bh

      const tx = Math.abs(px + 0.5 - bw / 2) - (bw / 2 - r)
      const ty = Math.abs(py + 0.5 - bh / 2) - (bh / 2 - r)
      const outside = Math.hypot(Math.max(tx, 0), Math.max(ty, 0))
      const inside = Math.min(Math.max(tx, ty), 0)
      const distPx = Math.max(-(outside + inside - r), 0) / ss

      const edgeFall = Math.exp(-distPx * cfg.edgeDistance)
      const rimFall = Math.exp(-distPx * cfg.rimDistance)
      const baseFall = 1 - Math.exp(-distPx * cfg.baseDistance)
      const baseComponent = cfg.warp ? baseFall * cfg.baseIntensity : 0
      const total = baseComponent + edgeFall * cfg.edgeIntensity + rimFall * cfg.rimIntensity

      let nx = cx - 0.5
      let ny = cy - 0.5
      const len = Math.hypot(nx, ny)
      if (len > 0) {
        nx /= len
        ny /= len
      }

      const cornerNorm = Math.max(Math.min(cx, 1 - cx), Math.min(cy, 1 - cy)) * minDim
      const corner = Math.exp(-cornerNorm * 0.3) * cfg.cornerBoost
      const ripple = Math.sin((distPx / minDim) * 25) * cfg.rippleEffect * rimFall

      const fx = (nx * (total + corner) - ny * ripple) * pageW
      const fy = (ny * (total + corner) + nx * ripple) * pageH

      const i = py * bw + px
      dx[i] = fx
      dy[i] = fy
      maxAbs = Math.max(maxAbs, Math.abs(fx), Math.abs(fy))
    }
  }

  const scale = Math.max(maxAbs * 2, 1e-4)
  // feDisplacementMap 把字节 b 解码为 scale*(b/255-0.5)；128/255 ≠ 0.5，
  // 直接取 128 会让整块内部偏移 scale/510 px，因此预先扣掉这个偏置。
  const bias = scale * (128 / 255 - 0.5)
  const canvas = document.createElement('canvas')
  canvas.width = bw
  canvas.height = bh
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(bw, bh)
  const data = image.data
  for (let i = 0; i < bw * bh; i++) {
    data[i * 4] = clampByte(255 * (0.5 + (dx[i] - bias) / scale))
    data[i * 4 + 1] = clampByte(255 * (0.5 + (dy[i] - bias) / scale))
    data[i * 4 + 2] = 128
    data[i * 4 + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  return { mapUrl: canvas.toDataURL('image/png'), scale }
}

function ensureDefs(): SVGSVGElement {
  if (!defsRoot || !defsRoot.isConnected) {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'fixed'
    svg.setAttribute('aria-hidden', 'true')
    svg.appendChild(document.createElementNS(ns, 'defs'))
    document.body.appendChild(svg)
    defsRoot = svg
  }
  return defsRoot
}

function acquireFilter(
  key: string,
  w: number,
  h: number,
  radius: number,
  pageW: number,
  pageH: number,
  cfg: GlassConfig,
): FilterEntry {
  const cached = filters.get(key)
  // 共享 defs 被卸载后 url(#id) 会静默失效，必须确认节点仍在文档中
  if (cached && cached.node.isConnected) {
    cached.refs++
    return cached
  }
  if (cached) filters.delete(key)

  const { mapUrl, scale } = buildDisplacementMap(w, h, radius, pageW, pageH, cfg)
  const id = `wa-liquid-glass-${nextId++}`
  const ns = 'http://www.w3.org/2000/svg'

  const filter = document.createElementNS(ns, 'filter')
  filter.setAttribute('id', id)
  // 边缘像素最多向外采样 scale/2，再加模糊扩散；区域不够会在四角被裁成透明
  const marginPx = scale / 2 + 3 * cfg.blurRadius * BLUR_STD_PER_RADIUS
  const mx = (marginPx / w) * 100
  const my = (marginPx / h) * 100
  filter.setAttribute('x', `${-mx}%`)
  filter.setAttribute('y', `${-my}%`)
  filter.setAttribute('width', `${100 + 2 * mx}%`)
  filter.setAttribute('height', `${100 + 2 * my}%`)
  filter.setAttribute('color-interpolation-filters', 'sRGB')

  const feImage = document.createElementNS(ns, 'feImage')
  feImage.setAttribute('href', mapUrl)
  feImage.setAttribute('x', '0')
  feImage.setAttribute('y', '0')
  feImage.setAttribute('width', String(w))
  feImage.setAttribute('height', String(h))
  feImage.setAttribute('preserveAspectRatio', 'none')
  feImage.setAttribute('result', 'map')

  const feDisplacement = document.createElementNS(ns, 'feDisplacementMap')
  feDisplacement.setAttribute('in', 'SourceGraphic')
  feDisplacement.setAttribute('in2', 'map')
  feDisplacement.setAttribute('scale', String(scale))
  feDisplacement.setAttribute('xChannelSelector', 'R')
  feDisplacement.setAttribute('yChannelSelector', 'G')
  feDisplacement.setAttribute('result', 'displaced')

  const feBlur = document.createElementNS(ns, 'feGaussianBlur')
  feBlur.setAttribute('in', 'displaced')
  feBlur.setAttribute('stdDeviation', String(cfg.blurRadius * BLUR_STD_PER_RADIUS))

  filter.append(feImage, feDisplacement, feBlur)
  ensureDefs().querySelector('defs')!.appendChild(filter)

  const entry: FilterEntry = { id, node: filter, refs: 1 }
  filters.set(key, entry)
  return entry
}

/**
 * 给圆角元素挂上玻璃折射。元素需自带 border-radius，
 * 折射贴图会按计算后的圆角与尺寸烘焙，CSS 是形状的唯一来源。
 */
export function useLiquidGlass<T extends HTMLElement = HTMLDivElement>(enabled = true) {
  const ref = useRef<T>(null)

  useEffect(() => {
    const host = ref.current
    if (!enabled || !host || !isChromium()) return
    // 降低透明度 / 提高对比度偏好下保持 CSS 实色表面，不做折射
    const prefersSolid = window.matchMedia('(prefers-reduced-transparency: reduce)').matches
      || window.matchMedia('(prefers-contrast: more)').matches
    if (prefersSolid) return

    let currentKey: string | null = null
    let rebuildHandle = 0
    let resizeDebounce: ReturnType<typeof setTimeout> | undefined
    let elementResizeTimer: ReturnType<typeof setTimeout> | undefined

    const release = () => {
      if (!currentKey) return
      const key = currentKey
      currentKey = null
      const entry = filters.get(key)
      if (entry && --entry.refs <= 0) {
        filters.delete(key)
        entry.node.remove()
      }
    }

    const rebuild = () => {
      const w = Math.round(host.offsetWidth)
      const h = Math.round(host.offsetHeight)
      if (w < 2 || h < 2) return

      const radius = Math.min(
        resolveRadius(getComputedStyle(host).borderTopLeftRadius, w, h),
        Math.min(w, h) / 2,
      )
      const pageW = window.innerWidth
      const pageH = window.innerHeight
      const key = `${w}|${h}|${radius}|${pageW}|${pageH}`

      if (key === currentKey) return
      release()
      const entry = acquireFilter(key, w, h, radius, pageW, pageH, PRESET)
      currentKey = key
      host.style.backdropFilter = `url(#${entry.id})`
      ;(host.style as any).webkitBackdropFilter = `url(#${entry.id})`
    }

    const schedule = () => {
      cancelAnimationFrame(rebuildHandle)
      rebuildHandle = requestAnimationFrame(rebuild)
    }

    const onWindowResize = () => {
      clearTimeout(resizeDebounce)
      resizeDebounce = setTimeout(schedule, 180)
    }

    // 元素尺寸变化（拖宽/输入区换行）先用短防抖合并，避免拖动时每帧重烘焙贴图
    const observer = new ResizeObserver(() => {
      clearTimeout(elementResizeTimer)
      elementResizeTimer = setTimeout(schedule, 80)
    })
    observer.observe(host)
    window.addEventListener('resize', onWindowResize, { passive: true })
    schedule()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      clearTimeout(resizeDebounce)
      clearTimeout(elementResizeTimer)
      cancelAnimationFrame(rebuildHandle)
      host.style.backdropFilter = ''
      ;(host.style as any).webkitBackdropFilter = ''
      release()
    }
  }, [enabled])

  return ref
}
