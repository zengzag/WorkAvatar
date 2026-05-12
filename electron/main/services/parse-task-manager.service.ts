import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import DatabaseService from './database.service'
import TaskQueueService, { type BackgroundTask } from './task-queue.service'

export interface ParseProgress {
  docId: string
  stage: 'reading' | 'parsing' | 'chunking' | 'saving' | 'done'
  stageLabel: string
  progress: number
  processedPages: number
  totalPages: number
  processedChunks: number
  totalChunks: number
  speed: number
  eta: number
  detail: string
}

export interface ActiveParseTask {
  docId: string
  kbId: string
  taskId: string
  abortController: AbortController
  startTime: number
  pausedTime: number
  lastProgressTime: number
  progress: ParseProgress
  lastReportedProgress: number
  lastReportedTime: number
}

class ParseTaskManager {
  private activeTasks: Map<string, ActiveParseTask> = new Map()
  private db: DatabaseService
  private taskQueue: TaskQueueService
  private static instance: ParseTaskManager

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.taskQueue = TaskQueueService.getInstance()
  }

  static getInstance(): ParseTaskManager {
    if (!ParseTaskManager.instance) {
      ParseTaskManager.instance = new ParseTaskManager()
    }
    return ParseTaskManager.instance
  }

  createTask(docId: string, kbId: string, docName: string): string {
    const taskId = `parse-${docId}`
    const abortController = new AbortController()

    const task: ActiveParseTask = {
      docId,
      kbId,
      taskId,
      abortController,
      startTime: Date.now(),
      pausedTime: 0,
      lastProgressTime: Date.now(),
      progress: {
        docId,
        stage: 'reading',
        stageLabel: 'Reading',
        progress: 0,
        processedPages: 0,
        totalPages: 0,
        processedChunks: 0,
        totalChunks: 0,
        speed: 0,
        eta: 0,
        detail: '',
      },
      lastReportedProgress: 0,
      lastReportedTime: Date.now(),
    }

    this.activeTasks.set(docId, task)
    this.taskQueue.setAbortController(taskId, abortController)

    const bgTask: BackgroundTask = {
      id: taskId,
      type: 'parse',
      title: docName,
      status: 'running',
      progress: 0,
      progressText: 'Starting parse...',
      createdAt: Date.now(),
      metadata: { docId, kbId, docName },
    }
    this.taskQueue.addTask(bgTask)

    this.updateDocParseStatus(docId, 'parsing', 0, 'reading', 'Reading')

    return taskId
  }

  updateProgress(docId: string, progress: Partial<ParseProgress>) {
    const task = this.activeTasks.get(docId)
    if (!task) return

    const now = Date.now()
    const updatedProgress = { ...task.progress, ...progress }

    const progressDelta = updatedProgress.progress - task.lastReportedProgress
    const timeDelta = (now - task.lastReportedTime) / 1000

    if (progressDelta > 0 && timeDelta > 0.5) {
      const recentSpeed = progressDelta / timeDelta
      if (task.lastReportedProgress === 0) {
        updatedProgress.speed = recentSpeed
      } else {
        updatedProgress.speed = updatedProgress.speed * 0.3 + recentSpeed * 0.7
      }
      const remaining = (100 - updatedProgress.progress) / updatedProgress.speed
      updatedProgress.eta = Math.max(0, Math.round(remaining))

      task.lastReportedProgress = updatedProgress.progress
      task.lastReportedTime = now
    }

    task.progress = updatedProgress
    task.lastProgressTime = now

    this.taskQueue.updateTask(task.taskId, {
      progress: Math.round(updatedProgress.progress),
      progressText: `${updatedProgress.stageLabel}: ${updatedProgress.detail}`,
      stage: updatedProgress.stage,
      detail: updatedProgress.detail,
      speed: updatedProgress.speed,
      eta: updatedProgress.eta,
    })

    this.updateDocParseProgress(docId, updatedProgress)
    this.sendProgressToRenderer(docId, updatedProgress)
  }

  async checkPaused(docId: string): Promise<boolean> {
    const task = this.activeTasks.get(docId)
    if (!task) return false

    if (this.taskQueue.isTaskPaused(task.taskId)) {
      this.saveParseState(docId)
      
      while (this.taskQueue.isTaskPaused(task.taskId)) {
        await new Promise(resolve => setTimeout(resolve, 200))
        
        if (task.abortController.signal.aborted) {
          return true
        }
      }
      
      await this.restoreParseState(docId)
      return false
    }

    if (task.abortController.signal.aborted) {
      return true
    }

    return false
  }

  isAborted(docId: string): boolean {
    const task = this.activeTasks.get(docId)
    if (!task) return true
    return task.abortController.signal.aborted
  }

  hasActiveTask(docId: string): boolean {
    return this.activeTasks.has(docId)
  }

  getActiveDocIds(): string[] {
    return Array.from(this.activeTasks.keys())
  }

  resumeOrCreateTask(docId: string, kbId: string, _docName: string): string {
    const existingTask = this.activeTasks.get(docId)
    if (existingTask) {
      this.taskQueue.resumeTask(existingTask.taskId)
      existingTask.startTime = Date.now() - existingTask.pausedTime
      return existingTask.taskId
    }

    const taskId = `parse-${docId}`
    const abortController = new AbortController()

    const savedProgress = this.loadSavedProgress(docId)

    const task: ActiveParseTask = {
      docId,
      kbId,
      taskId,
      abortController,
      startTime: Date.now(),
      pausedTime: 0,
      lastProgressTime: Date.now(),
      progress: savedProgress || {
        docId,
        stage: 'reading',
        stageLabel: 'Reading',
        progress: 0,
        processedPages: 0,
        totalPages: 0,
        processedChunks: 0,
        totalChunks: 0,
        speed: 0,
        eta: 0,
        detail: '',
      },
      lastReportedProgress: savedProgress?.progress || 0,
      lastReportedTime: Date.now(),
    }

    this.activeTasks.set(docId, task)
    this.taskQueue.setAbortController(taskId, abortController)

    this.taskQueue.updateTask(taskId, {
      status: 'running',
    })

    this.updateDocParseStatus(docId, 'parsing', task.progress.progress, task.progress.stage, task.progress.stageLabel)

    return taskId
  }

  pauseTask(docId: string): boolean {
    const task = this.activeTasks.get(docId)
    if (!task) return false

    task.pausedTime += Date.now() - task.startTime
    return this.taskQueue.pauseTask(task.taskId)
  }

  resumeTask(docId: string): boolean {
    const task = this.activeTasks.get(docId)
    if (!task) return false

    const result = this.taskQueue.resumeTask(task.taskId)
    if (result) {
      task.startTime = Date.now() - task.pausedTime
    }
    return result
  }

  cancelTask(docId: string): boolean {
    const task = this.activeTasks.get(docId)
    if (!task) return false

    task.abortController.abort()
    this.taskQueue.cancelTask(task.taskId)
    this.updateDocParseStatus(docId, 'pending', 0, '', '')
    this.activeTasks.delete(docId)
    return true
  }

  completeTask(docId: string) {
    const task = this.activeTasks.get(docId)
    if (!task) return

    this.updateProgress(docId, {
      stage: 'done',
      stageLabel: 'Done',
      progress: 100,
      detail: 'Parse completed',
    })

    this.taskQueue.updateTask(task.taskId, {
      status: 'completed',
      progress: 100,
      progressText: 'Parse completed',
    })

    this.updateDocParseStatus(docId, 'completed', 100, 'done', 'Parse completed')
    this.activeTasks.delete(docId)
  }

  failTask(docId: string, error: string) {
    const task = this.activeTasks.get(docId)
    if (!task) return

    this.taskQueue.updateTask(task.taskId, {
      status: 'failed',
      error,
      progressText: `Failed: ${error}`,
    })

    this.updateDocParseStatus(docId, 'failed', task.progress.progress, task.progress.stage, error)
    this.db.getDb().prepare(
      "UPDATE kb_documents SET parse_error = ?, updated_at = unixepoch() WHERE id = ?"
    ).run(error, docId)
    this.activeTasks.delete(docId)
  }

  getProgress(docId: string): ParseProgress | null {
    const task = this.activeTasks.get(docId)
    return task ? task.progress : null
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size
  }

  pauseAllParseTasks(): number {
    let count = 0
    for (const [docId] of this.activeTasks) {
      if (this.pauseTask(docId)) count++
    }
    return count
  }

  resumeAllParseTasks(): number {
    let count = 0
    for (const [docId] of this.activeTasks) {
      if (this.resumeTask(docId)) count++
    }
    return count
  }

  cancelAllParseTasks(): number {
    let count = 0
    for (const [docId] of this.activeTasks) {
      if (this.cancelTask(docId)) count++
    }
    return count
  }

  private saveParseState(docId: string) {
    const task = this.activeTasks.get(docId)
    if (!task) return

    const state = {
      progress: task.progress,
      pausedTime: task.pausedTime,
      startTime: task.startTime,
    }
    this.db.getDb().prepare(
      "UPDATE kb_documents SET parse_state_json = ?, updated_at = unixepoch() WHERE id = ?"
    ).run(JSON.stringify(state), docId)
  }

  private loadSavedProgress(docId: string): ParseProgress | null {
    const row = this.db.getDb().prepare(
      "SELECT parse_state_json FROM kb_documents WHERE id = ?"
    ).get(docId) as any

    if (!row?.parse_state_json) return null

    try {
      const state = JSON.parse(row.parse_state_json)
      return state.progress || null
    } catch {
      return null
    }
  }

  private async restoreParseState(docId: string) {
    const row = this.db.getDb().prepare(
      "SELECT parse_state_json FROM kb_documents WHERE id = ?"
    ).get(docId) as any

    if (!row?.parse_state_json) return

    try {
      const state = JSON.parse(row.parse_state_json)
      const task = this.activeTasks.get(docId)
      if (task && state.progress) {
        task.progress = state.progress
        task.pausedTime = state.pausedTime || 0
        task.startTime = state.startTime || Date.now()
      }
    } catch {}
  }

  private updateDocParseStatus(
    docId: string,
    status: string,
    progress: number,
    stage: string,
    detail: string
  ) {
    this.db.getDb().prepare(`
      UPDATE kb_documents 
      SET parse_status = ?, parse_progress = ?, parse_stage = ?, parse_detail = ?, updated_at = unixepoch()
      WHERE id = ?
    `).run(status, progress, stage, detail, docId)
  }

  private updateDocParseProgress(docId: string, progress: ParseProgress) {
    this.db.getDb().prepare(`
      UPDATE kb_documents 
      SET parse_progress = ?, parse_stage = ?, parse_detail = ?,
          processed_pages = ?, total_pages = ?, processed_chunks = ?, total_chunks = ?,
          parse_speed = ?, parse_eta = ?, updated_at = unixepoch()
      WHERE id = ?
    `).run(
      progress.progress, progress.stage, progress.detail,
      progress.processedPages, progress.totalPages,
      progress.processedChunks, progress.totalChunks,
      progress.speed, progress.eta, docId
    )
  }

  private sendProgressToRenderer(docId: string, progress: ParseProgress) {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.KB_PARSE_PROGRESS, {
        doc_id: docId,
        stage: progress.stage,
        detail: progress.detail,
        progress: progress.progress,
        processedPages: progress.processedPages,
        totalPages: progress.totalPages,
        processedChunks: progress.processedChunks,
        totalChunks: progress.totalChunks,
        speed: progress.speed,
        eta: progress.eta,
        stageLabel: progress.stageLabel,
      })
    }
  }

  getPausedDocIds(): string[] {
    const rows = this.db.getDb().prepare(
      "SELECT id FROM kb_documents WHERE parse_status = 'paused'"
    ).all() as any[]
    return rows.map(r => r.id)
  }
}

export default ParseTaskManager
