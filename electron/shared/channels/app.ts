export const APP_CHANNELS = {
  PING: 'ping',

  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_KEY_SET: 'settings:key-set',
  SETTINGS_KEY_GET: 'settings:key-get',

  APP_GET_PATH: 'app:get-path',
  APP_SHOW_OPEN_DIALOG: 'app:show-open-dialog',
  APP_SHOW_MESSAGE_BOX: 'app:show-message-box',

  RAG_INDEX_PROJECT: 'rag:index-project',
  RAG_SEARCH: 'rag:search',
  RAG_INDEX_STATUS: 'rag:index-status',
  RAG_DELETE_INDEX: 'rag:delete-index',
} as const

export interface SettingsGetParams {
  key: string
}

export interface SettingsSetParams {
  key: string
  value: string
}

export interface AppGetPathParams {
  name: 'home' | 'appData' | 'userData' | 'temp' | 'documents' | 'downloads'
}

export interface AppShowOpenDialogParams {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: Array<{ name: string; extensions: string[] }>
  properties?: Array<'openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles'>
}