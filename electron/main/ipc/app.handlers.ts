import { ipcMain, app, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  SettingsGetParams,
  SettingsSetParams,
  AppGetPathParams,
  AppShowOpenDialogParams,
  AppShowSaveDialogParams,
} from '../../shared/ipc-channels'
import type DatabaseService from '../services/database.service'
import type OCRService from '../services/ocr.service'
import type RuleExtractionService from '../services/rule-extraction.service'

export function registerAppHandlers(
  db: ReturnType<DatabaseService['getDb']>,
  ocrService: OCRService,
  ruleExtractor: RuleExtractionService
) {
  ipcMain.handle(IPC_CHANNELS.PING, () => {
    return 'pong from main process'
  })

  ipcMain.handle(IPC_CHANNELS.APP_GET_PATH, (_, params: AppGetPathParams) => {
    return app.getPath(params.name)
  })

  ipcMain.handle(IPC_CHANNELS.APP_SHOW_OPEN_DIALOG, async (_, params: AppShowOpenDialogParams) => {
    const result = await dialog.showOpenDialog({
      title: params.title,
      defaultPath: params.defaultPath,
      buttonLabel: params.buttonLabel,
      filters: params.filters,
      properties: params.properties,
    })
    return result
  })

  ipcMain.handle(IPC_CHANNELS.APP_SHOW_SAVE_DIALOG, async (_, params: AppShowSaveDialogParams) => {
    const result = await dialog.showSaveDialog({
      title: params.title,
      defaultPath: params.defaultPath,
      buttonLabel: params.buttonLabel,
      filters: params.filters,
    })
    return result
  })

  ipcMain.handle(IPC_CHANNELS.APP_SHOW_MESSAGE_BOX, async (_, params: any) => {
    const result = await dialog.showMessageBox({
      type: params.type,
      title: params.title,
      message: params.message,
      detail: params.detail,
      buttons: params.buttons,
      defaultId: params.defaultId,
    })
    return result
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (_, params: SettingsGetParams) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(params.key) as any
    return row?.value || null
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_, params: SettingsSetParams) => {
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(params.key, params.value)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_KEY_GET, (_, params: SettingsGetParams) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(params.key) as any
    return row?.value || null
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_KEY_SET, (_, params: SettingsSetParams) => {
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(params.key, params.value)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.OCR_RECOGNIZE, async (_, params: { image_path: string; language?: string }) => {
    try {
      const result = await ocrService.recognize(params.image_path, { language: params.language })
      return { success: true, result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipcMain.handle(IPC_CHANNELS.OCR_STATUS, () => {
    return {
      rapidocr_available: ocrService.isRapidOCRAvailable(),
      tesseract_available: true,
    }
  })

  ipcMain.handle(IPC_CHANNELS.RULE_EXTRACT_FILE, async (_, params: { file_id: string; provider_id?: string; model_id?: string }) => {
    try {
      const result = await ruleExtractor.extractFromFile(params.file_id, params.provider_id, params.model_id)
      return { success: true, result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  ipcMain.handle(IPC_CHANNELS.RULE_EXTRACT_PROJECT, async (_, params: { project_id: string; provider_id?: string; model_id?: string }) => {
    try {
      const result = await ruleExtractor.extractFromProject(params.project_id, params.provider_id, params.model_id)
      return { success: true, result }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
}