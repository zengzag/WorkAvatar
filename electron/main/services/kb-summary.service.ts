import DatabaseService from './database.service'
import KnowledgeProcessorService from './knowledge-processor.service'
import TaskQueueService from './task-queue.service'
import { getDefaultProviderId } from './common-utils'
import type Database from 'better-sqlite3'
import type { DBKBDocumentSummary, DBKBGlobalSummary, DBKBProcessingJob } from '../../shared/db-types'

export interface KBSummaryServiceDeps {
  db: Database.Database
  mainDb: DatabaseService
  processor: KnowledgeProcessorService
  taskQueue: TaskQueueService
}

class KBSummaryService {
  private db: Database.Database
  private mainDb: DatabaseService
  private processor: KnowledgeProcessorService
  private taskQueue: TaskQueueService

  constructor(deps: KBSummaryServiceDeps) {
    this.db = deps.db
    this.mainDb = deps.mainDb
    this.processor = deps.processor
    this.taskQueue = deps.taskQueue
  }

  getKnowledgeStats(kbId: string): {
    paragraphCount: number
    documentSummaryCount: number
    hasGlobalSummary: boolean
  } {
    return this.processor.getKnowledgeStats(kbId)
  }

  getDocumentSummary(documentId: string): DBKBDocumentSummary | null {
    return this.processor.getDocumentSummary(documentId) as DBKBDocumentSummary | null
  }

  getGlobalSummary(kbId: string): DBKBGlobalSummary | null {
    return this.processor.getGlobalSummary(kbId) as DBKBGlobalSummary | null
  }

  getProcessingJobs(kbId: string, status?: string): DBKBProcessingJob[] {
    return this.processor.getProcessingJobs(kbId, status) as DBKBProcessingJob[]
  }

  async buildGlobalKnowledge(
    kbId: string,
    kbName: string,
    providerId?: string,
    modelId?: string,
    enableThinking?: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    const provider = providerId || getDefaultProviderId(this.mainDb)
    if (!provider) {
      return { success: false, error: '未配置 LLM 提供商' }
    }

    const taskId = `build-global-${kbId}`
    const abortController = new AbortController()

    const existingTask = this.taskQueue.getTask(taskId)
    const existingController = this.taskQueue.getPauseController(taskId)
    if (existingController?.abortController && !existingController.abortController.signal.aborted) {
      return { success: false, error: 'Already running' }
    }
    if (!existingTask || existingTask.status === 'completed' || existingTask.status === 'failed' || existingTask.status === 'cancelled') {
      this.taskQueue.addTask({
        id: taskId,
        type: 'process',
        title: `Global Knowledge Build: ${kbName}`,
        status: 'running',
        progress: 0,
        progressText: 'Starting global knowledge build...',
        createdAt: Date.now(),
        metadata: { kbId, kbName, providerId: provider, modelId, enableThinking },
      })
    } else {
      this.taskQueue.updateTask(taskId, { status: 'running' })
    }

    this.taskQueue.setAbortController(taskId, abortController)

    const checkPaused = async (): Promise<boolean> => {
      if (this.taskQueue.isTaskPaused(taskId)) {
        this.taskQueue.updateTask(taskId, { status: 'paused' })
        while (this.taskQueue.isTaskPaused(taskId)) {
          await new Promise(resolve => setTimeout(resolve, 200))
          if (abortController.signal.aborted) return true
        }
        this.taskQueue.updateTask(taskId, { status: 'running' })
      }
      return abortController.signal.aborted
    }

    try {
      this.taskQueue.updateTask(taskId, { progress: 20, progressText: 'Generating global summary...' })

      if (await checkPaused()) {
        this.taskQueue.updateTask(taskId, { status: 'cancelled', progressText: 'Cancelled' })
        return { success: false, error: 'Cancelled' }
      }

      const docSummaries = this.db.prepare(
        'SELECT ds.*, d.original_name as title FROM kb_document_summaries ds JOIN kb_documents d ON ds.document_id = d.id WHERE ds.kb_id = ?'
      ).all(kbId) as (DBKBDocumentSummary & { title: string })[]

      if (docSummaries.length === 0) {
        this.taskQueue.updateTask(taskId, { status: 'failed', error: 'No processed document summaries', progressText: 'Failed: No processed document summaries' })
        return { success: false, error: 'No processed document summaries, please process documents first' }
      }

      this.taskQueue.updateTask(taskId, { progress: 50, progressText: `Aggregating ${docSummaries.length} doc summaries...` })

      if (await checkPaused()) {
        this.taskQueue.updateTask(taskId, { status: 'cancelled', progressText: 'Cancelled' })
        return { success: false, error: 'Cancelled' }
      }

      const summaryInputs = docSummaries.map(ds => {
        let mainTopics: any[] = []
        try { mainTopics = JSON.parse(ds.main_topics_json || '[]') } catch { mainTopics = [] }
        return {
          title: ds.title,
          summary: ds.summary,
          mainTopics,
        }
      })

      this.taskQueue.updateTask(taskId, { progress: 70, progressText: 'Calling LLM to generate global summary...' })

      const globalSummary = await this.processor.generateGlobalSummary(
        summaryInputs, kbName, provider, modelId, enableThinking, undefined, abortController.signal
      )

      if (await checkPaused()) {
        this.taskQueue.updateTask(taskId, { status: 'cancelled', progressText: 'Cancelled' })
        return { success: false, error: 'Cancelled' }
      }

      this.processor.saveGlobalSummary(kbId, globalSummary)

      this.taskQueue.updateTask(taskId, { status: 'completed', progress: 100, progressText: 'Global knowledge build complete' })
      return { success: true }
    } catch (error: any) {
      const isAbortError = error?.name === 'AbortError' || error?.message?.includes('cancelled')
      if (isAbortError) {
        this.taskQueue.updateTask(taskId, { status: 'cancelled', progressText: 'Cancelled' })
        return { success: false, error: 'Cancelled' }
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.taskQueue.updateTask(taskId, { status: 'failed', error: errorMessage, progressText: `Failed: ${errorMessage}` })
      return { success: false, error: errorMessage }
    }
  }
}

export default KBSummaryService
