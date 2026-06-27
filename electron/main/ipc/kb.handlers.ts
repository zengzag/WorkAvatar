import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  KBCreateParams,
  KBUpdateParams,
  KBDocParseParams,
  KBProcessDocumentParams,
  KBProcessAllParams,
  KBBuildGlobalParams,
  KBExportFullParams,
  KBExportSummaryParams,
  KBExportDocumentsParams,
  KBImportFullParams,
} from '../../shared/ipc-channels'
import type KnowledgeBaseService from '../services/kb.service'
import { safeHandle } from './_shared'

export function registerKBHandlers(kbService: KnowledgeBaseService) {
  safeHandle(IPC_CHANNELS.KB_LIST, () => {
    return kbService.listKBs()
  })

  safeHandle(IPC_CHANNELS.KB_GET, (id: string) => {
    return kbService.getKB(id)
  })

  safeHandle(IPC_CHANNELS.KB_CREATE, (params: KBCreateParams) => {
    return kbService.createKB(params.name, params.description)
  })

  safeHandle(IPC_CHANNELS.KB_UPDATE, (params: KBUpdateParams) => {
    const { id, ...data } = params
    return kbService.updateKB(id, data)
  })

  safeHandle(IPC_CHANNELS.KB_DELETE, (id: string) => {
    return kbService.deleteKB(id)
  })

  ipcMain.handle(IPC_CHANNELS.KB_DOC_UPLOAD, async (event, params: { kb_id: string; paths: string[] }) => {
    try {
      const result = await kbService.uploadDocuments(
        params.kb_id,
        params.paths,
        (current, total, fileName) => {
          event.sender.send(IPC_CHANNELS.KB_UPLOAD_PROGRESS, { current, total, fileName })
        }
      )
      return result
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.KB_DOC_PARSE, async (params: KBDocParseParams) => {
    return kbService.parseDocument(params.doc_id, false)
  })

  safeHandle(IPC_CHANNELS.KB_DOC_DELETE, (id: string) => {
    return kbService.deleteDocument(id)
  })

  safeHandle(IPC_CHANNELS.KB_DOC_LIST, (params: { kb_id: string; status?: string }) => {
    return kbService.getDocumentList(params.kb_id, params.status)
  })

  safeHandle(IPC_CHANNELS.KB_PARSE_ALL, async (params: { kb_id: string }) => {
    return kbService.parseAllDocuments(params.kb_id)
  })

  safeHandle(IPC_CHANNELS.KB_PROCESS_DOCUMENT, async (params: KBProcessDocumentParams) => {
    return kbService.processDocument(
      params.doc_id,
      params.provider_id,
      params.model_id,
      params.enable_thinking,
    )
  })

  safeHandle(IPC_CHANNELS.KB_PROCESS_ALL, async (params: KBProcessAllParams) => {
    return kbService.processAllDocuments(
      params.kb_id,
      params.provider_id,
      params.model_id,
      params.enable_thinking,
    )
  })

  safeHandle(IPC_CHANNELS.KB_BUILD_GLOBAL, async (params: KBBuildGlobalParams) => {
    return kbService.buildGlobalKnowledge(
      params.kb_id,
      params.provider_id,
      params.model_id,
      params.enable_thinking,
    )
  })

  safeHandle(IPC_CHANNELS.KB_GET_STATS, (kbId: string) => {
    return kbService.getKnowledgeStats(kbId)
  })

  safeHandle(IPC_CHANNELS.KB_GET_PARAGRAPHS, (docId: string) => {
    return kbService.getParagraphs(docId)
  })

  safeHandle(IPC_CHANNELS.KB_GET_DOC_SUMMARY, (docId: string) => {
    return kbService.getDocumentSummary(docId)
  })

  safeHandle(IPC_CHANNELS.KB_GET_GLOBAL_SUMMARY, (kbId: string) => {
    return kbService.getGlobalSummary(kbId)
  })

  safeHandle(IPC_CHANNELS.KB_SEARCH_PARAGRAPHS, (params: { kb_id: string; query: string; top_k?: number }) => {
    return kbService.searchParagraphs(params.kb_id, params.query, params.top_k)
  })

  safeHandle(IPC_CHANNELS.KB_GET_DOC_CONTENT, (docId: string) => {
    return kbService.getDocumentContent(docId)
  })

  safeHandle(IPC_CHANNELS.KB_PAUSE_PARSE, (docId: string) => {
    return kbService.pauseParse(docId)
  })

  safeHandle(IPC_CHANNELS.KB_RESUME_PARSE, (docId: string) => {
    return kbService.resumeParse(docId)
  })

  safeHandle(IPC_CHANNELS.KB_RETRY_PARSE, (docId: string) => {
    return kbService.retryParse(docId)
  })

  safeHandle(IPC_CHANNELS.KB_PAUSE_ALL_PARSES, () => {
    return kbService.pauseAllParses()
  })

  safeHandle(IPC_CHANNELS.KB_RESUME_ALL_PARSES, () => {
    return kbService.resumeAllParses()
  })

  safeHandle(IPC_CHANNELS.KB_CANCEL_ALL_PARSES, () => {
    return kbService.cancelAllParses()
  })

  ipcMain.handle(IPC_CHANNELS.KB_EXPORT_FULL, async (event, params: KBExportFullParams) => {
    try {
      return await kbService.exportKBFull(
        params.kb_id,
        params.export_path,
        (stage, detail) => {
          event.sender.send(IPC_CHANNELS.KB_EXPORT_PROGRESS, { kb_id: params.kb_id, stage, detail })
        }
      )
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.KB_EXPORT_SUMMARY, async (event, params: KBExportSummaryParams) => {
    try {
      return await kbService.exportKBSummary(
        params.kb_id,
        params.export_path,
        params.format,
        (stage, detail) => {
          event.sender.send(IPC_CHANNELS.KB_EXPORT_PROGRESS, { kb_id: params.kb_id, stage, detail })
        }
      )
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.KB_EXPORT_DOCUMENTS, async (event, params: KBExportDocumentsParams) => {
    try {
      return await kbService.exportKBDocuments(
        params.kb_id,
        params.export_path,
        params.doc_ids,
        (stage, detail) => {
          event.sender.send(IPC_CHANNELS.KB_EXPORT_PROGRESS, { kb_id: params.kb_id, stage, detail })
        }
      )
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.KB_IMPORT_FULL, async (event, params: KBImportFullParams) => {
    try {
      return await kbService.importKBFull(
        params.import_path,
        params.kb_name,
        params.conflict_strategy,
        (stage, detail) => {
          event.sender.send(IPC_CHANNELS.KB_IMPORT_PROGRESS, { stage, detail })
        }
      )
    } catch (err: any) {
      return { error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.KB_SCAN_FOLDER, async (params: { folder_path: string }) => {
    return kbService.scanFolder(params.folder_path)
  })

  safeHandle(IPC_CHANNELS.KB_SEARCH, (params: { kb_id: string; query: string; top_k?: number; document_ids?: string[]; source_types?: string[] }) => {
    return kbService.search(params.kb_id, params.query, params.top_k, params.document_ids, params.source_types as any)
  })

  safeHandle(IPC_CHANNELS.KB_SEARCH_WITH_EMBEDDING, async (params: { kb_id: string; query: string; top_k?: number; document_ids?: string[]; provider_id?: string }) => {
    return await kbService.searchWithEmbedding(params.kb_id, params.query, params.top_k, params.document_ids, params.provider_id)
  })

  safeHandle(IPC_CHANNELS.KB_SEARCH_INDEX_STATS, (kbId: string) => {
    return kbService.getSearchIndexStats(kbId)
  })

  safeHandle(IPC_CHANNELS.KB_REBUILD_SEARCH_INDEX, async (kbId: string) => {
    await kbService.rebuildSearchIndex(kbId)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.KB_UPDATE_PARAGRAPH, (params: { paragraph_id: string; updates: { summary?: string; keywords_json?: string; content?: string; title?: string } }) => {
    return kbService.updateParagraph(params.paragraph_id, params.updates)
  })

  safeHandle(IPC_CHANNELS.KB_UPDATE_DOC_SUMMARY, (params: { document_id: string; updates: { summary?: string; keywords_json?: string; main_topics_json?: string } }) => {
    return kbService.updateDocumentSummary(params.document_id, params.updates)
  })

  safeHandle(IPC_CHANNELS.KB_GET_PARAGRAPHS_BY_KB, (kbId: string) => {
    return kbService.getParagraphsByKb(kbId)
  })
}
