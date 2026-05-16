import KnowledgeProcessorService from './knowledge-processor.service'
import type { DBKBEntity, DBKBEntityRelation, DBKBEntityMention } from '../../shared/db-types'

class KBEntityService {
  private processor: KnowledgeProcessorService

  constructor(processor: KnowledgeProcessorService) {
    this.processor = processor
  }

  getEntities(kbId: string, type?: string): DBKBEntity[] {
    return this.processor.getEntities(kbId, type) as DBKBEntity[]
  }

  getEntityByName(kbId: string, name: string): DBKBEntity | null {
    return this.processor.getEntityByName(kbId, name) as DBKBEntity | null
  }

  getEntityRelations(entityId: string, depth: number = 1): DBKBEntityRelation[] {
    return this.processor.getEntityRelations(entityId, depth) as DBKBEntityRelation[]
  }

  getEntityMentions(entityId: string): DBKBEntityMention[] {
    return this.processor.getEntityMentions(entityId) as DBKBEntityMention[]
  }
}

export default KBEntityService
