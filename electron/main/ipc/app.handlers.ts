import { dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  SettingsGetParams,
  SettingsSetParams,
  AppShowOpenDialogParams,
  AppShowSaveDialogParams,
} from '../../shared/ipc-channels'
import type DatabaseService from '../services/database.service'
import PathService from '../services/path.service'
import { safeHandle } from './_shared'

export function registerAppHandlers(
  db: ReturnType<DatabaseService['getDb']>
) {
  safeHandle(IPC_CHANNELS.APP_SHOW_OPEN_DIALOG, async (params: AppShowOpenDialogParams) => {
    const result = await dialog.showOpenDialog({
      title: params.title,
      defaultPath: params.defaultPath,
      buttonLabel: params.buttonLabel,
      filters: params.filters,
      properties: params.properties,
    })
    return result
  })

  safeHandle(IPC_CHANNELS.APP_SHOW_SAVE_DIALOG, async (params: AppShowSaveDialogParams) => {
    const result = await dialog.showSaveDialog({
      title: params.title,
      defaultPath: params.defaultPath,
      buttonLabel: params.buttonLabel,
      filters: params.filters,
    })
    return result
  })

  safeHandle(IPC_CHANNELS.SETTINGS_GET, (params: SettingsGetParams) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(params.key) as any
    return row?.value || null
  })

  safeHandle(IPC_CHANNELS.SETTINGS_SET, (params: SettingsSetParams) => {
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(params.key, params.value)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.PATH_GET_DATA_DIR, () => {
    return PathService.getInstance().getDataDir()
  })

  safeHandle(IPC_CHANNELS.PATH_SET_DATA_DIR, (newDir: string) => {
    return PathService.getInstance().setDataDir(newDir)
  })

}
