import KnowledgeProcessorService from './knowledge-processor.service'
import type { DBKBParagraph } from '../../shared/db-types'

class KBParagraphService {
  private processor: KnowledgeProcessorService

  constructor(processor: KnowledgeProcessorService) {
    this.processor = processor
  }

  getParagraphs(documentId: string): DBKBParagraph[] {
    return this.processor.getParagraphs(documentId) as DBKBParagraph[]
  }
}

export default KBParagraphService
