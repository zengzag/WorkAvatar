import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  KBCreateParams,
  KBUpdateParams,
  KBDocParseParams,
  KBLinkProjectParams,
  KBProcessDocumentParams,
  KBProcessAllParams,
  KBBuildGlobalParams,
  KBExportFullParams,
  KBExportSummaryParams,
  KBExportDocumentsParams,
  KBImportFullParams,
  KBImportGraphParams,
} from '../../shared/ipc-channels'
import type KnowledgeBaseService from '../services/kb.service'

export function registerKBHandlers(kbService: KnowledgeBaseService) {
  ipcMain.handle(IPC_CHANNELS.KB_LIST, () => {
    return kbService.listKBs()
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET, (_, id: string) => {
    return kbService.getKB(id)
  })

  ipcMain.handle(IPC_CHANNELS.KB_CREATE, (_, params: KBCreateParams) => {
    return kbService.createKB(params.name, params.description)
  })

  ipcMain.handle(IPC_CHANNELS.KB_UPDATE, (_, params: KBUpdateParams) => {
    const { id, ...data } = params
    return kbService.updateKB(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.KB_DELETE, (_, id: string) => {
    return kbService.deleteKB(id)
  })

  ipcMain.handle(IPC_CHANNELS.KB_DOC_UPLOAD, async (event, params: { kb_id: string; paths: string[] }) => {
    const result = await kbService.uploadDocuments(
      params.kb_id,
      params.paths,
      (current, total, fileName) => {
        event.sender.send(IPC_CHANNELS.KB_UPLOAD_PROGRESS, { current, total, fileName })
      }
    )
    return result
  })

  ipcMain.handle(IPC_CHANNELS.KB_DOC_PARSE, async (event, params: KBDocParseParams) => {
    const result = await kbService.parseDocument(
      params.doc_id,
      false,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.KB_PARSE_PROGRESS, { doc_id: params.doc_id, stage, detail })
      }
    )
    return result
  })

  ipcMain.handle(IPC_CHANNELS.KB_DOC_DELETE, (_, id: string) => {
    return kbService.deleteDocument(id)
  })

  ipcMain.handle(IPC_CHANNELS.KB_DOC_LIST, (_, params: { kb_id: string; status?: string }) => {
    return kbService.getDocumentList(params.kb_id, params.status)
  })

  ipcMain.handle(IPC_CHANNELS.KB_LINK_PROJECT, (_, params: KBLinkProjectParams) => {
    return kbService.linkProject(params.kb_id, params.project_id)
  })

  ipcMain.handle(IPC_CHANNELS.KB_UNLINK_PROJECT, (_, params: KBLinkProjectParams) => {
    return kbService.unlinkProject(params.kb_id, params.project_id)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_PROJECTS, (_, kbId: string) => {
    return kbService.getLinkedProjects(kbId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_PARSE_ALL, async (event, params: { kb_id: string }) => {
    const result = await kbService.parseAllDocuments(
      params.kb_id,
      (current, total, docName) => {
        event.sender.send(IPC_CHANNELS.KB_PARSE_ALL_PROGRESS, { current, total, docName })
      }
    )
    return result
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_FILE_BY_HASH, (_, params: { hash: string }) => {
    return kbService.getExistingDocByHash(params.hash)
  })

  ipcMain.handle(IPC_CHANNELS.KB_IMPORT_DOCS_TO_PROJECT, async (_, params: { project_id: string; doc_ids: string[] }) => {
    return kbService.importKBDocsToProject(params.project_id, params.doc_ids)
  })

  ipcMain.handle(IPC_CHANNELS.KB_PROCESS_DOCUMENT, async (event, params: KBProcessDocumentParams) => {
    return kbService.processDocument(
      params.doc_id,
      params.provider_id,
      params.model_id,
      params.enable_thinking,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.KB_PROCESS_PROGRESS, { doc_id: params.doc_id, stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.KB_PROCESS_ALL, async (event, params: KBProcessAllParams) => {
    return kbService.processAllDocuments(
      params.kb_id,
      params.provider_id,
      params.model_id,
      params.enable_thinking,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.KB_PROCESS_ALL_PROGRESS, { kb_id: params.kb_id, stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.KB_BUILD_GLOBAL, async (event, params: KBBuildGlobalParams) => {
    return kbService.buildGlobalKnowledge(
      params.kb_id,
      params.provider_id,
      params.model_id,
      params.enable_thinking,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.KB_BUILD_GLOBAL_PROGRESS, { kb_id: params.kb_id, stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_STATS, (_, kbId: string) => {
    return kbService.getKnowledgeStats(kbId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_CHAPTERS, (_, docId: string) => {
    return kbService.getChapters(docId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_DOC_SUMMARY, (_, docId: string) => {
    return kbService.getDocumentSummary(docId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_ALL_DOC_SUMMARIES, (_, kbId: string) => {
    return kbService.getAllDocumentSummaries(kbId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_GLOBAL_SUMMARY, (_, kbId: string) => {
    return kbService.getGlobalSummary(kbId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_ENTITIES, (_, params: { kb_id: string; type?: string }) => {
    return kbService.getEntities(params.kb_id, params.type)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_ENTITY, (_, params: { kb_id: string; name: string }) => {
    return kbService.getEntityByName(params.kb_id, params.name)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_ENTITY_RELATIONS, (_, params: { entity_id: string; depth?: number }) => {
    return kbService.getEntityRelations(params.entity_id, params.depth)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_ENTITY_MENTIONS, (_, entityId: string) => {
    return kbService.getEntityMentions(entityId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_SEARCH_CHAPTERS, (_, params: { kb_id: string; query: string; top_k?: number }) => {
    return kbService.searchChapters(params.kb_id, params.query, params.top_k)
  })

  ipcMain.handle(IPC_CHANNELS.KB_SEARCH_DOC_SUMMARIES, (_, params: { kb_id: string; query: string; top_k?: number }) => {
    return kbService.searchDocumentSummaries(params.kb_id, params.query, params.top_k)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_PROCESSING_JOBS, (_, params: { kb_id: string; status?: string }) => {
    return kbService.getProcessingJobs(params.kb_id, params.status)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_KBS_FOR_PROJECT, (_, projectId: string) => {
    return kbService.getKBsForProject(projectId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_DOC_CONTENT, (_, docId: string) => {
    return kbService.getDocumentContent(docId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_PAUSE_PARSE, (_, docId: string) => {
    return kbService.pauseParse(docId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_RESUME_PARSE, (_, docId: string) => {
    return kbService.resumeParse(docId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_RETRY_PARSE, (_, docId: string) => {
    return kbService.retryParse(docId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_GET_PARSE_DETAIL, (_, docId: string) => {
    return kbService.getDocParseDetail(docId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_PAUSE_ALL_PARSES, () => {
    return kbService.pauseAllParses()
  })

  ipcMain.handle(IPC_CHANNELS.KB_RESUME_ALL_PARSES, () => {
    return kbService.resumeAllParses()
  })

  ipcMain.handle(IPC_CHANNELS.KB_CANCEL_ALL_PARSES, () => {
    return kbService.cancelAllParses()
  })

  ipcMain.handle(IPC_CHANNELS.KB_EXPORT_FULL, async (event, params: KBExportFullParams) => {
    return kbService.exportKBFull(
      params.kb_id,
      params.export_path,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.KB_EXPORT_PROGRESS, { kb_id: params.kb_id, stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.KB_EXPORT_SUMMARY, async (event, params: KBExportSummaryParams) => {
    return kbService.exportKBSummary(
      params.kb_id,
      params.export_path,
      params.format,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.KB_EXPORT_PROGRESS, { kb_id: params.kb_id, stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.KB_EXPORT_DOCUMENTS, async (event, params: KBExportDocumentsParams) => {
    return kbService.exportKBDocuments(
      params.kb_id,
      params.export_path,
      params.doc_ids,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.KB_EXPORT_PROGRESS, { kb_id: params.kb_id, stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.KB_IMPORT_FULL, async (event, params: KBImportFullParams) => {
    return kbService.importKBFull(
      params.import_path,
      params.kb_name,
      params.conflict_strategy,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.KB_IMPORT_PROGRESS, { stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.KB_IMPORT_GRAPH, async (event, params: KBImportGraphParams) => {
    return kbService.importKBGraph(
      params.kb_id,
      params.import_path,
      params.format,
      params.conflict_strategy,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.KB_IMPORT_PROGRESS, { kb_id: params.kb_id, stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.KB_SCAN_FOLDER, async (_, params: { folder_path: string }) => {
    return kbService.scanFolder(params.folder_path)
  })

  ipcMain.handle(IPC_CHANNELS.KB_SEARCH, (_, params: { kb_id: string; query: string; top_k?: number; document_ids?: string[] }) => {
    return kbService.search(params.kb_id, params.query, params.top_k, params.document_ids)
  })

  ipcMain.handle(IPC_CHANNELS.KB_ADVANCED_SEARCH, (_, params: { kb_id: string; query: string; top_k?: number; document_type?: string }) => {
    return kbService.advancedSearch(params.kb_id, params.query, params.top_k, params.document_type)
  })

  ipcMain.handle(IPC_CHANNELS.KB_SEARCH_WITH_EMBEDDING, async (_, params: { kb_id: string; query: string; top_k?: number; document_ids?: string[]; provider_id?: string }) => {
    return await kbService.searchWithEmbedding(params.kb_id, params.query, params.top_k, params.document_ids, params.provider_id)
  })

  ipcMain.handle(IPC_CHANNELS.KB_SEARCH_INDEX_STATS, (_, kbId: string) => {
    return kbService.getSearchIndexStats(kbId)
  })

  ipcMain.handle(IPC_CHANNELS.KB_REBUILD_SEARCH_INDEX, async (_, kbId: string) => {
    await kbService.rebuildSearchIndex(kbId)
    return { success: true }
  })
}
