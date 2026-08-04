import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { createLogger } from '../logger'
import type { VoiceSTTLocalConfig, VoiceLocalModelStatus, VoiceLocalModelType } from '../../../shared/ipc-channels'

const logger = createLogger('LocalSTT')

/** 内置流式 Zipformer 模型目录（相对于 resources/） */
const BUILTIN_MODEL_SUBDIR = 'streaming-zipformer'

/** 获取内置流式 Zipformer 模型目录绝对路径 */
function getBuiltinModelDir(): string {
  const isDev = !app.isPackaged
  if (isDev) {
    return path.join(process.cwd(), 'resources', BUILTIN_MODEL_SUBDIR)
  }
  return path.join(process.resourcesPath, 'resources', BUILTIN_MODEL_SUBDIR)
}

export interface TranscriptResult {
  text: string
  segments: { start: number; end: number; text: string }[]
}

/** 实时识别会话 */
interface RealtimeSession {
  recognizer: any
  stream: any
  segments: { start: number; end: number; text: string }[]
  fullText: string
  totalSamples: number
  sampleRate: number
  segmentStartSample: number
}

/** 流式模型在 reset 后 / 会话刚创建时，需要约 1s 的帧上下文才能开始输出 token。
 *  若直接喂入真实语音，首块（新句子开头）会被当作 warm-up 吞掉，导致首 token 丢失。
 *  因此每次 reset 后和会话开始时都回喂一段固定静音，让模型先建立上下文。 */
const WARMUP_SILENCE_SECONDS = 1.0
const WARMUP_SILENCE_SAMPLES = Math.round(WARMUP_SILENCE_SECONDS * 16000)

/** 安全阀：限制 decode 迭代次数，防止 native 模块异常导致无限循环卡死主线程 */
const MAX_DECODE_ITERATIONS = 100000

// sherpa-onnx-node is loaded dynamically to avoid blocking startup when not used
let sherpaOnnx: any = null
let recognizer: any = null
let recognizerIsStreaming: boolean = false
let currentConfigKey: string = ''

/** 在模型目录中查找匹配的文件（支持多候选文件名） */
function findModelFile(modelDir: string, candidates: string[]): string | null {
  for (const name of candidates) {
    const full = path.join(modelDir, name)
    if (fs.existsSync(full)) return full
  }
  // 尝试通配符匹配（如 encoder-epoch-*.onnx）
  try {
    const files = fs.readdirSync(modelDir)
    for (const pattern of candidates) {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
        const match = files.find(f => regex.test(f))
        if (match) return path.join(modelDir, match)
      }
    }
  } catch { /* ignore */ }
  return null
}

/** 获取各模型类型所需的文件（返回找到的路径和缺失的文件名） */
interface ModelFilesResult {
  found: boolean
  files: Record<string, string>
  missing: string[]
  isStreaming?: boolean
}

function resolveModelFiles(modelType: VoiceLocalModelType, modelDir: string): ModelFilesResult {
  const result: ModelFilesResult = { found: false, files: {}, missing: [] }
  const tokensFile = path.join(modelDir, 'tokens.txt')
  if (!fs.existsSync(tokensFile)) {
    result.missing.push('tokens.txt')
  } else {
    result.files.tokens = tokensFile
  }

  if (modelType === 'whisper') {
    const encoder = findModelFile(modelDir, ['whisper-encoder.onnx', 'encoder.onnx'])
    const decoder = findModelFile(modelDir, ['whisper-decoder.onnx', 'decoder.onnx'])
    if (encoder) result.files.encoder = encoder
    else result.missing.push('whisper-encoder.onnx')
    if (decoder) result.files.decoder = decoder
    else result.missing.push('whisper-decoder.onnx')
  } else if (modelType === 'paraformer') {
    const model = findModelFile(modelDir, ['model.int8.onnx', 'model.onnx'])
    if (model) result.files.model = model
    else result.missing.push('model.int8.onnx')
  } else if (modelType === 'zipformer') {
    // 流式 zipformer 通常使用 encoder.onnx / decoder.onnx / joiner.onnx
    // 离线 zipformer 通常使用 encoder-epoch-99-avg-1.onnx 等
    const encoder = findModelFile(modelDir, [
      'encoder.onnx',
      'encoder-epoch-*.onnx',
      'encoder-epoch-*-avg-*.onnx',
    ])
    const decoder = findModelFile(modelDir, [
      'decoder.onnx',
      'decoder-epoch-*.onnx',
      'decoder-epoch-*-avg-*.onnx',
    ])
    const joiner = findModelFile(modelDir, [
      'joiner.onnx',
      'joiner-epoch-*.onnx',
      'joiner-epoch-*-avg-*.onnx',
    ])
    if (encoder) result.files.encoder = encoder
    else result.missing.push('encoder.onnx')
    if (decoder) result.files.decoder = decoder
    else result.missing.push('decoder.onnx')
    if (joiner) result.files.joiner = joiner
    else result.missing.push('joiner.onnx')
    // 简短文件名（encoder.onnx）→ 流式；带 epoch 后缀 → 离线
    result.isStreaming = !path.basename(encoder || '').includes('epoch')
  }

  result.found = result.missing.length === 0
  return result
}

/**
 * 本地语音识别服务，基于 sherpa-onnx 实现进程内识别
 * 支持 Whisper / Paraformer / Zipformer（流式和离线）模型
 */
class LocalSTTService {
  private static instance: LocalSTTService

  private constructor() {}

  static getInstance(): LocalSTTService {
    if (!LocalSTTService.instance) {
      LocalSTTService.instance = new LocalSTTService()
    }
    return LocalSTTService.instance
  }

  private loadSherpaOnnx(): any {
    if (sherpaOnnx) return sherpaOnnx

    // 方式 1：直接 require（dev 模式下可用）
    try {
      sherpaOnnx = require('sherpa-onnx-node')
      if (sherpaOnnx && sherpaOnnx.version) {
        logger.info('sherpa-onnx-node loaded via require, version:', sherpaOnnx.version)
        return sherpaOnnx
      }
    } catch (err: any) {
      logger.warn('require("sherpa-onnx-node") failed, trying manual path resolution:', err?.message || err)
    }

    // 方式 2：打包模式下 asar 内的 addon.js 无法正确解析 .node 路径，
    // 手动定位 app.asar.unpacked 中的原生模块
    try {
      const os = require('os')
      const platform = os.platform() === 'win32' ? 'win' : os.platform()
      const arch = os.arch()
      const platformArch = `${platform}-${arch}`

      // 候选路径列表（覆盖 dev 和打包场景）
      const appPath = app.getAppPath()
      const candidates: string[] = []

      if (app.isPackaged) {
        // 打包模式：.node 文件被 asarUnpack 解包到 app.asar.unpacked
        // appPath 形如 ".../resources/app.asar"，替换为 app.asar.unpacked
        const unpackedRoot = appPath.replace('app.asar', 'app.asar.unpacked')
        candidates.push(
          path.join(unpackedRoot, 'node_modules', `sherpa-onnx-${platformArch}`, 'sherpa-onnx.node'),
          path.join(unpackedRoot, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.node'),
        )
        // process.resourcesPath 下的 node_modules（某些打包配置）
        candidates.push(
          path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', `sherpa-onnx-${platformArch}`, 'sherpa-onnx.node'),
        )
      }

      // 通用候选路径
      candidates.push(
        path.join(appPath, 'node_modules', `sherpa-onnx-${platformArch}`, 'sherpa-onnx.node'),
        path.join(appPath, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.node'),
      )

      let loadedAddon: any = null
      let usedPath = ''
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          try {
            loadedAddon = require(p)
            usedPath = p
            break
          } catch (err: any) {
            logger.warn(`require("${p}") failed:`, err?.message || err)
          }
        }
      }

      if (loadedAddon) {
        // 加载 sherpa-onnx-node 的 JS 包装层（它需要 ./addon.js 导出的对象）
        // 直接构造一个精简的 sherpaOnnx 对象，包含识别所需的类
        const sherpaOnnxNodeDir = path.join(appPath, 'node_modules', 'sherpa-onnx-node')
        if (fs.existsSync(sherpaOnnxNodeDir)) {
          // 临时修改 require 缓存，让 addon.js 模块返回我们加载的 addon
          const addonPath = path.join(sherpaOnnxNodeDir, 'addon.js')
          if (require.cache[addonPath]) {
            delete require.cache[addonPath]
          }
          // 注入 addon 模块缓存
          require.cache[addonPath] = {
            id: addonPath,
            filename: addonPath,
            loaded: true,
            exports: loadedAddon,
          } as any
          // 现在 require('sherpa-onnx-node') 应该能正确加载
          sherpaOnnx = require('sherpa-onnx-node')
          if (sherpaOnnx && sherpaOnnx.version) {
            logger.info(`sherpa-onnx-node loaded via manual path: ${usedPath}, version: ${sherpaOnnx.version}`)
            return sherpaOnnx
          }
        }
        // 如果 JS 包装层不可用，直接使用原生 addon
        sherpaOnnx = loadedAddon
        logger.info(`sherpa-onnx native addon loaded directly from: ${usedPath}, version: ${sherpaOnnx.version}`)
        return sherpaOnnx
      }

      throw new Error(`sherpa-onnx native module not found in any candidate paths. Tried:\n${candidates.join('\n')}`)
    } catch (err: any) {
      logger.error('Failed to load sherpa-onnx-node:', err?.message || err)
      throw new Error(`Failed to load sherpa-onnx-node: ${err?.message || err}`)
    }
  }

  /**
   * 检查模型是否可用
   */
  checkModel(config: VoiceSTTLocalConfig): VoiceLocalModelStatus {
    if (!config.modelDir) {
      return { available: false, error: 'Model directory not configured' }
    }
    if (!fs.existsSync(config.modelDir)) {
      return { available: false, modelDir: config.modelDir, error: `Model directory does not exist: ${config.modelDir}` }
    }

    const resolved = resolveModelFiles(config.modelType, config.modelDir)
    if (!resolved.found) {
      return {
        available: false,
        modelType: config.modelType,
        modelDir: config.modelDir,
        error: `Required model file not found: ${resolved.missing[0]}`,
      }
    }

    return {
      available: true,
      modelType: config.modelType,
      modelDir: config.modelDir,
    }
  }

  /** 检查内置流式 Zipformer 模型是否可用 */
  checkBuiltinModel(): VoiceLocalModelStatus {
    const modelDir = getBuiltinModelDir()
    if (!fs.existsSync(modelDir)) {
      return { available: false, modelDir, error: `内置模型目录不存在: ${modelDir}` }
    }
    const resolved = resolveModelFiles('zipformer', modelDir)
    if (!resolved.found) {
      return { available: false, modelType: 'zipformer', modelDir, error: `缺少模型文件: ${resolved.missing[0]}` }
    }
    return { available: true, modelType: 'zipformer', modelDir }
  }

  /**
   * 获取或创建识别器（单例，配置变化时重建）
   * 固定使用内置流式 Zipformer 模型
   * 返回 { recognizer, isStreaming }
   */
  private getRecognizer(config: VoiceSTTLocalConfig): { recognizer: any; isStreaming: boolean } {
    const modelDir = getBuiltinModelDir()
    const resolved = resolveModelFiles('zipformer', modelDir)
    const isStreaming = resolved.isStreaming ?? true
    const configKey = `zipformer:${modelDir}:${config.language}`

    if (recognizer && currentConfigKey === configKey) {
      return { recognizer, isStreaming: recognizerIsStreaming }
    }

    // 释放旧的识别器（native addon 依赖 GC，置 null 即可）
    recognizer = null

    if (!resolved.found) {
      throw new Error(`内置模型文件缺失: ${resolved.missing.join(', ')}`)
    }

    const lib = this.loadSherpaOnnx()

    // 构建模型配置 - 固定使用 zipformer transducer，CPU 推理
    const modelConfig: any = {
      tokens: resolved.files.tokens,
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
      transducer: {
        encoder: resolved.files.encoder,
        decoder: resolved.files.decoder,
        joiner: resolved.files.joiner,
      },
    }

    // 构建识别器配置
    const recognizerConfig: any = {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig,
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
    }

    if (isStreaming) {
      // 流式识别器需要 endpoint 检测参数
      recognizerConfig.enableEndpoint = 1
      recognizerConfig.rule1MinTrailingSilence = 2.4
      recognizerConfig.rule2MinTrailingSilence = 1.2
      recognizerConfig.rule3MinUtteranceLength = 20
      recognizer = new lib.OnlineRecognizer(recognizerConfig)
      logger.info(`Online recognizer created (内置流式 Zipformer, provider=cpu): ${modelDir}`)
    } else {
      recognizer = new lib.OfflineRecognizer(recognizerConfig)
      logger.info(`Offline recognizer created (内置 Zipformer, provider=cpu): ${modelDir}`)
    }

    currentConfigKey = configKey
    recognizerIsStreaming = isStreaming
    return { recognizer, isStreaming }
  }

  /**
   * 读取 WAV 文件并提取 PCM 采样数据
   * 支持 16-bit PCM WAV 格式
   */
  private readWavFile(filePath: string): { samples: Float32Array; sampleRate: number } {
    // 优先使用 sherpa-onnx 的 readWave
    try {
      const lib = this.loadSherpaOnnx()
      if (lib.readWave) {
        const wave = lib.readWave(filePath)
        if (wave && wave.samples) {
          return { samples: wave.samples, sampleRate: wave.sampleRate }
        }
      }
    } catch (err: any) {
      logger.warn('sherpa-onnx readWave failed, falling back to custom parser:', err?.message || err)
    }

    // 回退到自定义 WAV 解析
    // 文件大小保护：超过 500MB 的 WAV 文件拒绝处理，避免内存爆炸
    // （1 小时 16kHz 16-bit mono ≈ 115MB，500MB ≈ 4.3 小时，足够覆盖正常场景）
    const stat = fs.statSync(filePath)
    if (stat.size > 500 * 1024 * 1024) {
      throw new Error(`WAV file too large (${Math.round(stat.size / 1024 / 1024)}MB), max 500MB`)
    }
    const buffer = fs.readFileSync(filePath)

    if (buffer.length < 44) {
      throw new Error('Invalid WAV file: too short')
    }

    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Invalid WAV file: not a RIFF/WAVE format')
    }

    let offset = 12
    let audioFormat = 1
    let numChannels = 1
    let sampleRate = 16000
    let bitsPerSample = 16
    let dataOffset = 0
    let dataSize = 0

    while (offset < buffer.length - 8) {
      const chunkId = buffer.toString('ascii', offset, offset + 4)
      const chunkSize = buffer.readUInt32LE(offset + 4)
      if (chunkId === 'fmt ') {
        audioFormat = buffer.readUInt16LE(offset + 8)
        numChannels = buffer.readUInt16LE(offset + 10)
        sampleRate = buffer.readUInt32LE(offset + 12)
        bitsPerSample = buffer.readUInt16LE(offset + 22)
      } else if (chunkId === 'data') {
        dataOffset = offset + 8
        dataSize = chunkSize
        break
      }
      offset += 8 + chunkSize
    }

    if (audioFormat !== 1) {
      throw new Error(`Unsupported WAV format: only PCM (format 1) is supported, got ${audioFormat}`)
    }
    if (bitsPerSample !== 16) {
      throw new Error(`Unsupported bit depth: only 16-bit is supported, got ${bitsPerSample}`)
    }

    const numSamples = Math.floor(dataSize / 2)
    const samples = new Float32Array(numSamples)
    for (let i = 0; i < numSamples; i++) {
      const int16 = buffer.readInt16LE(dataOffset + i * 2)
      samples[i] = int16 / 32768.0
    }

    // 立体声转单声道
    if (numChannels > 1) {
      const monoSamples = new Float32Array(Math.floor(numSamples / numChannels))
      for (let i = 0; i < monoSamples.length; i++) {
        let sum = 0
        for (let c = 0; c < numChannels; c++) {
          sum += samples[i * numChannels + c]
        }
        monoSamples[i] = sum / numChannels
      }
      return { samples: monoSamples, sampleRate }
    }

    return { samples, sampleRate }
  }

  /** 使用离线识别器进行转录 */
  private transcribeOffline(
    rec: any,
    samples: Float32Array,
    sampleRate: number,
    onProgress?: (progress: number, message: string) => void,
    signal?: AbortSignal,
  ): { text: string; segments: { start: number; end: number; text: string }[] } {
    const maxSegmentSamples = 30 * sampleRate
    const segments: { start: number; end: number; text: string }[] = []
    let fullText = ''

    const totalSegments = Math.ceil(samples.length / maxSegmentSamples)
    let processedSegments = 0

    for (let start = 0; start < samples.length; start += maxSegmentSamples) {
      if (signal?.aborted) throw new Error('Aborted')

      const end = Math.min(start + maxSegmentSamples, samples.length)
      const segmentSamples = samples.subarray(start, end)

      const stream = rec.createStream()
      stream.acceptWaveform({ samples: segmentSamples, sampleRate })
      rec.decode(stream)
      const result = rec.getResult(stream)
      const text = (result?.text || '').trim()

      if (text) {
        const startTime = start / sampleRate
        const endTime = end / sampleRate
        segments.push({ start: startTime, end: endTime, text })
        fullText += text
      }

      processedSegments++
      const progress = 20 + Math.floor((processedSegments / totalSegments) * 70)
      onProgress?.(progress, `Recognizing segment ${processedSegments}/${totalSegments}...`)
    }

    return { text: fullText, segments }
  }

  /** 使用流式识别器进行转录 */
  private transcribeOnline(
    rec: any,
    samples: Float32Array,
    sampleRate: number,
    onProgress?: (progress: number, message: string) => void,
    signal?: AbortSignal,
  ): { text: string; segments: { start: number; end: number; text: string }[] } {
    // 流式识别器以较小块处理音频，使用 endpoint 检测分段
    const chunkSamples = Math.min(30 * sampleRate, samples.length)
    const segments: { start: number; end: number; text: string }[] = []
    let fullText = ''

    const totalChunks = Math.ceil(samples.length / chunkSamples)
    let processedChunks = 0

    for (let start = 0; start < samples.length; start += chunkSamples) {
      if (signal?.aborted) throw new Error('Aborted')

      const end = Math.min(start + chunkSamples, samples.length)
      const chunkSamplesData = samples.subarray(start, end)

      const stream = rec.createStream()
      stream.acceptWaveform({ samples: chunkSamplesData, sampleRate })
      stream.inputFinished()

      // 持续解码直到识别器不再需要处理
      while (rec.isReady(stream)) {
        if (signal?.aborted) {
          throw new Error('Aborted')
        }
        rec.decode(stream)
      }

      const result = rec.getResult(stream)
      const text = (result?.text || '').trim()

      if (text) {
        const startTime = start / sampleRate
        const endTime = end / sampleRate
        segments.push({ start: startTime, end: endTime, text })
        fullText += text
      }

      processedChunks++
      const progress = 20 + Math.floor((processedChunks / totalChunks) * 70)
      onProgress?.(progress, `Recognizing segment ${processedChunks}/${totalChunks}...`)
    }

    return { text: fullText, segments }
  }

  /**
   * 对音频文件进行语音识别
   */
  async transcribe(
    audioPath: string,
    config: VoiceSTTLocalConfig,
    onProgress?: (progress: number, message: string) => void,
    signal?: AbortSignal,
  ): Promise<TranscriptResult> {
    const { recognizer: rec, isStreaming } = this.getRecognizer(config)
    onProgress?.(10, 'Loading audio file...')

    const { samples, sampleRate } = this.readWavFile(audioPath)
    onProgress?.(20, 'Processing audio...')

    if (signal?.aborted) throw new Error('Aborted')

    const result = isStreaming
      ? this.transcribeOnline(rec, samples, sampleRate, onProgress, signal)
      : this.transcribeOffline(rec, samples, sampleRate, onProgress, signal)

    onProgress?.(95, 'Finalizing transcript...')

    return {
      text: result.text,
      segments: result.segments,
    }
  }

  // ==================== 实时识别（边录音边识别） ====================

  private realtimeSessions: Map<string, RealtimeSession> = new Map()

  /**
   * 开始实时识别会话
   * 仅支持流式模型（zipformer streaming），离线模型不支持实时识别
   */
  startRealtimeRecognize(taskId: string, config: VoiceSTTLocalConfig): { ok: boolean; error?: string } {
    // 清理旧会话
    this.cancelRealtimeRecognize(taskId)

    try {
      const { recognizer: rec, isStreaming } = this.getRecognizer(config)
      if (!isStreaming) {
        return { ok: false, error: '实时识别仅支持流式模型（streaming zipformer），请切换模型或使用录音后识别' }
      }

      const stream = rec.createStream()
      const session: RealtimeSession = {
        recognizer: rec,
        stream,
        segments: [],
        fullText: '',
        totalSamples: 0,
        sampleRate: 16000,
        segmentStartSample: 0,
      }
      this.realtimeSessions.set(taskId, session)
      // 会话刚创建时模型无上下文，先喂一段固定静音预热，避免首句首 token 被吞掉
      this.warmUpStream(rec, stream, session.sampleRate)
      logger.info(`Realtime recognition started: taskId=${taskId}`)
      return { ok: true }
    } catch (err: any) {
      logger.error('Failed to start realtime recognition:', err?.message || err)
      return { ok: false, error: String(err?.message || err) }
    }
  }

  /**
   * 向流式模型回喂一段固定静音作为预热，让模型在接收真实语音前先建立帧上下文。
   * 用于会话开始和每次 endpoint reset 后，避免模型吞掉新句子首 token。
   */
  private warmUpStream(rec: any, stream: any, sampleRate: number): void {
    const silence = new Float32Array(WARMUP_SILENCE_SAMPLES)
    stream.acceptWaveform({ samples: silence, sampleRate })
    let iters = 0
    while (rec.isReady(stream)) {
      rec.decode(stream)
      if (++iters > MAX_DECODE_ITERATIONS) {
        logger.warn(`warmUpStream: decode exceeded ${MAX_DECODE_ITERATIONS} iterations, breaking`)
        break
      }
    }
    // 预热识别结果为空，仅用于构建上下文
    rec.getResult(stream)
  }

  /**
   * 喂入音频块并返回当前识别结果
   * 返回 { text, partialText, segment, isEndpoint }
   * - text: 累积全文
   * - partialText: 当前正在识别的语句（endpoint 后重置）
   * - segment: 新完成的段落（endpoint 触发时非空）
   */
  feedAudioChunk(
    taskId: string,
    samples: Float32Array,
    sampleRate: number,
  ): { text: string; partialText: string; segment?: { start: number; end: number; text: string }; isEndpoint: boolean } {
    const session = this.realtimeSessions.get(taskId)
    if (!session) {
      return { text: '', partialText: '', isEndpoint: false }
    }

    const { recognizer: rec, stream } = session

    stream.acceptWaveform({ samples, sampleRate })
    session.totalSamples += samples.length

    // 持续解码
    // 安全阀：限制 decode 迭代次数，防止 native 模块异常导致无限循环卡死主线程
    let decodeIterations = 0
    while (rec.isReady(stream)) {
      rec.decode(stream)
      if (++decodeIterations > MAX_DECODE_ITERATIONS) {
        logger.warn(`feedAudioChunk: decode loop exceeded ${MAX_DECODE_ITERATIONS} iterations, breaking`)
        break
      }
    }

    const result = rec.getResult(stream)
    const currentText = (result?.text || '').trim()

    // 检测 endpoint
    const isEndpoint = rec.isEndpoint(stream)
    let segment: { start: number; end: number; text: string } | undefined

    if (isEndpoint) {
      if (currentText) {
        const startTime = session.segmentStartSample / session.sampleRate
        const endTime = session.totalSamples / session.sampleRate
        segment = { start: startTime, end: endTime, text: currentText }
        session.segments.push(segment)
        session.fullText += currentText
      }
      // reset 后 stream 开始接收新段落
      rec.reset(stream)
      // reset 后回喂一段固定静音预热，让模型在接收新句子语音前先建立帧上下文，
      // 避免流式模型把新句子开头当作 warm-up 吞掉（首 token 丢失）。
      this.warmUpStream(rec, stream, session.sampleRate)
      session.segmentStartSample = session.totalSamples
    }

    return {
      text: session.fullText + currentText,
      partialText: currentText,
      segment,
      isEndpoint,
    }
  }

  /**
   * 停止实时识别，返回完整结果
   */
  stopRealtimeRecognize(taskId: string): TranscriptResult {
    const session = this.realtimeSessions.get(taskId)
    if (!session) {
      return { text: '', segments: [] }
    }

    const { recognizer: rec, stream } = session

    try {
      // 通知流结束，获取最终结果
      stream.inputFinished()
      // 安全阀：限制 decode 迭代次数，防止 native 模块异常导致无限循环卡死主线程
      // 正常情况下 inputFinished() 后 isReady 会很快返回 false
      let decodeIterations = 0
      while (rec.isReady(stream)) {
        rec.decode(stream)
        if (++decodeIterations > MAX_DECODE_ITERATIONS) {
          logger.warn(`stopRealtimeRecognize: decode loop exceeded ${MAX_DECODE_ITERATIONS} iterations, breaking`)
          break
        }
      }
      const result = rec.getResult(stream)
      const finalText = (result?.text || '').trim()

      if (finalText) {
        const startTime = session.segmentStartSample / session.sampleRate
        const endTime = session.totalSamples / session.sampleRate
        session.segments.push({ start: startTime, end: endTime, text: finalText })
        session.fullText += finalText
      }
    } catch (err: any) {
      logger.error('Error during realtime finalize:', err?.message || err)
    }

    const transcript: TranscriptResult = {
      text: session.fullText,
      segments: session.segments,
    }

    // 清理会话（native addon 依赖 GC，无需手动 free）
    this.realtimeSessions.delete(taskId)
    logger.info(`Realtime recognition stopped: taskId=${taskId}, text length=${transcript.text.length}`)

    return transcript
  }

  /**
   * 取消实时识别（不返回结果）
   */
  cancelRealtimeRecognize(taskId: string): void {
    const session = this.realtimeSessions.get(taskId)
    if (session) {
      // native addon 依赖 GC，无需手动 free
      this.realtimeSessions.delete(taskId)
      logger.info(`Realtime recognition cancelled: taskId=${taskId}`)
    }
  }

  /**
   * 释放识别器资源
   */
  dispose(): void {
    // 清理所有实时识别会话
    for (const taskId of this.realtimeSessions.keys()) {
      this.cancelRealtimeRecognize(taskId)
    }
    if (recognizer) {
      // native addon 依赖 GC，无需手动 free
      recognizer = null
      currentConfigKey = ''
    }
  }
}

export default LocalSTTService
