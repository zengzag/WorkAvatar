import KnowledgeProcessorService from './knowledge-processor.service'
import type { DBKBChapter } from '../../shared/db-types'

class KBChapterService {
  private processor: KnowledgeProcessorService

  constructor(processor: KnowledgeProcessorService) {
    this.processor = processor
  }

  getChapters(documentId: string): DBKBChapter[] {
    return this.processor.getChapters(documentId) as DBKBChapter[]
  }
}

export default KBChapterService
