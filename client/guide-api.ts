const messages: Record<string, string> = {
  MANIFEST_REQUIRED: '请先上传与安装包同一次打包生成的 latest.yml（macOS 为 latest-mac.yml）。',
  INVALID_MANIFEST: '描述文件无效：请选择打包生成的更新 YAML，需包含 version 和 files 中的 url、SHA-512；size 可省略，若提供需为正整数字节数。只支持 Windows x64 与 macOS arm64，最多 32 KiB。',
  MANIFEST_DUPLICATE_KEY: '描述文件中同一层级出现重复字段，请检查缩进。files 中每个文件只保留一个 sha512；末尾的 path、sha512、releaseDate 应与 version 顶格对齐。',
  MANIFEST_LOCKED: '描述文件已锁定。如需更换构建产物，请新建发布草稿。',
  MANIFEST_RELEASE_MISMATCH: '描述文件的版本或平台与此草稿不一致，请选择对应文件或新建草稿。',
  PACKAGE_NOT_IN_MANIFEST: '此文件未列在描述文件中，请选择清单中的原始安装包，不要重命名。',
  PACKAGE_CHECKSUM_MISMATCH: '文件校验失败：大小或 SHA-512 与打包描述文件不一致。此次上传未保存，请使用同一次打包的原始文件重试；旧草稿请先移除不匹配的文件。',
  CATALOG_LIMIT: '发布记录已达到容量上限，请联系维护人员整理。',
  INVALID_NAVIGATION: '请检查目录分组与章节，章节不能重复或遗漏。', INVALID_IMAGE: '请选择有效的 PNG、JPEG 或 WebP 图片，尺寸不超过 16000 像素且总像素不超过 4000 万。',
  IMAGE_LIMIT: '图片库已达到 4000 张上限。', UPLOAD_TOO_LARGE: '文件超过限制：图片 10 MiB，软件包 2 GiB。', UPLOAD_BUSY: '当前上传较多，请稍后重试。', EMPTY_UPLOAD: '不能上传空文件。',
  INVALID_RELEASE: '请填写正确的版本、平台、标题和更新说明（1–30 条，每条最多 1000 字）。', INVALID_PACKAGE_NAME: '文件名必须包含当前版本和平台架构；Windows 需要 exe，macOS 需要 arm64.zip，可附带同版本安装包。',
  FILE_EXISTS: '已有同名文件，请先移除旧文件。', FILE_LIMIT: '一个平台最多上传 8 个文件。', DRAFT_LIMIT: '发布草稿已达到 100 个，请整理旧草稿。', DRAFT_NOT_FOUND: '发布草稿不存在，请刷新列表。',
  ALREADY_PUBLISHED: '该版本的平台安装包已发布，请使用新版本。', RELEASE_ID_LOCKED: '版本和平台由描述文件确定，不能手动修改，请新建发布草稿。', MAIN_PACKAGE_REQUIRED: '请上传一个主安装包：Windows 为 exe，macOS 为 arm64.zip。',
  RELEASE_NOTES_MISMATCH: '该版本已有其他平台，请将标题和更新说明保持一致。', PUBLICATION_FAILED: '发布未完成，请刷新列表检查状态后重试；已有安装包不会被覆盖。',
  AUTH_REQUIRED: '登录已过期，请重新登录。草稿仍保留在当前页面。', INVALID_CREDENTIALS: '管理员密码不正确。', ADMIN_NOT_CONFIGURED: '管理员登录尚未配置。',
  LOGIN_RATE_LIMIT: '尝试次数过多，请在 5 分钟后重试。', ORIGIN_REJECTED: '访问地址与服务配置不一致，请使用配置中的官网地址。', CSRF_REJECTED: '登录状态已更新，请重新登录后再保存。',
  LOGIN_BUSY: '当前登录请求较多，请稍后重试。',
  CONTENT_SYNC_FAILED: '同步未完成，请检查运行目录中的同步备份与记录，再继续操作。', CONTENT_SYNC_REVIEW: '上次同步尚未完成核对，请先检查运行目录中的 content-sync-review.json 和备份。', CONTENT_SYNC_UNAVAILABLE: '当前部署未提供源码同步，请在官网源码项目中启动服务。',
  REVISION_CONFLICT: '内容已被其他人更新。当前修改已保留，请与最新版本核对后重试。', CONTENT_BUSY: '其他编辑正在保存，请稍后重试。',
  CHAPTER_NOT_FOUND: '章节不存在或已移至回收站。', CHAPTER_TOO_LARGE: '单章内容不能超过 128 KiB，请拆分章节。', CHAPTER_LIMIT: '章节数量已达到 200 个，请联系维护人员整理。',
  INVALID_CHAPTER: '请检查标题、分组、排序与正文是否完整，章节标识只能使用小写字母、数字和连字符。', INVALID_CHAPTER_ID: '章节标识格式不正确。',
  CONTENT_UNAVAILABLE: '帮助文档暂时无法读取，请稍后重试。', INVALID_REQUEST: '提交的内容不完整，请检查后重试。',
}
export class ApiError extends Error { constructor(public code: string) { super(messages[code] ?? '操作未完成，请稍后重试。') } }
export async function guideApi<T>(url: string, options: { method?: string; data?: unknown; csrf?: string; signal?: AbortSignal; timeout?: number } = {}): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  const timeout = setTimeout(abort, options.timeout ?? 20000)
  try {
    const response = await fetch(url, { method: options.method ?? 'GET', credentials: 'same-origin', signal: controller.signal,
      headers: { ...(options.data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}) },
      body: options.data === undefined ? undefined : JSON.stringify(options.data) })
    const value = await response.json()
    if (!response.ok) throw new ApiError(value.error ?? 'CONTENT_UNAVAILABLE')
    return value
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
}
export const requestMessage = (error: unknown) => error instanceof ApiError ? error.message : '连接未完成，请检查网络后重试。'

export function uploadFile<T>(url: string, file: File, options: { csrf: string; revision?: string; signal: AbortSignal; progress: (percent: number) => void }): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const finish = (error?: Error, value?: T) => { options.signal.removeEventListener('abort', abort); xhr.upload.onprogress = null; xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null; error ? reject(error) : resolve(value!) }
    xhr.open('POST', url); xhr.timeout = 30 * 60 * 1000; xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('X-CSRF-Token', options.csrf)
    if (options.revision) xhr.setRequestHeader('X-Revision', options.revision)
    xhr.upload.onprogress = e => { if (e.lengthComputable) options.progress(Math.round(e.loaded / e.total * 100)) }
    xhr.onload = () => { try { const data = JSON.parse(xhr.responseText); xhr.status >= 200 && xhr.status < 300 ? finish(undefined, data) : finish(new ApiError(data.error)) } catch { finish(new Error('Invalid response')) } }
    xhr.onerror = xhr.ontimeout = () => finish(new Error('Upload failed'))
    xhr.onabort = () => finish(new DOMException('Upload cancelled', 'AbortError'))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) { finish(new DOMException('Upload cancelled', 'AbortError')); return }
    xhr.send(file)
  })
}
export function imageMarkdown(url: string, alt: string) { return `![${alt.replace(/[\\[\]\r\n]/g, ' ').trim() || '图片'}](${url})` }

export async function validateImage(file: File) {
  if (file.size > 10 * 1024 ** 2) throw new ApiError('UPLOAD_TOO_LARGE')
  // Validate decodability before adding broken images to the user's document.
  let bitmap: ImageBitmap
  try { bitmap = await createImageBitmap(file) } catch { throw new ApiError('INVALID_IMAGE') }
  try { if (!bitmap.width || !bitmap.height || bitmap.width > 16000 || bitmap.height > 16000 || bitmap.width * bitmap.height > 40_000_000) throw new ApiError('INVALID_IMAGE') }
  finally { bitmap.close() }
}
