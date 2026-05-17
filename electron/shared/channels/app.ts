export const APP_CHANNELS = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  APP_SHOW_OPEN_DIALOG: 'app:show-open-dialog',
  APP_SHOW_SAVE_DIALOG: 'app:show-save-dialog',

  PATH_GET_DATA_DIR: 'path:get-data-dir',
  PATH_SET_DATA_DIR: 'path:set-data-dir',
} as const

export interface SettingsGetParams {
  key: string
}

export interface SettingsSetParams {
  key: string
  value: string
}

export interface AppShowOpenDialogParams {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'>
}

export interface AppShowSaveDialogParams {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: Array<{ name: string; extensions: string[] }>
}
