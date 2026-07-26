/**
 * 录音会话单例：跨组件生命周期持久的录音状态。
 *
 * 当用户从语音页面切换到其他模块时，KMSVoiceView 组件卸载，
 * 但 MediaRecorder / AudioContext / 实时识别 feed 等需要继续运行。
 * 此对象在模块级别保存所有录音相关的引用，组件重新挂载时从中恢复。
 */
export interface RecordingSession {
  // MediaRecorder 实例
  mediaRecorder: MediaRecorder | null
  mediaRecorderMic: MediaRecorder | null
  mediaRecorderSystem: MediaRecorder | null

  // 音频数据缓存
  audioChunks: Blob[]
  audioChunksMic: Blob[]
  audioChunksSystem: Blob[]

  // 音频上下文与分析
  audioContext: AudioContext | null
  analyser: AnalyserNode | null

  // 音频流
  micStream: MediaStream | null
  systemStream: MediaStream | null
  combinedStream: MediaStream | null

  // ScriptProcessor（实时识别音频采集）
  scriptProcessorMic: ScriptProcessorNode | null
  scriptProcessorSystem: ScriptProcessorNode | null
  realtimeSourceMic: MediaStreamAudioSourceNode | null
  realtimeSourceSystem: MediaStreamAudioSourceNode | null

  // 实时识别任务
  realtimeTaskId: string | null
  realtimeTaskIdMic: string | null
  realtimeTaskIdSystem: string | null
  realtimeActive: boolean

  // 实时音频缓冲
  realtimeBufferMic: Float32Array[]
  realtimeBufferSystem: Float32Array[]

  // Feed 定时器（向主进程发送音频数据）
  feedTimerMic: ReturnType<typeof setInterval> | null
  feedTimerSystem: ReturnType<typeof setInterval> | null

  // 时长计时器与音量动画
  durationTimer: ReturnType<typeof setInterval> | null
  animationFrame: number | null

  // 录音时间状态
  recordStartTime: number
  pausedDuration: number
  pauseStartTime: number

  // 录音元数据
  recordingTaskId: string | null
  recordSource: 'mic' | 'system' | 'both' | null
  isPaused: boolean
  micPaused: boolean
  systemPaused: boolean

  // 双源停止计数
  dualRecorderStopCount: number
}

function createEmptySession(): RecordingSession {
  return {
    mediaRecorder: null,
    mediaRecorderMic: null,
    mediaRecorderSystem: null,
    audioChunks: [],
    audioChunksMic: [],
    audioChunksSystem: [],
    audioContext: null,
    analyser: null,
    micStream: null,
    systemStream: null,
    combinedStream: null,
    scriptProcessorMic: null,
    scriptProcessorSystem: null,
    realtimeSourceMic: null,
    realtimeSourceSystem: null,
    realtimeTaskId: null,
    realtimeTaskIdMic: null,
    realtimeTaskIdSystem: null,
    realtimeActive: false,
    realtimeBufferMic: [],
    realtimeBufferSystem: [],
    feedTimerMic: null,
    feedTimerSystem: null,
    durationTimer: null,
    animationFrame: null,
    recordStartTime: 0,
    pausedDuration: 0,
    pauseStartTime: 0,
    recordingTaskId: null,
    recordSource: null,
    isPaused: false,
    micPaused: false,
    systemPaused: false,
    dualRecorderStopCount: 0,
  }
}

/** 全局录音会话单例 */
export const recordingSession: RecordingSession = createEmptySession()

/** 判断是否有活跃的录音 */
export function isRecordingActive(): boolean {
  return recordingSession.mediaRecorder !== null
    || recordingSession.mediaRecorderMic !== null
    || recordingSession.mediaRecorderSystem !== null
}

/** 重置会话到初始状态 */
export function clearRecordingSession(): void {
  Object.assign(recordingSession, createEmptySession())
}
