import type { SecretaryCharacterId } from '../../../electron/shared/channels/secretary'
import { getEmployeeAvatarIconGlyph } from '../common/EmployeeAvatar'

/** 空闲时的调皮小动作：由 PetWindow 随机触发，配合 secretary.css 的 [data-play] 使用 */
export type PlayAction = 'bounce' | 'hop' | 'tilt' | 'wave' | 'clap' | 'wiggle'

export const CHARACTER_PLAYS: Record<SecretaryCharacterId, PlayAction[]> = {
  blob: ['bounce', 'wiggle', 'hop'],
  momo: ['wave', 'hop', 'tilt', 'bounce'],
  pip: ['clap', 'hop', 'wave', 'tilt'],
  robot: ['wave', 'hop', 'tilt', 'clap'],
}

/** 圆团子：最初的挂件形象，配色跟随员工头像 */
const Blob: React.FC = () => (
  <>
    <defs>
      <radialGradient id="blobBody" cx="34%" cy="20%" r="92%">
        <stop offset="0%" className="pc-stop-light" />
        <stop offset="52%" className="pc-stop-base" />
        <stop offset="100%" className="pc-stop-dark" />
      </radialGradient>
      <radialGradient id="blobSheen" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#fff" stopOpacity=".55" />
        <stop offset="100%" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="blobBelly" cx="50%" cy="26%" r="78%">
        <stop offset="0%" stopColor="#fff" stopOpacity=".9" />
        <stop offset="100%" stopColor="#fff" stopOpacity=".28" />
      </radialGradient>
    </defs>
    <ellipse className="pc-shadow" cx="70" cy="128" rx="29" ry="4.6" />
    <g className="pc-root">
      <path className="pc-ear" d="M45.5 34.5C36.8 21.8 42.6 11.4 55.4 18.2c2.4 6.8.5 13.8-1.6 19Z" />
      <path className="pc-ear-in" d="M48 31.6c-3.8-7-1.4-11.8 4.2-9.8 1.2 3.6.2 7.2-.8 10Z" />
      <path className="pc-ear" d="M94.5 34.5c8.7-12.7 2.9-23.1-9.9-16.3-2.4 6.8-.5 13.8 1.6 19Z" />
      <path className="pc-ear-in" d="M92 31.6c3.8-7 1.4-11.8-4.2-9.8-1.2 3.6-.2 7.2.8 10Z" />
      <path className="pc-tuft" d="M70 21.5c-1.2-7.4 3.8-11.6 9-8.4-4.2 1.2-6.2 4.2-5.6 8.4Z" />
      <path className="pc-body" d="M70 20C45 20 26 39 26 69c0 33 20 53 44 53s44-20 44-53c0-30-19-49-44-49Z" fill="url(#blobBody)" />
      <ellipse className="pc-sheen" cx="53" cy="46" rx="21" ry="17" transform="rotate(-28 53 46)" fill="url(#blobSheen)" />
      <ellipse className="pc-belly" cx="70" cy="99" rx="24.5" ry="15.5" fill="url(#blobBelly)" />
      <ellipse className="pc-foot" cx="55" cy="121" rx="8" ry="4.6" />
      <ellipse className="pc-foot" cx="85" cy="121" rx="8" ry="4.6" />
      <g className="pc-eyes">
        <ellipse className="pc-eye-white" cx="55" cy="64" rx="9.6" ry="10.4" />
        <ellipse className="pc-eye-white" cx="85" cy="64" rx="9.6" ry="10.4" />
        <g className="pc-look">
          <ellipse className="pc-pupil" cx="55.4" cy="64.6" rx="5.5" ry="5.9" />
          <ellipse className="pc-pupil" cx="84.6" cy="64.6" rx="5.5" ry="5.9" />
          <circle className="pc-glint" cx="57.4" cy="61.8" r="1.9" />
          <circle className="pc-glint" cx="86.6" cy="61.8" r="1.9" />
          <circle className="pc-glint-sm" cx="53" cy="67.2" r="1" />
          <circle className="pc-glint-sm" cx="82.2" cy="67.2" r="1" />
        </g>
      </g>
      <g className="pc-happy">
        <path d="M47 66.5q8-9.5 16 0" />
        <path d="M77 66.5q8-9.5 16 0" />
      </g>
      <g className="pc-x">
        <path d="M48 57.5l13.5 12.5M61.5 57.5L48 70" />
        <path d="M78 57.5l13.5 12.5M91.5 57.5L78 70" />
      </g>
      <ellipse className="pc-blush" cx="41" cy="81" rx="6.8" ry="3.9" />
      <ellipse className="pc-blush" cx="99" cy="81" rx="6.8" ry="3.9" />
      <path className="pc-mouth-smile" d="M63.5 84.5q6.5 6 13 0" />
      <ellipse className="pc-mouth-o" cx="70" cy="87.5" rx="3.7" ry="4.5" />
      <g className="pc-mouth-big">
        <path d="M61 81.5q9 13.5 18 0-9 4.2-18 0Z" />
        <path className="pc-tongue" d="M66.5 86.5q3.5 4.5 7 0-3.5 1.8-7 0Z" />
      </g>
    </g>
    <path className="pc-sweat" d="M99 40.5c0 0 4.2 5.4 4.2 7.9a4.2 4.2 0 0 1-8.4 0c0-2.5 4.2-7.9 4.2-7.9Z" />
    <g className="pc-spark">
      <path className="pc-spark-a" d="M31 43.5l1.5 3.6 3.6 1.5-3.6 1.5L31 53.7l-1.5-3.6-3.6-1.5 3.6-1.5Z" />
      <path className="pc-spark-b" d="M110 52l1.2 2.9 2.9 1.2-2.9 1.2L110 60.2l-1.2-2.9-2.9-1.2 2.9-1.2Z" />
    </g>
  </>
)

/** 桃桃：双丸子头小女孩，大头小身 Q 版比例 */
const Momo: React.FC = () => (
  <>
    <defs>
      <radialGradient id="momoFace" cx="42%" cy="30%" r="85%">
        <stop offset="0%" stopColor="#FFF0E2" />
        <stop offset="62%" stopColor="#FCD8BE" />
        <stop offset="100%" stopColor="#F0BC9E" />
      </radialGradient>
      <linearGradient id="momoHair" x1="0.2" y1="0" x2="0.75" y2="1">
        <stop offset="0%" stopColor="#9A6F57" />
        <stop offset="45%" stopColor="#7A5544" />
        <stop offset="100%" stopColor="#553B31" />
      </linearGradient>
      <linearGradient id="momoDress" x1="0" y1="0" x2="0.25" y2="1">
        <stop offset="0%" stopColor="#FFFEFD" />
        <stop offset="60%" stopColor="#FBF1E9" />
        <stop offset="100%" stopColor="#EFD9CB" />
      </linearGradient>
      <radialGradient id="momoIris" cx="38%" cy="26%" r="82%">
        <stop offset="0%" stopColor="#8A6B50" />
        <stop offset="45%" stopColor="#4A342A" />
        <stop offset="100%" stopColor="#241A15" />
      </radialGradient>
    </defs>
    <ellipse className="pc-shadow" cx="70" cy="127.5" rx="23" ry="4.2" />
    <g className="pc-root">
      <path className="pc-leg" d="M63.8 109.5v11.5" />
      <path className="pc-leg" d="M76.2 109.5v11.5" />
      <ellipse className="pc-shoe" cx="61.8" cy="122.5" rx="6.8" ry="4.3" />
      <ellipse className="pc-shoe" cx="78.2" cy="122.5" rx="6.8" ry="4.3" />
      <path
        className="pc-dress"
        d="M70 73.5c-7.4 0-12.2 4.1-14.8 10.8-3.6 9.2-5.7 19.4-5.7 26.6 0 4.2 2.5 6.6 6 6.6h29c3.5 0 6-2.4 6-6.6 0-7.2-2.1-17.4-5.7-26.6C82.2 77.6 77.4 73.5 70 73.5Z"
        fill="url(#momoDress)"
      />
      <path className="pc-dress-hem" d="M51.2 112q18.8 6.4 37.6 0" />
      <path className="pc-dress-dot" d="M62 92.5a2.1 2.1 0 1 0 .01 0ZM78 99.5a2.1 2.1 0 1 0 .01 0ZM69.5 105.5a2.1 2.1 0 1 0 .01 0Z" />
      <rect className="pc-neck" x="65" y="68.5" width="10" height="9.5" rx="5" />
      <g className="pc-head">
        <ellipse className="pc-hair-back" cx="70" cy="49" rx="28" ry="27" fill="url(#momoHair)" />
        <g className="pc-bun pc-bun-l">
          <circle className="pc-bun-shape" cx="41.5" cy="29.5" r="10.2" fill="url(#momoHair)" />
          <path className="pc-bun-hi" d="M37.4 25.8q3.8-3 7.2.5" />
          <circle className="pc-bun-tie" cx="46.6" cy="38.6" r="2.5" />
        </g>
        <g className="pc-bun pc-bun-r">
          <circle className="pc-bun-shape" cx="98.5" cy="29.5" r="10.2" fill="url(#momoHair)" />
          <path className="pc-bun-hi" d="M94.8 26.3q3.6-3.4 7.2-.5" />
          <circle className="pc-bun-tie" cx="93.4" cy="38.6" r="2.5" />
        </g>
        <ellipse className="pc-face" cx="70" cy="55" rx="22.6" ry="20.6" fill="url(#momoFace)" />
        <path
          className="pc-bangs"
          d="M70 34.5c-13.5 0-23.5 9-23.5 21 0 2 .3 3.8.8 5.4 1.7-6.2 5.2-10.4 9.2-11.5 2.3 2.8 7.1 4.4 13.5 4.4s11.2-1.6 13.5-4.4c4 1.1 7.5 5.3 9.2 11.5.5-1.6.8-3.4.8-5.4 0-12-10-21-23.5-21Z"
          fill="url(#momoHair)"
        />
        <path className="pc-ahoge" d="M70.8 33.4c-1.6-6.4 2.4-10.4 7.6-9.6-3.6 1.6-5.2 4.6-4.8 8.8Z" fill="url(#momoHair)" />
        <g className="pc-eyes">
          <ellipse className="pc-eye" cx="59" cy="60" rx="6.4" ry="7.8" fill="url(#momoIris)" />
          <ellipse className="pc-eye" cx="81" cy="60" rx="6.4" ry="7.8" fill="url(#momoIris)" />
          <g className="pc-look">
            <circle className="pc-glint" cx="61.1" cy="57" r="2.3" />
            <circle className="pc-glint" cx="83.1" cy="57" r="2.3" />
            <circle className="pc-glint-sm" cx="57" cy="62.8" r="1.1" />
            <circle className="pc-glint-sm" cx="79" cy="62.8" r="1.1" />
          </g>
          <path className="pc-lash" d="M52.4 53.6q6.2-3.1 12.4-1" />
          <path className="pc-lash" d="M75.2 52.6q6.2-2.1 12.4 1" />
        </g>
        <g className="pc-happy">
          <path d="M52.6 60.5q6.4-7.8 12.8 0" />
          <path d="M74.6 60.5q6.4-7.8 12.8 0" />
        </g>
        <g className="pc-x">
          <path d="M53.6 54.6l10.8 10.4M64.4 54.6L53.6 65" />
          <path d="M75.6 54.6l10.8 10.4M86.4 54.6L75.6 65" />
        </g>
        <path className="pc-brow" d="M52.6 46.6q5.8-2.4 11-.7" />
        <path className="pc-brow" d="M76.4 45.9q5.2-1.7 11 .7" />
        <ellipse className="pc-blush" cx="48.2" cy="68" rx="5.4" ry="3" />
        <ellipse className="pc-blush" cx="91.8" cy="68" rx="5.4" ry="3" />
        <path className="pc-nose" d="M68.9 65.4q1.1 1.1 2.2 0" />
        <path className="pc-mouth-smile" d="M66 69.4q4 4.2 8 0" />
        <ellipse className="pc-mouth-o" cx="70" cy="71.6" rx="2.9" ry="3.6" />
        <g className="pc-mouth-big">
          <path d="M63.8 68.2q6.2 9.4 12.4 0-6.2 2.9-12.4 0Z" />
          <path className="pc-tongue" d="M67.3 71.4q2.7 3.3 5.4 0-2.7 1.3-5.4 0Z" />
        </g>
      </g>
      <path className="pc-scarf" d="M56.8 76.2q13.2 6.6 26.4 0l-1.5 5.6q-11.7 5.6-23.4 0Z" />
      <path className="pc-scarf-end" d="M82 80.6 85.2 89.4l-5.8-1.5Z" />
      <g className="pc-arm pc-arm-l">
        <path className="pc-limb" d="M58.6 84 48.6 95" />
        <circle className="pc-hand" cx="47.5" cy="97" r="4.5" />
      </g>
      <g className="pc-arm pc-arm-r">
        <path className="pc-limb" d="M81.4 84 91.4 95" />
        <circle className="pc-hand" cx="92.5" cy="97" r="4.5" />
      </g>
    </g>
    <path className="pc-sweat" d="M96.5 41.5c0 0 3.9 5 3.9 7.3a3.9 3.9 0 0 1-7.8 0c0-2.3 3.9-7.3 3.9-7.3Z" />
    <g className="pc-spark">
      <path className="pc-spark-a" d="M29.5 49.5l1.4 3.4 3.4 1.4-3.4 1.4-1.4 3.4-1.4-3.4-3.4-1.4 3.4-1.4Z" />
      <path className="pc-spark-b" d="M111 55.5l1.1 2.7 2.7 1.1-2.7 1.1-1.1 2.7-1.1-2.7-2.7-1.1 2.7-1.1Z" />
    </g>
  </>
)

/** 皮皮：薄荷连帽衫小机灵鬼，帽耳 + 大脸 */
const Pip: React.FC = () => (
  <>
    <defs>
      <linearGradient id="pipHood" x1="0.12" y1="0" x2="0.6" y2="1">
        <stop offset="0%" stopColor="#C5F2E9" />
        <stop offset="46%" stopColor="#8ADCCE" />
        <stop offset="100%" stopColor="#4FB3A3" />
      </linearGradient>
      <linearGradient id="pipHoodIn" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#2F8C7E" />
        <stop offset="100%" stopColor="#57B9AA" />
      </linearGradient>
      <radialGradient id="pipFace" cx="42%" cy="30%" r="85%">
        <stop offset="0%" stopColor="#FFF0E2" />
        <stop offset="62%" stopColor="#FCD6BC" />
        <stop offset="100%" stopColor="#EFB995" />
      </radialGradient>
      <linearGradient id="pipHair" x1="0.2" y1="0" x2="0.65" y2="1">
        <stop offset="0%" stopColor="#5D6880" />
        <stop offset="55%" stopColor="#434C61" />
        <stop offset="100%" stopColor="#2E3547" />
      </linearGradient>
      <radialGradient id="pipIris" cx="38%" cy="26%" r="82%">
        <stop offset="0%" stopColor="#5E857F" />
        <stop offset="48%" stopColor="#2C453F" />
        <stop offset="100%" stopColor="#182622" />
      </radialGradient>
    </defs>
    <ellipse className="pc-shadow" cx="70" cy="127.5" rx="23" ry="4.2" />
    <g className="pc-root">
      <path className="pc-leg" d="M64.4 109.5v11" />
      <path className="pc-leg" d="M75.6 109.5v11" />
      <ellipse className="pc-shoe" cx="61.8" cy="122.5" rx="6.8" ry="4.3" />
      <ellipse className="pc-shoe" cx="78.2" cy="122.5" rx="6.8" ry="4.3" />
      <path
        className="pc-hoodie"
        d="M70 72.5c-11.6 0-19.4 8-21.5 20.6-1.9 11.2-1.7 19.6.5 23.2 1 1.7 2.7 2.6 5 2.6h32c2.3 0 4-.9 5-2.6 2.2-3.6 2.4-12 .5-23.2C89.4 80.5 81.6 72.5 70 72.5Z"
        fill="url(#pipHood)"
      />
      <path className="pc-pocket" d="M59.5 102.5h21l-1.7 10c-.3 1.5-1.6 2.5-3.1 2.5H64.3c-1.5 0-2.8-1-3.1-2.5Z" />
      <path className="pc-string" d="M66 79.5v8.6M74 79.5v8.6" />
      <circle className="pc-string-tip" cx="66" cy="89.2" r="1.5" />
      <circle className="pc-string-tip" cx="74" cy="89.2" r="1.5" />
      <g className="pc-head">
        <ellipse className="pc-hood-outer" cx="70" cy="47.5" rx="30" ry="28" fill="url(#pipHood)" />
        <g className="pc-ear pc-ear-l">
          <path className="pc-ear-shape" d="M51 33.5C44 24.5 45 16.5 52.8 18.2c3.6 3 5.7 7.5 6.1 12.3Z" />
          <path className="pc-ear-in" d="M53.2 29.6c-3.6-5.2-3-9.2.8-8.1 1.9 1.5 3.2 3.7 3.7 5.9Z" />
        </g>
        <g className="pc-ear pc-ear-r">
          <path className="pc-ear-shape" d="M89 33.5c7-9 6-17-1.8-15.3-3.6 3-5.7 7.5-6.1 12.3Z" />
          <path className="pc-ear-in" d="M86.8 29.6c3.6-5.2 3-9.2-.8-8.1-1.9 1.5-3.2 3.7-3.7 5.9Z" />
        </g>
        <ellipse className="pc-face" cx="70" cy="56" rx="21" ry="19.4" fill="url(#pipFace)" />
        <path
          className="pc-bangs"
          d="M70 39.5c-10.4 0-18.2 6.9-18.2 16.8 0 1.3.2 2.6.5 3.8 1.6-5 4.3-8.3 7.3-9 2.1 2.4 6 3.9 10.4 3.9s8.3-1.5 10.4-3.9c3 .7 5.7 4 7.3 9 .3-1.2.5-2.5.5-3.8 0-9.9-7.8-16.8-18.2-16.8Z"
          fill="url(#pipHair)"
        />
        <path className="pc-ahoge" d="M68.8 38.8c-2.6-5.4.2-9.4 5-9.4-3 2.1-4 4.9-3.2 8.9Z" fill="url(#pipHair)" />
        <path className="pc-hood-rim" d="M49 56c1-11.4 9.6-18.8 21-18.8S90 44.6 91 56" />
        <g className="pc-eyes">
          <ellipse className="pc-eye" cx="60.4" cy="58.2" rx="6.1" ry="7.5" fill="url(#pipIris)" />
          <ellipse className="pc-eye" cx="79.6" cy="58.2" rx="6.1" ry="7.5" fill="url(#pipIris)" />
          <g className="pc-look">
            <circle className="pc-glint" cx="62.5" cy="55.4" r="2.2" />
            <circle className="pc-glint" cx="81.7" cy="55.4" r="2.2" />
            <circle className="pc-glint-sm" cx="58.4" cy="60.8" r="1.05" />
            <circle className="pc-glint-sm" cx="77.6" cy="60.8" r="1.05" />
          </g>
          <path className="pc-lash" d="M54.2 52.4q5.8-2.9 11.6-1.1" />
          <path className="pc-lash" d="M74.2 51.3q5.8-1.8 11.6 1.1" />
        </g>
        <g className="pc-happy">
          <path d="M54.4 59.5q6-7.4 12 0" />
          <path d="M73.6 59.5q6-7.4 12 0" />
        </g>
        <g className="pc-x">
          <path d="M55.4 53.6l10 9.8M65.4 53.6l-10 9.8" />
          <path d="M74.6 53.6l10 9.8M84.6 53.6l-10 9.8" />
        </g>
        <path className="pc-brow" d="M54.4 46.6q5.2-2.4 10-.8" />
        <path className="pc-brow" d="M75.6 45.8q4.8-1.6 10 .8" />
        <ellipse className="pc-blush" cx="51.8" cy="66" rx="5.3" ry="2.9" />
        <ellipse className="pc-blush" cx="88.2" cy="66" rx="5.3" ry="2.9" />
        <path className="pc-nose" d="M68.9 64.6q1.1 1.1 2.2 0" />
        <path className="pc-mouth-smile" d="M66 68.6q4 3.8 8 0" />
        <ellipse className="pc-mouth-o" cx="70" cy="70.8" rx="2.9" ry="3.5" />
        <g className="pc-mouth-big">
          <path d="M63.9 67.4q6.1 9 12.2 0-6.1 2.8-12.2 0Z" />
          <path className="pc-tongue" d="M67.3 70.5q2.7 3.2 5.4 0-2.7 1.3-5.4 0Z" />
        </g>
      </g>
      <g className="pc-arm pc-arm-l">
        <path className="pc-sleeve" d="M55.8 82.5 46.2 94" />
        <circle className="pc-hand" cx="45" cy="96" r="4.5" />
      </g>
      <g className="pc-arm pc-arm-r">
        <path className="pc-sleeve" d="M84.2 82.5 93.8 94" />
        <circle className="pc-hand" cx="95" cy="96" r="4.5" />
      </g>
    </g>
    <path className="pc-sweat" d="M97 42.5c0 0 3.9 5 3.9 7.3a3.9 3.9 0 0 1-7.8 0c0-2.3 3.9-7.3 3.9-7.3Z" />
    <g className="pc-spark">
      <path className="pc-spark-a" d="M30.5 45.5l1.4 3.4 3.4 1.4-3.4 1.4-1.4 3.4-1.4-3.4-3.4-1.4 3.4-1.4Z" />
      <path className="pc-spark-b" d="M109.5 57.5l1.1 2.7 2.7 1.1-2.7 1.1-1.1 2.7-1.1-2.7-2.7-1.1 2.7-1.1Z" />
    </g>
  </>
)

/** 屏幕脸：员工头像图标（白色字形居中绘制，方向与列表头像一致） */
const ScreenGlyph: React.FC<{ icon: string }> = ({ icon }) => {
  const glyph = getEmployeeAvatarIconGlyph(icon)
  // viewBox 64 64 896 896 → 屏幕中心 (70, 37) 处绘制约 23 单位高的字形（与 3D 一致：屏幕高度的 50%）
  return (
    <g transform="translate(70 37) scale(0.026) translate(-512 -512)">
      <path d={glyph.path} fill="#fff" />
    </g>
  )
}

/** 波波：屏幕脸小机器人（源自应用图标）；靠多层渐变、投影与高光做出 3D 质感 */
const Robot: React.FC<{ faceImage?: string | null; faceIcon?: string | null }> = ({ faceImage, faceIcon }) => (
  <>
    <defs>
      <linearGradient id="rHeadFill" x1="0.22" y1="0" x2="0.66" y2="1">
        <stop offset="0%" stopColor="#FFFFFF" />
        <stop offset="42%" stopColor="#FBFCFE" />
        <stop offset="78%" stopColor="#EEF2F9" />
        <stop offset="100%" stopColor="#D8DEEC" />
      </linearGradient>
      <linearGradient id="rBodyFill" x1="0.16" y1="0.02" x2="0.75" y2="1">
        <stop offset="0%" stopColor="#FFFFFF" />
        <stop offset="40%" stopColor="#F7FAFE" />
        <stop offset="76%" stopColor="#E4EAF5" />
        <stop offset="100%" stopColor="#C8D0E2" />
      </linearGradient>
      <linearGradient id="rArmFill" x1="0.02" y1="0" x2="1" y2="1">
        <stop offset="0%" stopColor="#FFFFFF" />
        <stop offset="45%" stopColor="#F2F6FD" />
        <stop offset="100%" stopColor="#C6CEDF" />
      </linearGradient>
      <linearGradient id="rLegFill" x1="0.1" y1="0" x2="0.95" y2="1">
        <stop offset="0%" stopColor="#FDFDFF" />
        <stop offset="46%" stopColor="#EFF3FA" />
        <stop offset="100%" stopColor="#C2CADB" />
      </linearGradient>
      <linearGradient id="rScreenFill" x1="0.05" y1="0" x2="0.35" y2="1">
        <stop offset="0%" className="pc-screen-top" />
        <stop offset="100%" className="pc-screen-bot" />
      </linearGradient>
      <linearGradient id="rScreenShade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#061530" stopOpacity=".45" />
        <stop offset="52%" stopColor="#061530" stopOpacity="0" />
      </linearGradient>
      <linearGradient id="rHeadRim" x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0%" stopColor="#FFFFFF" stopOpacity=".95" />
        <stop offset="100%" stopColor="#FFFFFF" stopOpacity=".2" />
      </linearGradient>
      <radialGradient id="rScreenGloss" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#FFFFFF" stopOpacity=".3" />
        <stop offset="60%" stopColor="#FFFFFF" stopOpacity=".12" />
        <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="rHeadGloss" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#FFFFFF" stopOpacity=".8" />
        <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="rGroundShadow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#1B2230" stopOpacity=".36" />
        <stop offset="55%" stopColor="#1B2230" stopOpacity=".16" />
        <stop offset="100%" stopColor="#1B2230" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="rAO" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#5C6679" stopOpacity=".45" />
        <stop offset="70%" stopColor="#5C6679" stopOpacity=".16" />
        <stop offset="100%" stopColor="#5C6679" stopOpacity="0" />
      </radialGradient>
      <filter id="rSoft" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.4" />
      </filter>
      <filter id="rSoftLg" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3.6" />
      </filter>
      {/* 体积光照：把形状的 alpha 当作高度场做漫反射光照，得到接近 3D 渲染的圆润明暗 */}
      <filter id="rBevelLg" x="-35%" y="-35%" width="170%" height="170%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="b" />
        <feDiffuseLighting in="b" surfaceScale="4.2" diffuseConstant="1.85" lightingColor="#FFFFFF" result="l">
          <feDistantLight azimuth="45" elevation="52" />
        </feDiffuseLighting>
        <feComposite in="l" in2="SourceAlpha" operator="in" result="lm" />
        <feBlend in="SourceGraphic" in2="lm" mode="multiply" />
      </filter>
      <filter id="rBevelMd" x="-35%" y="-35%" width="170%" height="170%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b" />
        <feDiffuseLighting in="b" surfaceScale="3.6" diffuseConstant="1.85" lightingColor="#FFFFFF" result="l">
          <feDistantLight azimuth="45" elevation="52" />
        </feDiffuseLighting>
        <feComposite in="l" in2="SourceAlpha" operator="in" result="lm" />
        <feBlend in="SourceGraphic" in2="lm" mode="multiply" />
      </filter>
      <filter id="rBevelSm" x="-45%" y="-45%" width="190%" height="190%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b" />
        <feDiffuseLighting in="b" surfaceScale="2.8" diffuseConstant="1.85" lightingColor="#FFFFFF" result="l">
          <feDistantLight azimuth="45" elevation="52" />
        </feDiffuseLighting>
        <feComposite in="l" in2="SourceAlpha" operator="in" result="lm" />
        <feBlend in="SourceGraphic" in2="lm" mode="multiply" />
      </filter>
      <clipPath id="rHeadClip">
        <rect x="30" y="6" width="80" height="62" rx="20" />
      </clipPath>
      <clipPath id="rScreenClip">
        <rect x="40" y="14" width="60" height="46" rx="12" />
      </clipPath>
    </defs>

    <ellipse className="pc-shadow pc-shadow-soft" cx="70" cy="131" rx="29" ry="5.6" />

    <g className="pc-root">
      {/* 腿：粗圆柱，体积光照 + 腿间遮蔽 */}
      <rect className="pc-r-edge" x="50" y="104" width="16" height="28" rx="8" fill="url(#rLegFill)" filter="url(#rBevelSm)" />
      <rect className="pc-r-edge" x="74" y="104" width="16" height="28" rx="8" fill="url(#rLegFill)" filter="url(#rBevelSm)" />
      <ellipse cx="70" cy="129" rx="18" ry="4.8" fill="url(#rAO)" opacity=".9" />

      {/* 躯干：梨形；右侧核心阴影 + 底部暗部 */}
      <path
        className="pc-r-edge"
        d="M70 67c-9.4 0-15.2 4-17.4 12-3.6 8-6.6 18-8.2 25-1.2 6 1.2 12 7.6 12h36c6.4 0 8.8-6 7.6-12-1.6-7-4.6-17-8.2-25C85.2 71 79.4 67 70 67Z"
        fill="url(#rBodyFill)"
        filter="url(#rBevelMd)"
      />
      <ellipse cx="90" cy="98" rx="15" ry="22" fill="url(#rAO)" opacity=".55" />
      <ellipse cx="70" cy="113" rx="22" ry="5.5" fill="url(#rAO)" opacity=".8" />

      {/* 头投在躯干上的阴影 */}
      <ellipse cx="70" cy="74" rx="27" ry="10" fill="url(#rAO)" opacity=".9" filter="url(#rSoftLg)" />

      {/* 手臂：肩部球头 + 长圆柱 + 球形手掌，整块轮廓 */}
      <g className="pc-arm pc-arm-l">
        <g transform="rotate(6 50 80)">
          <ellipse cx="56" cy="92" rx="7" ry="13" fill="url(#rAO)" opacity=".45" />
          <path
            className="pc-r-edge"
            d="M43.6 90Q43.6 80 50 80Q56.4 80 56.4 90L56.4 99.6C56.4 101.2 57.6 102.6 57.4 105.2C57.2 108.6 53 112 50 112C47 112 42.8 108.6 42.6 105.2C42.4 102.6 43.6 101.2 43.6 99.6Z"
            fill="url(#rArmFill)"
            filter="url(#rBevelSm)"
          />
        </g>
      </g>
      <g className="pc-arm pc-arm-r">
        <g transform="rotate(-6 90 80)">
          <ellipse cx="84" cy="92" rx="7" ry="13" fill="url(#rAO)" opacity=".45" />
          <path
            className="pc-r-edge"
            d="M96.4 90Q96.4 80 90 80Q83.6 80 83.6 90L83.6 99.6C83.6 101.2 82.4 102.6 82.6 105.2C82.8 108.6 87 112 90 112C93 112 97.2 108.6 97.4 105.2C97.6 102.6 96.4 101.2 96.4 99.6Z"
            fill="url(#rArmFill)"
            filter="url(#rBevelSm)"
          />
        </g>
      </g>

      {/* 头：圆角方体 + 上缘修光 + 下半环境遮蔽 */}
      <g className="pc-head">
        <rect className="pc-r-edge" x="30" y="6" width="80" height="62" rx="20" fill="url(#rHeadFill)" filter="url(#rBevelLg)" />
        <ellipse cx="52" cy="17" rx="16" ry="8" transform="rotate(-18 52 17)" fill="url(#rHeadGloss)" />
        <g clipPath="url(#rHeadClip)">
          <path
            d="M33 32c0-9.6 3.4-16 8.6-19.8 3.6-2.6 8.8-3.9 15.4-3.9h25"
            fill="none"
            stroke="url(#rHeadRim)"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <path d="M30 56h80c0 9-6 12-13 12H43c-7 0-13-3-13-12Z" fill="#6E7A99" opacity=".2" />
        </g>

        {/* 屏幕：直接嵌在头部，用深色细沟槽表现内凹 */}
        <g className="pc-screen">
          <rect className="pc-r-screen" x="40" y="14" width="60" height="46" rx="12" fill="url(#rScreenFill)" />
          <g clipPath="url(#rScreenClip)">
            {faceImage
              ? <image href={faceImage} x="40" y="14" width="60" height="46" preserveAspectRatio="xMidYMid slice" />
              : faceIcon
                ? <ScreenGlyph icon={faceIcon} />
                : (
                  <g transform="translate(70 37) scale(0.111) translate(-256 -246)" fill="none">
                    <circle cx="256" cy="170" r="40" fill="#fff" />
                    <path d="M130 186 L192 362 L256 252 L320 362 L382 186" stroke="#fff" strokeWidth="58" strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                )}
            <rect x="40" y="14" width="60" height="46" fill="url(#rScreenShade)" />
            <ellipse cx="53" cy="20" rx="26" ry="9" transform="rotate(-16 53 20)" fill="url(#rScreenGloss)" />
            <rect className="pc-screen-flash" x="40" y="14" width="60" height="46" fill="#fff" opacity="0" />
            <rect className="pc-screen-warn" x="40" y="14" width="60" height="46" fill="#C0291F" opacity="0" />
          </g>
        </g>
      </g>
    </g>

    <path className="pc-sweat" d="M101 22c0 0 3.9 5 3.9 7.3a3.9 3.9 0 0 1-7.8 0c0-2.3 3.9-7.3 3.9-7.3Z" />
    <g className="pc-spark">
      <path className="pc-spark-a" d="M25 34l1.4 3.4 3.4 1.4-3.4 1.4L25 43.6l-1.4-3.4-3.4-1.4 3.4-1.4Z" />
      <path className="pc-spark-b" d="M113 40l1.1 2.7 2.7 1.1-2.7 1.1-1.1 2.7-1.1-2.7-2.7-1.1 2.7-1.1Z" />
    </g>
  </>
)

interface CharacterProps { faceImage?: string | null; faceIcon?: string | null }

const CHARACTERS: Record<SecretaryCharacterId, React.FC<CharacterProps>> = {
  blob: Blob,
  momo: Momo,
  pip: Pip,
  robot: Robot,
}

/** 按 id 渲染角色本体（viewBox 0 0 140 140），层叠顺序与动画钩子由 secretary.css 控制 */
export const SecretaryCharacter: React.FC<CharacterProps & { id: SecretaryCharacterId }> = ({ id, faceImage, faceIcon }) => {
  const Character = CHARACTERS[id] || Blob
  return <Character faceImage={faceImage} faceIcon={faceIcon} />
}
