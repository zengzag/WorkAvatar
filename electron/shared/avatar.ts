/** 头像以 data URL 存 employees.avatar_image：限制格式与体积，防止超大图片拖慢列表渲染、导出与备份 */
export const MAX_AVATAR_IMAGE_LENGTH = 600 * 1024

/** 校验并归一化头像 data URL：非法格式或超限时返回空串 */
export const sanitizeAvatarImage = (value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return ''
  return value.length > MAX_AVATAR_IMAGE_LENGTH ? '' : value
}
