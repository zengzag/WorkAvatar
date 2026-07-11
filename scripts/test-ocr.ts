/**
 * OCR 冒烟测试：验证 PaddleOCR 引擎能否正确初始化和识别
 *
 * 用法：
 *   开发态：node --experimental-strip-types scripts/test-ocr.ts <image_path>
 *   打包态：先 npm run build，然后：
 *           node --experimental-strip-types scripts/test-ocr.ts <image_path> --packaged
 *
 * 注意：需要先运行过 `npm install` 安装 paddleocr、onnxruntime-node、sharp
 */
import fs from 'fs'
import path from 'path'

function getModelDir(): string {
  // 模拟 PathService.getResourcesDir() 的逻辑
  if (process.argv.includes('--packaged')) {
    return path.join(
      process.cwd(),
      'release', '1.0.0', 'win-unpacked', 'resources', 'resources',
      'paddleocr', 'ppocr_v5_mobile',
    )
  }
  return path.join(process.cwd(), 'resources', 'paddleocr', 'ppocr_v5_mobile')
}

const MODEL_DIR = getModelDir()
const sharp = (await import('sharp')).default as any
const { PaddleOcrService } = await import('paddleocr') as any
const ort = (await import('onnxruntime-node')).default ?? (await import('onnxruntime-node'))

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
}

async function main() {
  const imagePath = process.argv[2]
  if (!imagePath) {
    console.error('Usage: node scripts/test-ocr.ts <image_path>')
    process.exit(1)
  }
  if (!fs.existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`)
    process.exit(1)
  }

  console.log('Model dir:', MODEL_DIR)
  const detPath = path.join(MODEL_DIR, 'PP-OCRv5_mobile_det_infer.onnx')
  const recPath = path.join(MODEL_DIR, 'PP-OCRv5_mobile_rec_infer.onnx')
  const dictPath = path.join(MODEL_DIR, 'ppocrv5_dict.txt')
  for (const p of [detPath, recPath, dictPath]) {
    if (!fs.existsSync(p)) {
      console.error('Missing model file:', p)
      process.exit(1)
    }
  }

  console.log('Loading PaddleOCR...')
  const start = Date.now()
  const detBuffer = toArrayBuffer(fs.readFileSync(detPath))
  const recBuffer = toArrayBuffer(fs.readFileSync(recPath))
  const dictText = fs.readFileSync(dictPath, 'utf-8')
  let charactersDictionary = dictText.split(/\r?\n/).filter(line => line.length > 0)
  if (charactersDictionary.length < 18385) {
    const padding = 18385 - charactersDictionary.length
    charactersDictionary = charactersDictionary.concat(new Array(padding).fill(''))
    console.log(`Padded dictionary with ${padding} empty entries`)
  }

  const ocr = await (PaddleOcrService as any).createInstance({
    ort,
    modelPreset: 'PP-OCRv5_mobile',
    detection: { modelBuffer: detBuffer },
    recognition: { modelBuffer: recBuffer, charactersDictionary },
  })
  console.log('Loaded in', Date.now() - start, 'ms')

  console.log('Decoding image...')
  const decoded = await sharp(imagePath)
    .removeAlpha()
    .raw({ resolveWithObject: true })
    .toBuffer({ resolveWithObject: true })
  const input = {
    width: decoded.info.width,
    height: decoded.info.height,
    data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
  }
  console.log('Image size:', input.width, 'x', input.height)

  console.log('Recognizing...')
  const t0 = Date.now()
  const raw = await ocr.recognize(input)
  const { text } = ocr.processRecognition(raw, { lineMergeThresholdRatio: 0.5 })
  console.log('Done in', Date.now() - t0, 'ms')
  console.log('--- Result ---')
  console.log('Blocks:', raw.length)
  console.log('Text:')
  console.log(text)
  console.log('---')
  // 同时以 UTF-8 写入文件，避免 PowerShell 终端编码问题
  const outPath = path.join(path.dirname(imagePath), path.basename(imagePath, path.extname(imagePath)) + '.ocr.txt')
  fs.writeFileSync(outPath, text, 'utf-8')
  console.log('Text written to:', outPath)

  await ocr.destroy()
}

main().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
