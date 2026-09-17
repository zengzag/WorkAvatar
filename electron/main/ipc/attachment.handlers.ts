import { IPC_CHANNELS } from '../../shared/ipc-channels'
import AttachmentService from '../services/attachment.service'
import { safeHandle } from './_shared'

export function registerAttachmentHandlers() {
  safeHandle(IPC_CHANNELS.ATTACHMENT_SAVE_DATA_URLS, (dataUrls: string[]) => {
    const refs = (Array.isArray(dataUrls) ? dataUrls : []).map(d => AttachmentService.getInstance().saveDataUrl(d))
    return { refs }
  })
}
