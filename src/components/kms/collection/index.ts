/** 合集数据结构（跨组件共享） */
export interface CollectionItem {
  id: string
  name: string
  description: string
  file_count: number
  created_at: number
  updated_at: number
}

export { KMSCollectionEditModal } from './KMSCollectionEditModal'
export { KMSCollectionSummaryModal } from './KMSCollectionSummaryModal'
export { KMSParagraphPreviewDrawer } from './KMSParagraphPreviewDrawer'
export { default as CollectionFileDetail } from './CollectionFileDetail'
export { default as CollectionCard } from './CollectionCard'
export { default as ProcessingAlerts } from './ProcessingAlerts'
export { buildFileColumns } from './collection-file-columns'
export type { CollectionFileColumnsHandlers } from './collection-file-columns'
