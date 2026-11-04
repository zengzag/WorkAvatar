/**
 * 波波（屏幕脸机器人）的真 3D 舞台。
 * 几何、材质、灯光与姿态动画都在这里，React 只负责挂载 canvas 并传入状态。
 * 场景单位与挂件 viewBox 一致（1 单位 = 1/150 挂件尺寸），y 轴向上、z 轴朝向镜头。
 */

import type { Group, Material, Mesh, MeshPhysicalMaterial } from 'three'
import { getEmployeeAvatarIconGlyph } from '../common/EmployeeAvatar'

export type RobotStageProps = {
  /** 任务状态：idle / running / confirm / done / error */
  status?: string
  /** 空闲时的调皮动作：wave / hop / tilt / clap */
  play?: string
  /** 睡眠态：长时间无交互后只保留极缓呼吸，屏幕压暗、头微垂 */
  sleep?: boolean
  /** 屏幕脸素材（员工头像 data URL），为空时显示员工头像图标 */
  faceImage?: string | null
  /** 员工头像图标 key（robot/user/team/...），无上传头像时绘制在屏幕上 */
  faceIcon?: string | null
  /** 屏幕主色（员工头像色），决定屏幕玻璃的色调 */
  accent?: string
  /** 光标相对挂件中心的归一化位置（-1..1），驱动头部跟随 */
  lookX?: number
  lookY?: number
}

export type RobotStageHandle = {
  update: (p: RobotStageProps) => void
  resize: () => void
  dispose: () => void
}

export type RobotStageOptions = {
  /** 静态模式：只渲染按需帧（设置页预览），不跑动画循环 */
  still?: boolean
}

const DEG = Math.PI / 180
/** 角色总高 120 单位，脚底落在地面 y = -60 */
const GROUND_Y = -60

/** 头部：接近方形的大圆角方体（宽高比约 1.15，圆角约为高度的 1/5，对齐设计图轮廓） */
const HEAD = { w: 76, h: 65, d: 62, r: 14 }
/** 屏幕：占头部 84%×78%，四周留 6.5 单位白边；外圈再留 2.2 单位做斜切边框 */
const SCREEN = { w: 63, h: 51, r: 9.5, bevel: 2.2, depth: 3 }
/** 躯干：肩窄腰收胯宽的沙漏，最宽 44.4、高约 44（前后压扁到 0.5） */
const BODY_Z = 0.5
const BODY_PROFILE: Array<[number, number]> = [
  [0, -43.6], [9, -43.4], [16, -42.8], [19.4, -41.6], [21.2, -39.8],
  [22.2, -37], [22.2, -34], [21.6, -30.5], [20.6, -26], [19.8, -21],
  [19.2, -16], [18.4, -11], [17.2, -7], [14.5, -3.5], [10, -1], [0, 0.5],
]
/** 手臂：上臂胶囊 + 圆润手掌；略靠前挂，轮廓线不会被躯干吞掉 */
const ARM = { r: 4, len: 16.5, handR: 5.5, x: 21, y: -7, z: 3 }
/** 腿：胯部垂下的短胶囊 + 外八前伸的圆角靴，脚底贴地 */
const LEG = { r: 8, len: 8, x: 10.2, hipY: -36 }
const FOOT = { w: 20.5, h: 9, d: 20, r: 4.6, x: 1.2, z: 3 }

type Pose = {
  rootY: number
  rootRotZ: number
  sqx: number
  sqy: number
  headZ: number
  headY: number
  headX: number
  armL: number
  armR: number
  armLX: number
  armRX: number
  legLX: number
  legRX: number
  screen: number
  flash: number
  warn: number
  shadow: number
}

const emptyPose = (): Pose => ({
  rootY: 0, rootRotZ: 0, sqx: 1, sqy: 1, headZ: 0, headY: 0, headX: 0,
  armL: 0, armR: 0, armLX: 0, armRX: 0, legLX: 0, legRX: 0,
  screen: 1, flash: 0, warn: 0, shadow: 1,
})

/** 每帧重置姿态用的基准值（避免逐帧分配对象） */
const POSE_DEFAULTS = emptyPose()
const POSE_KEYS = Object.keys(POSE_DEFAULTS) as Array<keyof Pose>

/* ================= 屏幕贴图 ================= */

function hexToHue(hex: string): number {
  let s = (hex || '').replace('#', '')
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  if (s.length !== 6) return 216
  const r = parseInt(s.slice(0, 2), 16) / 255
  const g = parseInt(s.slice(2, 4), 16) / 255
  const b = parseInt(s.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d < 1e-6) return 216
  if (max === r) return ((g - b) / d + (g < b ? 6 : 0)) * 60
  if (max === g) return ((b - r) / d + 2) * 60
  return ((r - g) / d + 4) * 60
}

const hsl = (h: number, s: number, l: number, a = 1) =>
  `hsla(${Math.round(h)},${Math.round(s)}%,${Math.round(l)}%,${a})`

/** 应用图标的 W 标识（与 resources/icons/icon.svg 同源） */
function drawLogo(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const scale = (W * 0.82) / 512
  ctx.save()
  ctx.translate(W / 2, H / 2 + H * 0.035)
  ctx.scale(scale, scale)
  ctx.translate(-256, -260)
  const g = ctx.createLinearGradient(0, 130, 0, 400)
  g.addColorStop(0, '#FFFFFF')
  g.addColorStop(0.55, '#FFFFFF')
  g.addColorStop(1, '#FAFCFF')
  ctx.strokeStyle = g
  ctx.fillStyle = g
  ctx.lineWidth = 58
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(130, 186)
  ctx.lineTo(192, 362)
  ctx.lineTo(256, 252)
  ctx.lineTo(320, 362)
  ctx.lineTo(382, 186)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(256, 170, 40, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 员工头像按 cover 铺满屏幕，略作提亮让它更像“点亮”的屏幕 */
function drawAvatar(ctx: CanvasRenderingContext2D, img: HTMLImageElement, W: number, H: number) {
  const s = Math.max(W / img.width, H / img.height)
  const w = img.width * s
  const h = img.height * s
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h)
}

/** 员工头像图标：白色字形居中绘制，方向与列表头像一致 */
function drawGlyph(ctx: CanvasRenderingContext2D, icon: string, W: number, H: number) {
  const glyph = getEmployeeAvatarIconGlyph(icon)
  const s = (Math.min(W, H) * 0.5) / 896
  ctx.save()
  ctx.translate(W / 2, H / 2)
  ctx.scale(s, s)
  ctx.translate(-512, -512)
  ctx.fillStyle = '#fff'
  ctx.fill(new Path2D(glyph.path))
  ctx.restore()
}

export function drawScreen(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  faceImage: string | null | undefined,
  faceIcon: string | null | undefined,
  accent: string,
  avatar: HTMLImageElement | null,
) {
  // 圆角由 3D 玻璃几何裁出，贴图铺满整张画布即可；
  // 若在贴图里裁圆角，透明边缘会被不透明材质当作黑色，屏幕四角会出现黑边
  ctx.clearRect(0, 0, W, H)
  ctx.save()

  const hue = hexToHue(accent)
  // 屏幕底色：饱和的品牌蓝，上亮下暗，白色标识压在上面像“点亮”
  const base = ctx.createLinearGradient(0, 0, W * 0.2, H)
  base.addColorStop(0, hsl(hue + 2, 84, 60))
  base.addColorStop(0.38, hsl(hue + 4, 86, 55))
  base.addColorStop(0.75, hsl(hue + 5, 85, 51))
  base.addColorStop(1, hsl(hue + 3, 83, 47))
  ctx.fillStyle = base
  ctx.fillRect(0, 0, W, H)

  // 左上柔光：玻璃面反射的环境光，压在底色上、标识之下
  const sheen = ctx.createRadialGradient(W * 0.3, H * 0.24, 0, W * 0.3, H * 0.24, W * 0.58)
  sheen.addColorStop(0, 'rgba(255,255,255,.2)')
  sheen.addColorStop(0.5, 'rgba(255,255,255,.06)')
  sheen.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = sheen
  ctx.fillRect(0, 0, W, H)

  if (faceImage && avatar) drawAvatar(ctx, avatar, W, H)
  else if (faceIcon) drawGlyph(ctx, faceIcon, W, H)
  else drawLogo(ctx, W, H)

  // 屏幕内凹阴影：只在顶部略强，四周很淡，避免把标识压灰
  const top = ctx.createLinearGradient(0, 0, 0, H * 0.15)
  top.addColorStop(0, 'rgba(4,10,30,.3)')
  top.addColorStop(0.5, 'rgba(4,10,30,.08)')
  top.addColorStop(1, 'rgba(4,10,30,0)')
  ctx.fillStyle = top
  ctx.fillRect(0, 0, W, H * 0.15)
  const bottom = ctx.createLinearGradient(0, H, 0, H * 0.82)
  bottom.addColorStop(0, 'rgba(4,10,30,.24)')
  bottom.addColorStop(1, 'rgba(4,10,30,0)')
  ctx.fillStyle = bottom
  ctx.fillRect(0, H * 0.82, W, H * 0.18)
  const left = ctx.createLinearGradient(0, 0, W * 0.07, 0)
  left.addColorStop(0, 'rgba(4,10,30,.18)')
  left.addColorStop(1, 'rgba(4,10,30,0)')
  ctx.fillStyle = left
  ctx.fillRect(0, 0, W * 0.07, H)
  const right = ctx.createLinearGradient(W, 0, W * 0.93, 0)
  right.addColorStop(0, 'rgba(4,10,30,.18)')
  right.addColorStop(1, 'rgba(4,10,30,0)')
  ctx.fillStyle = right
  ctx.fillRect(W * 0.93, 0, W * 0.07, H)
  ctx.restore()
}

/* ================= 姿态动画 ================= */

/** 0→1→0 的进出场包络，保证一次性动作不突兀 */
function envelope(t: number, dur: number, inT = 0.16, outT = 0.22) {
  if (t < 0 || t > dur) return 0
  const k = Math.min(1, t / inT, (dur - t) / outT)
  return k * k * (3 - 2 * k)
}

function basePose(t: number, status: string, sleep: boolean, p: Pose): Pose {
  Object.assign(p, POSE_DEFAULTS)
  switch (status) {
    case 'running':
      p.rootY = Math.sin(t * 5.2) * 1.6
      p.rootRotZ = Math.sin(t * 2.6) * 1.4
      p.sqy = 1 + Math.sin(t * 10.4) * 0.012
      p.headZ = Math.sin(t * 2.6 + 0.6) * 2.4
      p.headY = Math.sin(t * 1.3) * 5
      // 跑步摆臂主要靠前后摆动（armLX/RX），外张角度只留一点，避免像张开翅膀
      p.armL = -9
      p.armR = 9
      p.armLX = Math.sin(t * 5.2) * 26
      p.armRX = -Math.sin(t * 5.2) * 26
      p.legLX = Math.sin(t * 5.2) * 10
      p.legRX = -Math.sin(t * 5.2) * 10
      p.screen = 0.78 + (Math.sin(t * 3.1) * 0.5 + 0.5) * 0.34
      break
    case 'confirm':
      p.rootY = Math.sin(t * 1.5) * 1.1
      p.rootRotZ = Math.sin(t * 1.5) * 0.8
      p.headZ = 5 + Math.sin(t * 1.5) * 2.2
      p.headY = 6
      p.armR = 66 + Math.sin(t * 3) * 9
      p.armL = -8
      p.screen = 0.9 + (Math.sin(t * 1.5) * 0.5 + 0.5) * 0.2
      break
    case 'done':
      p.rootY = Math.sin(t * 4) * 1.4
      p.headZ = Math.sin(t * 4) * 3
      p.armL = -92 - Math.sin(t * 4) * 4
      p.armR = 92 + Math.sin(t * 4) * 4
      p.screen = 1.15
      break
    case 'error':
      p.rootRotZ = Math.sin(t * 20) * 3
      p.headZ = Math.sin(t * 20) * 2.2
      p.armL = -12
      p.armR = 12
      p.warn = 0.2 + Math.sin(t * 6) * 0.08
      break
    default:
      if (sleep) {
        // 睡眠：极慢的呼吸起伏 + 头部微垂 + 屏幕压暗，几乎不动，避免打扰用户
        p.rootY = Math.sin(t * 0.5) * 0.5
        p.sqy = 1 + Math.sin(t * 0.5) * 0.007
        p.sqx = 1 - Math.sin(t * 0.5) * 0.005
        p.headX = 7 + Math.sin(t * 0.5) * 0.6
        p.armL = -2
        p.armR = 2
        p.screen = 0.52 + Math.sin(t * 0.5) * 0.025
        break
      }
      // idle：呼吸 + 缓慢左右打量，避免“站桩”
      p.rootY = Math.sin(t * 1.15) * 0.9
      p.rootRotZ = Math.sin(t * 0.55) * 0.9
      p.sqy = 1 + Math.sin(t * 1.15) * 0.011
      p.sqx = 1 - Math.sin(t * 1.15) * 0.008
      p.headZ = Math.sin(t * 0.55 + 0.7) * 1.9
      p.headY = Math.sin(t * 0.27) * 7
      // 手臂自然外张 4°，手掌垂在胯侧不穿模
      p.armL = -4 - Math.sin(t * 0.55 + 1.1) * 1.6
      p.armR = 4 + Math.sin(t * 0.55 + 0.3) * 1.6
      p.screen = 0.94 + Math.sin(t * 1.5) * 0.06
  }
  return p
}

/** 一次性调皮动作叠加在基础姿态上（角度单位：度） */
function applyPlay(p: Pose, play: string, t: number) {
  switch (play) {
    case 'wave': {
      const e = envelope(t, 1.6, 0.2, 0.26)
      p.armR += (58 + Math.sin(t * 15) * 17) * e
      p.headZ += 3 * e
      p.headY -= 7 * e
      break
    }
    case 'hop': {
      const e = envelope(t, 1.5, 0.12, 0.3)
      const air = e > 0 ? Math.sin(Math.min(1, t / 1.5) * Math.PI) : 0
      // 跳起高度要留在取景余量内，否则头顶会被 canvas 裁掉
      p.rootY += 10 * air
      p.sqy *= 1 - 0.09 * (1 - air) * e
      p.sqx *= 1 + 0.07 * (1 - air) * e
      p.rootRotZ += 3 * Math.sin(t * 9) * e
      p.legLX -= 10 * air
      p.legRX -= 10 * air
      p.armL -= 52 * e
      p.armR += 52 * e
      p.headZ += 5 * air
      p.shadow = 1 - air * 0.38
      break
    }
    case 'tilt': {
      const e = envelope(t, 1.6, 0.22, 0.3)
      p.headZ += 15 * e
      p.headY += 6 * e
      p.rootRotZ -= 2.5 * e
      p.armL -= 4 * e
      break
    }
    case 'clap': {
      const e = envelope(t, 1.5, 0.16, 0.24)
      const beat = Math.sin(t * 13)
      p.armL += (26 + beat * 8) * e
      p.armR += (-26 - beat * 8) * e
      p.armLX -= 62 * e
      p.armRX -= 62 * e
      p.rootY += Math.abs(Math.sin(t * 13)) * 1.6 * e
      p.headZ += 4 * e
      break
    }
    default:
      break
  }
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k

export async function createRobotStage(
  canvas: HTMLCanvasElement,
  initial: RobotStageProps = {},
  options: RobotStageOptions = {},
): Promise<RobotStageHandle> {
  const still = !!options.still
  const THREE = await import('three')
  const [{ RoundedBoxGeometry }, { RoomEnvironment }] = await Promise.all([
    import('three/addons/geometries/RoundedBoxGeometry.js'),
    import('three/addons/environments/RoomEnvironment.js'),
  ])

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
    // 静态预览不再逐帧重绘，需要保留绘制缓冲，避免画面被清空
    preserveDrawingBuffer: still,
  })
  renderer.setClearAlpha(0)
  // 挂件最大 192 CSS px，2 倍 DPR 已经很省；比 1.75 更清晰，避免小尺寸下发糊
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap

  const scene = new THREE.Scene()
  // 长焦视角：压低透视强度，避免头部（离镜头更近）比身体明显放大
  const CAM_DIST = 1067
  /** 竖直方向取景半高：角色高约 121 单位，留出跳跃与头部摆动的余量，避免被裁切 */
  const FRAME_HALF = 75
  const camera = new THREE.PerspectiveCamera(7.5, 1, 1, 4000)
  camera.position.set(0, 0, CAM_DIST)
  camera.lookAt(0, 0, 0)

  const pmrem = new THREE.PMREMGenerator(renderer)
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envTex
  pmrem.dispose()

  /* ---------- 灯光：左上方主光 + 弱天空补光 + 右后轮廓光 ---------- */
  const key = new THREE.DirectionalLight(0xffffff, 2.5)
  key.position.set(-52, 116, 92)
  key.castShadow = true
  // 挂件尺寸很小，512 的软阴影已经足够，省下一次半的阴影采样开销
  key.shadow.mapSize.set(512, 512)
  key.shadow.radius = 9
  key.shadow.bias = -0.0018
  const sc = key.shadow.camera
  sc.left = -80; sc.right = 80; sc.top = 100; sc.bottom = -40; sc.near = 40; sc.far = 300
  scene.add(key)
  const fill = new THREE.HemisphereLight(0xFFFFFF, 0x93A0B6, 0.15)
  scene.add(fill)
  const rim = new THREE.DirectionalLight(0xE4EDFF, 0.3)
  rim.position.set(64, 34, -90)
  scene.add(rim)

  /**
   * 白色塑料的边沿层次：
   * 1) 菲涅尔边缘把轮廓压暗一点，白底上也有清晰的形体边界（设计图轮廓是浅灰而非深色描边）
   * 2) 越靠下越暗，模拟地面遮蔽，让身体底部和腿不像一块死白
   */
  const shade = (mat: MeshPhysicalMaterial) => {
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vRimY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRimY = (modelMatrix * vec4(transformed, 1.0)).y;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRimY;')
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          float nv = clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);
          float rimF = smoothstep(0.36, 1.0, 1.0 - nv);
          float vFade = mix(0.7, 1.02, smoothstep(-58.0, 30.0, vRimY));
          // 右半侧压一层冷灰，模仿设计图里自上左打光后的塑胶明暗
          float side = smoothstep(-0.35, 0.95, normal.x);
          vec3 tint = mix(vec3(1.0), vec3(0.84, 0.85, 0.89), side);
          gl_FragColor.rgb *= tint * mix(1.0, 0.72, rimF) * vFade;`)
    }
    mat.customProgramCacheKey = () => 'wa-secretary-rim'
    return mat
  }
  const plastic = (roughness: number, clearcoat: number) => shade(new THREE.MeshPhysicalMaterial({
    // 略带冷灰的白，避免在浅色桌面上“纯白糊成一片”
    color: 0xF6F7FA,
    roughness,
    metalness: 0,
    clearcoat,
    clearcoatRoughness: 0.38,
    envMapIntensity: 0.18,
  }))
  const matHead = plastic(0.4, 0.35)
  const matBody = plastic(0.52, 0.22)
  const matLimb = plastic(0.46, 0.28)

  /**
   * 卡通描边：几何体沿法线外扩后只画背面，轮廓上就会压出一条细边，
   * 贴近设计图里“白色塑料 + 深灰描边”的观感；只加在头/身体/四肢上，屏幕不加。
   */
  const matOutline = new THREE.MeshBasicMaterial({ color: 0x333B4A, side: THREE.BackSide })
  matOutline.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\ntransformed += normalize(normal) * 0.7;',
    )
  }
  matOutline.customProgramCacheKey = () => 'wa-secretary-outline'
  const outline = (mesh: Mesh) => {
    mesh.add(new THREE.Mesh(mesh.geometry, matOutline))
    return mesh
  }

  const root = new THREE.Group()
  scene.add(root)

  /* ---------- 躯干：肩窄腰收胯宽的沙漏回转体（前后略扁） ---------- */
  const bodyPts = new THREE.SplineCurve(BODY_PROFILE.map(([r, y]) => new THREE.Vector2(r, y))).getPoints(56)
    .map((p) => new THREE.Vector2(Math.max(0, p.x), p.y))
  const bodyGeo = new THREE.LatheGeometry(bodyPts, 48)
  const body = new THREE.Mesh(bodyGeo, matBody)
  body.scale.z = BODY_Z
  body.castShadow = true
  body.receiveShadow = true
  root.add(outline(body))

  /* ---------- 腿：胯部胶囊 + 圆角靴，整条腿绕胯部转动 ---------- */
  const legGeo = new THREE.CapsuleGeometry(LEG.r, LEG.len, 6, 16)
  legGeo.translate(0, -(LEG.len / 2 + LEG.r), 0)
  const footGeo = new RoundedBoxGeometry(FOOT.w, FOOT.h, FOOT.d, 3, FOOT.r)
  const legs: Group[] = []
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group()
    pivot.position.set(sx * LEG.x, LEG.hipY, 0)
    // 双腿微微向外张开，靴子之间留出小缝，站姿更稳
    pivot.rotation.z = sx * 1.2 * DEG
    const leg = new THREE.Mesh(legGeo, matLimb)
    leg.castShadow = true
    pivot.add(outline(leg))
    const foot = new THREE.Mesh(footGeo, matLimb)
    foot.position.set(sx * FOOT.x, GROUND_Y + FOOT.h / 2 - LEG.hipY, FOOT.z)
    foot.castShadow = true
    foot.receiveShadow = true
    pivot.add(outline(foot))
    root.add(pivot)
    legs.push(pivot)
  }

  /* ---------- 手臂：上臂胶囊 + 椭圆手掌，绕肩点旋转 ---------- */
  const armGeo = new THREE.CapsuleGeometry(ARM.r, ARM.len, 6, 16)
  armGeo.translate(0, -(ARM.len / 2 + ARM.r), 0)
  const handGeo = new THREE.SphereGeometry(ARM.handR, 18, 14)
  const armGroups: Group[] = []
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group()
    pivot.position.set(sx * ARM.x, ARM.y, ARM.z)
    const arm = new THREE.Mesh(armGeo, matLimb)
    arm.castShadow = true
    pivot.add(outline(arm))
    // 手掌压成略扁的椭圆“手套”，比正球更接近设计图里的圆手
    const hand = new THREE.Mesh(handGeo, matLimb)
    hand.position.y = -(ARM.len + ARM.r * 2) + 0.8
    hand.scale.set(1.04, 1.2, 0.9)
    hand.castShadow = true
    pivot.add(outline(hand))
    root.add(pivot)
    armGroups.push(pivot)
  }
  const [armL, armR] = armGroups

  /* ---------- 头：圆角方体 + 嵌进去的屏幕 ---------- */
  // 头绕脖子（头部底边）摆动，所以支点放在头的下沿
  const headPivot = new THREE.Group()
  headPivot.position.y = -4
  root.add(headPivot)
  const head = new THREE.Group()
  headPivot.add(head)

  const headGeo = new RoundedBoxGeometry(HEAD.w, HEAD.h, HEAD.d, 5, HEAD.r)
  const headMesh = new THREE.Mesh(headGeo, matHead)
  headMesh.position.y = HEAD.h / 2
  headMesh.castShadow = true
  headMesh.receiveShadow = true
  head.add(outline(headMesh))

  const screenCanvas = document.createElement('canvas')
  screenCanvas.width = 704
  screenCanvas.height = 570
  const sctx = screenCanvas.getContext('2d')!
  const screenTex = new THREE.CanvasTexture(screenCanvas)
  screenTex.colorSpace = THREE.SRGBColorSpace
  screenTex.anisotropy = 4
  // 部分显卡/驱动上传 canvas 素材时会偶发忽略 UNPACK_FLIP_Y_WEBGL，导致屏幕脸上下翻转；
  // 这里关掉该标志，固定用 UV 的负向缩放做垂直翻转，结果与硬件路径无关
  screenTex.flipY = false
  // ExtrudeGeometry 的正面 UV 直接用形状坐标（单位级），这里换算成 0..1 并把贴图对齐到玻璃正面
  const capW = SCREEN.w
  const capH = SCREEN.h
  screenTex.wrapS = THREE.ClampToEdgeWrapping
  screenTex.wrapT = THREE.ClampToEdgeWrapping
  screenTex.repeat.set(1 / capW, -1 / capH)
  screenTex.offset.set(0.5, 0.5)

  // 玻璃正面是外轮廓内缩 bevel 后的形状；外圈由斜切边框形成白色屏框
  const outerW = SCREEN.w + SCREEN.bevel * 2
  const outerH = SCREEN.h + SCREEN.bevel * 2
  const outerR = SCREEN.r + SCREEN.bevel
  const screenShape = new THREE.Shape()
  {
    const w = outerW, h = outerH, r = outerR
    const x = -w / 2, y = -h / 2
    screenShape.moveTo(x + r, y)
    screenShape.lineTo(x + w - r, y)
    screenShape.quadraticCurveTo(x + w, y, x + w, y + r)
    screenShape.lineTo(x + w, y + h - r)
    screenShape.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
    screenShape.lineTo(x + r, y + h)
    screenShape.quadraticCurveTo(x, y + h, x, y + h - r)
    screenShape.lineTo(x, y + r)
    screenShape.quadraticCurveTo(x, y, x + r, y)
  }
  const screenGeo = new THREE.ExtrudeGeometry(screenShape, {
    depth: SCREEN.depth,
    bevelEnabled: true,
    bevelThickness: SCREEN.bevel,
    bevelSize: SCREEN.bevel,
    bevelSegments: 3,
    curveSegments: 10,
  })
  screenGeo.computeBoundingBox()
  const sBB = screenGeo.boundingBox!
  screenGeo.translate(0, 0, -sBB.max.z)

  // 屏幕是贴图直出的面板块：不走光照与色调映射，颜色与设计图保持像素级一致；
  // 立体感由白色斜切边框与玻璃高光提供
  const screenMat = new THREE.MeshBasicMaterial({
    map: screenTex,
    toneMapped: false,
  })
  const screenMesh = new THREE.Mesh(screenGeo, [screenMat, matHead])
  screenMesh.position.y = HEAD.h / 2
  screenMesh.position.z = HEAD.d / 2 + 0.6
  head.add(screenMesh)

  // 闪光 / 报错覆盖层，跟随屏幕形状
  const overShape = new THREE.Shape()
  const gw = SCREEN.w
  const gh = SCREEN.h
  {
    const r = SCREEN.r
    const x = -gw / 2, y = -gh / 2
    overShape.moveTo(x + r, y)
    overShape.lineTo(x + gw - r, y)
    overShape.quadraticCurveTo(x + gw, y, x + gw, y + r)
    overShape.lineTo(x + gw, y + gh - r)
    overShape.quadraticCurveTo(x + gw, y + gh, x + gw - r, y + gh)
    overShape.lineTo(x + r, y + gh)
    overShape.quadraticCurveTo(x, y + gh, x, y + gh - r)
    overShape.lineTo(x, y + r)
    overShape.quadraticCurveTo(x, y, x + r, y)
  }
  const overGeo = new THREE.ShapeGeometry(overShape, 20)
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })
  const flashMesh = new THREE.Mesh(overGeo, flashMat)
  flashMesh.position.y = HEAD.h / 2
  flashMesh.position.z = HEAD.d / 2 + 1
  head.add(flashMesh)
  const warnMat = new THREE.MeshBasicMaterial({ color: 0xC0392B, transparent: true, opacity: 0, depthWrite: false })
  const warnMesh = new THREE.Mesh(overGeo, warnMat)
  warnMesh.position.copy(flashMesh.position)
  warnMesh.position.z += 0.05
  head.add(warnMesh)

  /* ---------- 接地投影：面向镜头的软椭圆，随跳跃缩小变淡 ---------- */
  const shadowTex = (() => {
    const c = document.createElement('canvas')
    c.width = 256; c.height = 128
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(128, 64, 0, 128, 64, 128)
    g.addColorStop(0, 'rgba(26,34,52,.5)')
    g.addColorStop(0.42, 'rgba(26,34,52,.22)')
    g.addColorStop(1, 'rgba(26,34,52,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 256, 128)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  })()
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.55 })
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(62, 14), shadowMat)
  shadow.position.set(0, GROUND_Y + 0.4, -14)
  scene.add(shadow)

  /* ---------- 屏幕贴图更新 ---------- */
  let avatarImg: HTMLImageElement | null = null
  let avatarSrc = ''
  let currentAccent = initial.accent || '#1E6FE0'
  let currentFace: string | null = initial.faceImage || null
  let currentIcon: string | null = initial.faceIcon || null
  /** 静态模式的按需重绘入口（动画循环就绪后赋值） */
  let renderOnce: () => void = () => {}
  const redrawScreen = () => {
    drawScreen(sctx, screenCanvas.width, screenCanvas.height, currentFace, currentIcon, currentAccent, avatarImg)
    screenTex.needsUpdate = true
    renderOnce()
  }

  const setFace = (src: string | null) => {
    const next = src || null
    if (next === currentFace && avatarImg) return
    currentFace = next
    if (!next) {
      avatarImg = null
      avatarSrc = ''
      redrawScreen()
      return
    }
    if (avatarSrc === next) return
    avatarSrc = next
    const img = new Image()
    img.onload = () => {
      if (avatarSrc !== next) return
      avatarImg = img
      redrawScreen()
    }
    img.onerror = () => { avatarImg = null; redrawScreen() }
    img.src = next
  }

  const setAccent = (color?: string) => {
    const next = color || '#1E6FE0'
    if (next === currentAccent) return
    currentAccent = next
    redrawScreen()
  }

  const setFaceIcon = (icon?: string | null) => {
    const next = icon || null
    if (next === currentIcon) return
    currentIcon = next
    redrawScreen()
  }

  redrawScreen()
  if (currentFace) setFace(currentFace)

  /* ---------- 状态与动画循环 ---------- */
  const state = { status: initial.status || 'idle', play: initial.play || '', playAt: performance.now(), sleep: !!initial.sleep }
  const cur = emptyPose()
  const base = emptyPose()
  const target = emptyPose()
  const t0 = performance.now()
  let last = t0
  let lastDraw = 0
  let raf = 0
  let disposed = false
  let doneAt = -999

  /** 头部跟随光标的角度上限（度），避免扭成“歪脖子” */
  const LOOK = { yaw: 14, pitch: 9 }
  const clampLook = (v: number | undefined) => Math.max(-1, Math.min(1, v || 0))
  const lookTarget = { x: clampLook(initial.lookX), y: clampLook(initial.lookY) }
  const lookCur = { x: lookTarget.x, y: lookTarget.y }

  const applyPose = (p: Pose) => {
    // 缩放以脚底为基准：sqy 变化时用位移补偿，避免角色陷进地面或悬空
    root.position.y = p.rootY + GROUND_Y * (1 - p.sqy)
    root.rotation.z = p.rootRotZ * DEG
    root.scale.set(p.sqx, p.sqy, 1)
    headPivot.rotation.z = p.headZ * DEG
    // 头部朝向 = 待机摆动 + 光标跟随（限幅，鼠标太远时会回到自然姿态）
    headPivot.rotation.y = (p.headY + lookCur.x * LOOK.yaw) * DEG
    headPivot.rotation.x = (p.headX + lookCur.y * LOOK.pitch) * DEG
    armL.rotation.set(p.armLX * DEG, 0, p.armL * DEG)
    armR.rotation.set(p.armRX * DEG, 0, p.armR * DEG)
    legs[0].rotation.x = p.legLX * DEG
    legs[1].rotation.x = p.legRX * DEG
    screenMat.color.setScalar(p.screen)
    flashMat.opacity = p.flash
    warnMat.opacity = p.warn
    const sk = 1 - (1 - p.shadow) * 0.35
    shadow.scale.set(sk, sk, 1)
    shadowMat.opacity = 0.62 * p.shadow
  }

  /** 计算一帧姿态并渲染（静态模式下也用它出图） */
  const draw = (now: number) => {
    if (disposed) return
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    lastDraw = now

    // 光标跟随做低通，鼠标抖动不会直接传给头部
    const lk = 1 - Math.exp(-dt * 9)
    lookCur.x = lerp(lookCur.x, lookTarget.x, lk)
    lookCur.y = lerp(lookCur.y, lookTarget.y, lk)

    // 基础姿态（状态驱动）平滑过渡，一次性动作直接叠加，避免抖动被抹平
    basePose((now - t0) / 1000, state.status, state.sleep, base)
    // 入睡 / 醒来的姿态变化放慢，避免突然垂头或猛地抬头
    const k = 1 - Math.exp(-dt * (state.sleep ? 2.4 : 14))
    for (const key of POSE_KEYS) cur[key] = lerp(cur[key], base[key], k)
    Object.assign(target, cur)
    if (state.play) applyPlay(target, state.play, (now - state.playAt) / 1000)
    // 完成 / 报错的闪光：状态切换瞬间触发一次
    if (now - doneAt < 700) {
      target.flash = Math.max(0, 1 - (now - doneAt) / 700) * 0.6
    }
    applyPose(target)
    renderer.render(scene, camera)
  }

  const tick = (now: number) => {
    if (disposed) return
    raf = requestAnimationFrame(tick)
    // 静止待机 30fps、动作与任务态 60fps、睡眠 15fps：常驻小挂件没必要跑满刷新率
    const interval = state.status === 'idle' && !state.play ? (state.sleep ? 66 : 30) : 15
    if (now - lastDraw < interval) return
    draw(now)
  }

  renderOnce = () => { if (still) draw(performance.now()) }

  const resize = () => {
    const w = Math.max(1, canvas.clientWidth || 140)
    const h = Math.max(1, canvas.clientHeight || 140)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    // 统一按竖直方向 150 单位取景，保证不同尺寸下角色占比一致
    camera.fov = (2 * Math.atan(FRAME_HALF / CAM_DIST) * 180) / Math.PI
    camera.updateProjectionMatrix()
    if (still) draw(performance.now())
  }
  resize()
  if (!still) raf = requestAnimationFrame(tick)

  return {
    update(next) {
      if (next.status && next.status !== state.status) {
        state.status = next.status
        if (next.status === 'done' || next.status === 'error') doneAt = performance.now()
      }
      if (next.play !== undefined && next.play !== state.play) {
        state.play = next.play || ''
        state.playAt = performance.now()
      }
      if (next.sleep !== undefined && next.sleep !== state.sleep) state.sleep = next.sleep
      if (next.faceImage !== undefined) setFace(next.faceImage || null)
      if (next.faceIcon !== undefined) setFaceIcon(next.faceIcon)
      if (next.accent !== undefined) setAccent(next.accent)
      if (next.lookX !== undefined) lookTarget.x = clampLook(next.lookX)
      if (next.lookY !== undefined) lookTarget.y = clampLook(next.lookY)
      // 静态预览没有动画循环，属性变化后补一帧
      if (still) renderOnce()
    },
    resize,
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      scene.traverse((o) => {
        const mesh = o as Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const m = mesh.material as Material | Material[] | undefined
        if (Array.isArray(m)) m.forEach((x) => x.dispose())
        else if (m) m.dispose()
      })
      screenTex.dispose()
      shadowTex.dispose()
      envTex.dispose()
      renderer.dispose()
    },
  }
}
