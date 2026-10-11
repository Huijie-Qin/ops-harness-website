<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { VideoCatalog, VideoCategory, VideoEntry, VideoInput } from '../shared/videos'
import { maxVideoDescription, maxVideoDurationSeconds, maxVideoFileBytes, maxVideoTitle } from '../shared/videos'
import type { MediaImage } from '../shared/admin'
import { ApiError, guideApi, requestMessage, uploadFile, validateImage } from './guide-api'
import WebsiteDialog from './WebsiteDialog.vue'
import Icon from './Icon.vue'
import './video-admin.css'

const props = defineProps<{ csrf: string }>()
const emit = defineEmits<{ error: [error: unknown]; dirty: [value: boolean]; busy: [value: boolean] }>()
const categories: { id: VideoCategory; label: string }[] = [
  { id: 'product', label: '产品宣传' }, { id: 'feature', label: '特性使用' }, { id: 'practice', label: '最佳实践' },
]
const empty = (): VideoInput => ({ title: '', description: '', category: 'product', status: 'draft', featured: false, coverUrl: '', durationSeconds: 0 })
const catalog = ref<VideoCatalog>({ schemaVersion: 1, revision: '', items: [] })
const current = ref<VideoEntry>(), creating = ref(false), form = ref<VideoInput>(empty()), baseline = ref('')
const busy = ref(false), loading = ref(true), ready = ref(false), error = ref(''), notice = ref(''), query = ref('')
const uploadName = ref(''), uploadKind = ref<'video' | 'cover'>(), progress = ref(0), previewVisible = ref(false)
const titleInput = ref<HTMLInputElement>(), videoInput = ref<HTMLInputElement>(), coverInput = ref<HTMLInputElement>(), errorElement = ref<HTMLElement>()
const previewVideo = ref<HTMLVideoElement>()
const publishAsFeatured = ref(false)
const confirmation = ref<{ title: string; message: string; label: string; publishing?: boolean; action: () => void }>()
const lifetime = new AbortController()
let upload: AbortController | undefined
const active = computed(() => Boolean(current.value || creating.value))
const dirty = computed(() => active.value && JSON.stringify(form.value) !== baseline.value)
const visible = computed(() => catalog.value.items.filter(item => `${item.title} ${item.description} ${categoryName(item.category)}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const featured = computed(() => catalog.value.items.find(item => item.featured && item.status === 'published'))
const canPublish = computed(() => Boolean(current.value?.video && current.value.durationSeconds > 0 && !dirty.value && !busy.value))
const previewUrl = computed(() => current.value?.video ? `/api/admin/videos/${encodeURIComponent(current.value.id)}/preview?v=${current.value.video.sha256}` : '')
watch(dirty, value => emit('dirty', value)); watch(busy, value => emit('busy', value))
const call = <T,>(url: string, options: { method?: string; data?: unknown } = {}) => guideApi<T>(url, { ...options, csrf: props.csrf, signal: lifetime.signal })
const videoErrors: Record<string, string> = {
  INVALID_VIDEO: '请检查视频标题、简介、分类和时长后再保存。',
  INVALID_VIDEO_FILE: '请选择有效的 MP4 视频，推荐 H.264 画面与 AAC 音频。',
  INVALID_MP4: '文件不是有效的 MP4 视频，请重新导出后上传。',
  INVALID_VIDEO_NAME: '视频文件名无效，请使用不含路径的 MP4 文件名。',
  VIDEO_TOO_LARGE: '视频超过 512 MiB，请压缩后重新上传。',
  VIDEO_NOT_FOUND: '这条视频已被删除，请刷新列表。',
  VIDEO_FILE_REQUIRED: '请先上传视频文件，再发布。',
  VIDEO_NOT_PUBLISHABLE: '请先上传可播放的视频并确认时长，再发布。',
  VIDEO_PUBLISHED: '请先下架视频，再更换文件。',
  VIDEO_MUST_BE_DRAFT: '请先下架视频，再更换文件。',
  UPLOAD_TOO_LARGE: '文件超过上传限制：视频最多 512 MiB，封面最多 10 MiB。',
  CONTENT_UNAVAILABLE: '视频目录暂时无法读取，请稍后刷新重试。',
  VIDEO_LIMIT: '视频数量已达到上限，请先整理现有内容。',
  VIDEO_LIMIT_REACHED: '视频数量已达到 200 条上限，请先整理现有内容。',
  VIDEO_UNAVAILABLE: '视频内容暂时无法读取，请稍后重试。',
  VIDEO_METADATA_FAILED: '无法读取视频时长，请选择可在浏览器播放的 MP4 文件。',
}
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await action() } catch (cause) {
    if (lifetime.signal.aborted) return
    error.value = cause instanceof ApiError ? videoErrors[cause.code] ?? requestMessage(cause) : requestMessage(cause)
    if (cause instanceof ApiError && ['AUTH_REQUIRED', 'CSRF_REJECTED'].includes(cause.code)) emit('error', cause)
    await nextTick(); errorElement.value?.focus()
  } finally { busy.value = false; loading.value = false }
}
function metadata(entry: VideoEntry): VideoInput {
  return { title: entry.title, description: entry.description, category: entry.category, status: entry.status,
    featured: entry.featured, coverUrl: entry.coverUrl, durationSeconds: entry.durationSeconds }
}
function adopt(entry: VideoEntry) {
  closePreview()
  current.value = entry; creating.value = false; form.value = metadata(entry)
  baseline.value = JSON.stringify(form.value); previewVisible.value = false
}
function clearEditor() {
  closePreview()
  current.value = undefined; creating.value = false; form.value = empty(); baseline.value = JSON.stringify(form.value); previewVisible.value = false
}
function acceptCatalog(value: VideoCatalog, id?: string) {
  catalog.value = value
  if (id) { const entry = value.items.find(item => item.id === id); if (entry) adopt(entry); else clearEditor() }
}
async function list() { catalog.value = await call<VideoCatalog>('/api/admin/videos'); ready.value = true }
function guard(action: () => void) {
  if (busy.value) return
  if (dirty.value) confirmation.value = { title: '放弃未保存的修改？', message: '当前表单修改尚未保存，已上传的视频文件会保留。', label: '放弃修改', action }
  else action()
}
function create() { guard(() => {
  clearEditor(); creating.value = true; error.value = ''; notice.value = ''
  void nextTick(() => titleInput.value?.focus())
}) }
function select(entry: VideoEntry) { guard(() => { adopt(entry); error.value = ''; notice.value = '' }) }
function reload() { guard(() => void run(async () => {
  const id = current.value?.id; await list()
  const entry = catalog.value.items.find(item => item.id === id)
  if (entry) adopt(entry); else clearEditor()
})) }
function closePreview() {
  if (previewVideo.value) { previewVideo.value.pause(); previewVideo.value.removeAttribute('src'); previewVideo.value.load() }
  previewVisible.value = false
}
function togglePreview() { if (previewVisible.value) closePreview(); else previewVisible.value = true }
async function write(entry: VideoInput, id = current.value?.id) {
  const previousIds = new Set(catalog.value.items.map(item => item.id))
  const result = await call<VideoCatalog>(id ? `/api/admin/videos/${encodeURIComponent(id)}` : '/api/admin/videos', {
    method: id ? 'PUT' : 'POST', data: { entry, revision: catalog.value.revision },
  })
  const selectedId = id ?? result.items.find(item => !previousIds.has(item.id))?.id
  acceptCatalog(result, selectedId)
}
function save() { void run(async () => {
  if (!form.value.title.trim()) { titleInput.value?.focus(); throw new ApiError('INVALID_VIDEO') }
  const entry = { ...form.value, title: form.value.title.trim(), description: form.value.description.trim(),
    status: current.value?.status ?? 'draft', featured: current.value?.status === 'published' && form.value.featured }
  await write(entry)
  notice.value = entry.status === 'published' ? '更改已保存，公开内容已更新。' : '草稿已保存，可继续上传视频并预览。'
}) }
function publish() {
  const entry = current.value
  if (!entry || !canPublish.value) return
  publishAsFeatured.value = !featured.value
  confirmation.value = {
    title: '发布这支视频？', message: `“${entry.title}”发布后可以公开播放。${featured.value && featured.value.id !== entry.id ? `设为首页主片时将替换“${featured.value.title}”。` : ''}`,
    label: '确认发布', publishing: true, action: () => void run(async () => {
      await write({ ...metadata(entry), status: 'published', featured: publishAsFeatured.value }, entry.id)
      notice.value = publishAsFeatured.value ? '视频已发布，并设为首页主片。' : '视频已发布。'
    }),
  }
}
function unpublish() {
  const entry = current.value
  if (!entry || dirty.value) return
  confirmation.value = { title: '下架这支视频？', message: `“${entry.title}”将停止公开播放${entry.featured ? '，首页也将暂时不显示这支影片的播放入口' : ''}。文件和内容仍保留，可编辑后重新发布。`, label: '下架视频', action: () => void run(async () => {
    await write({ ...metadata(entry), status: 'draft', featured: false }, entry.id); notice.value = '视频已下架，已保存为草稿。'
  }) }
}
function remove() {
  const entry = current.value
  if (!entry) return
  confirmation.value = { title: '删除这条视频？', message: `“${entry.title}”将从视频目录移除${entry.status === 'published' ? '并停止公开播放' : ''}。资料会移入服务器回收目录，不会直接永久删除。`, label: '删除视频', action: () => void run(async () => {
    const result = await call<VideoCatalog>(`/api/admin/videos/${encodeURIComponent(entry.id)}`, { method: 'DELETE', data: { revision: catalog.value.revision } })
    acceptCatalog(result); clearEditor(); notice.value = '视频已移入回收目录。'
  }) }
}
function readDuration(file: File, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video'), url = URL.createObjectURL(file)
    let finished = false
    const finish = (duration?: number, cause?: Error) => {
      if (finished) return
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      video.onloadedmetadata = video.onerror = null; video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url)
      if (cause) reject(cause); else resolve(duration!)
    }
    const abort = () => finish(undefined, new DOMException('Video inspection cancelled', 'AbortError'))
    const timer = setTimeout(() => finish(undefined, new ApiError('VIDEO_METADATA_FAILED')), 20000)
    signal.addEventListener('abort', abort, { once: true })
    video.onloadedmetadata = () => Number.isFinite(video.duration) && video.duration > 0 && video.duration <= maxVideoDurationSeconds
      ? finish(Math.round(video.duration * 1000) / 1000) : finish(undefined, new ApiError('VIDEO_METADATA_FAILED'))
    video.onerror = () => finish(undefined, new ApiError('VIDEO_METADATA_FAILED'))
    video.preload = 'metadata'; video.src = url
    if (signal.aborted) abort()
  })
}
async function sendVideo(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0], entry = current.value
  if (!file || !entry || dirty.value || entry.status !== 'draft') { input.value = ''; return }
  await run(async () => {
    if (!/\.mp4$/i.test(file.name) || !file.size) throw new ApiError('INVALID_VIDEO_FILE')
    if (file.size > maxVideoFileBytes) throw new ApiError('VIDEO_TOO_LARGE')
    const controller = new AbortController(); upload = controller
    uploadName.value = file.name; uploadKind.value = 'video'; progress.value = 0; previewVisible.value = false
    try {
      const durationSeconds = await readDuration(file, controller.signal)
      if (controller.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')
      const result = await uploadFile<VideoCatalog>(`/api/admin/videos/${encodeURIComponent(entry.id)}/file?name=${encodeURIComponent(file.name)}`, file,
        { csrf: props.csrf, revision: catalog.value.revision, headers: { 'X-Video-Duration': String(durationSeconds) }, signal: controller.signal, progress: value => progress.value = value })
      acceptCatalog(result, entry.id); notice.value = '视频已上传。请预览确认后，再发布到官网。'
    } catch (cause) {
      if (controller.signal.aborted) notice.value = '上传已取消，已保存的草稿和原有视频仍保留。'
      else throw cause
    } finally { upload = undefined; uploadName.value = ''; uploadKind.value = undefined }
  })
  input.value = ''
}
async function sendCover(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file) return
  await run(async () => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new ApiError('INVALID_IMAGE')
    await validateImage(file)
    const controller = new AbortController(); upload = controller
    uploadName.value = file.name; uploadKind.value = 'cover'; progress.value = 0
    try {
      const result = await uploadFile<{ image: MediaImage }>('/api/admin/images?name=' + encodeURIComponent(file.name), file,
        { csrf: props.csrf, signal: controller.signal, progress: value => progress.value = value })
      form.value.coverUrl = result.image.url; notice.value = '封面已上传，保存后应用到这支视频。'
    } catch (cause) {
      if (controller.signal.aborted) notice.value = '封面上传已取消。'
      else throw cause
    } finally { upload = undefined; uploadName.value = ''; uploadKind.value = undefined }
  })
  input.value = ''
}
function accept() { const action = confirmation.value?.action; confirmation.value = undefined; action?.() }
function categoryName(category: VideoCategory) { return categories.find(item => item.id === category)?.label ?? '视频' }
function duration(seconds: number) { const total = Math.max(0, Math.round(seconds)); return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}` }
function size(bytes: number) { return `${(bytes / 1024 ** 2).toFixed(1)} MiB` }
onMounted(() => void run(list))
onBeforeUnmount(() => { closePreview(); lifetime.abort(); upload?.abort(); emit('dirty', false); emit('busy', false) })
</script>

<template>
  <section class="video-admin" :aria-busy="busy">
    <div class="video-admin-intro">
      <div><h2>让好方法，被更多人看见。</h2><p>集中管理产品宣传、特性使用与最佳实践视频。上传后先预览，再发布。</p></div>
      <div class="admin-actions"><button class="button secondary" :disabled="busy" @click="reload">刷新列表</button><button class="button primary" :disabled="busy || !ready" @click="create">上传新视频</button></div>
    </div>
    <p v-if="error" ref="errorElement" class="admin-error" role="alert" tabindex="-1">{{ error }}</p>
    <p v-if="notice" class="admin-success" role="status">{{ notice }}</p>
    <div v-if="uploadName" class="upload-progress" role="status"><span>{{ uploadKind === 'cover' ? '封面' : '视频' }} · {{ uploadName }}</span><progress :value="progress" max="100" aria-label="上传进度"></progress><span>{{ progress }}% · {{ progress === 100 ? '正在校验保存…' : '正在准备或上传…' }}</span><button class="button secondary" @click="upload?.abort()">取消上传</button></div>
    <div class="admin-layout video-admin-layout">
      <aside class="admin-sidebar video-library-sidebar">
        <div class="video-list-heading"><h3>全部视频</h3><span>{{ catalog.items.length }}</span></div>
        <label for="video-search">查找视频</label><input id="video-search" v-model="query" type="search" placeholder="标题或分类" />
        <p v-if="loading" class="editor-help" role="status">正在加载视频…</p>
        <p v-else-if="!visible.length" class="editor-help">{{ query ? '没有匹配的视频。' : '暂时没有视频，上传第一支影片吧。' }}</p>
        <nav aria-label="视频列表"><button v-for="item in visible" :key="item.id" :disabled="busy" :aria-current="current?.id === item.id ? 'page' : undefined" @click="select(item)">
          <span class="video-list-title">{{ item.title }}</span><small>{{ categoryName(item.category) }} · {{ item.video ? duration(item.durationSeconds) : '待上传' }}</small><span class="video-list-badges"><span :class="['video-status', { published: item.status === 'published' }]">{{ item.status === 'published' ? '已发布' : '草稿' }}</span><span v-if="item.featured" class="video-featured">首页主片</span></span>
        </button></nav>
      </aside>
      <section v-if="active" class="admin-workspace video-workspace">
        <div class="video-editor-title"><div><span class="video-editor-kicker">{{ creating ? '新视频' : categoryName(form.category) }}</span><h3>{{ creating ? '先为这支视频命名' : current?.title }}</h3></div><span class="editor-help">{{ dirty ? '有未保存的修改' : creating ? '尚未保存' : '已保存' }}</span></div>
        <form @submit.prevent="save">
          <fieldset :disabled="busy" class="video-fields">
            <label>视频标题<input ref="titleInput" v-model="form.title" required :maxlength="maxVideoTitle" placeholder="例如：52 秒，认识终端云工作助手" /></label>
            <label>一句话介绍<textarea v-model="form.description" rows="3" :maxlength="maxVideoDescription" placeholder="说明观众能从这支视频中了解什么。"></textarea></label>
            <fieldset class="video-category"><legend>视频分类</legend><div><label v-for="category in categories" :key="category.id" :class="{ selected: form.category === category.id }"><input v-model="form.category" type="radio" name="video-category" :value="category.id" />{{ category.label }}</label></div></fieldset>
            <section class="video-cover-section" aria-labelledby="video-cover-heading">
              <div><h4 id="video-cover-heading">视频封面 <small>可选</small></h4><p>用于播放前预览，留空使用视频首帧。建议 16:9 横版图片，PNG、JPEG 或 WebP，最多 10 MiB。</p><input ref="coverInput" class="file-input" type="file" accept="image/png,image/jpeg,image/webp" tabindex="-1" aria-label="选择视频封面" @change="sendCover" /><div class="admin-actions"><button type="button" class="button secondary" @click="coverInput?.click()">{{ form.coverUrl ? '更换封面' : '上传封面' }}</button><button v-if="form.coverUrl" type="button" class="video-text-button" @click="form.coverUrl = ''">使用视频首帧</button></div></div>
              <div class="video-cover-preview"><img v-if="form.coverUrl" :src="form.coverUrl" alt="当前视频封面预览" /><span v-else><Icon name="video" :size="28" />使用视频首帧</span></div>
            </section>
            <label v-if="current?.status === 'published'" class="check-label video-featured-choice"><input v-model="form.featured" type="checkbox" />设为首页主片</label>
            <p v-if="current?.status === 'published' && form.featured && featured && featured.id !== current.id" class="editor-help">保存后将替换当前主片“{{ featured.title }}”。</p>
            <div class="video-save-row"><button class="button primary" :disabled="!dirty || !form.title.trim()">{{ busy && !uploadName ? '正在保存…' : creating ? '保存草稿，继续上传' : current?.status === 'published' ? '保存更改' : '保存草稿' }}</button><small v-if="current?.status === 'published'">保存后公开内容立即更新。</small></div>
          </fieldset>
        </form>
        <section class="video-file-section" aria-labelledby="video-file-heading">
          <div class="video-section-heading"><div><h4 id="video-file-heading">影片文件</h4><p>MP4，最多 512 MiB。推荐 H.264 画面与 AAC 音频。</p></div><span v-if="current?.video" class="video-status published">已上传</span></div>
          <p v-if="!current" class="video-step-hint">保存草稿后，即可上传视频文件。</p>
          <template v-else>
            <p v-if="current.video" class="video-file-detail"><strong>{{ current.video.fileName }}</strong><span>{{ duration(current.durationSeconds) }} · {{ size(current.video.size) }}</span></p>
            <input ref="videoInput" class="file-input" type="file" accept=".mp4,video/mp4" tabindex="-1" aria-label="选择 MP4 视频" :disabled="busy || dirty || current.status === 'published'" @change="sendVideo" />
            <div class="admin-actions"><button v-if="current.status === 'draft'" class="button secondary" :disabled="busy || dirty" @click="videoInput?.click()">{{ current.video ? '更换视频文件' : '选择 MP4 视频' }}</button><button v-if="current.video" class="button secondary" :disabled="busy" :aria-expanded="previewVisible" aria-controls="video-admin-preview" @click="togglePreview"><Icon name="video" :size="16" />{{ previewVisible ? '收起预览' : '预览视频' }}</button></div>
            <p v-if="dirty" class="editor-help">请先保存表单修改，再上传或发布视频。</p><p v-else-if="current.status === 'published'" class="editor-help">如需更换影片文件，请先下架，再上传新版本。</p>
            <div v-if="previewVisible" id="video-admin-preview" class="video-admin-preview"><video ref="previewVideo" :key="previewUrl" :src="previewUrl" :poster="form.coverUrl || undefined" controls playsinline preload="metadata" @error="error = '视频暂时无法播放，请检查文件编码或重新上传。'"></video><p>预览已保存的影片；播放不会改变发布状态。</p></div>
          </template>
        </section>
        <section v-if="current" class="video-publish-section" aria-labelledby="video-publish-heading">
          <div><h4 id="video-publish-heading">{{ current.status === 'published' ? current.featured ? '正在首页展示' : '视频已发布' : '准备好与大家分享了吗？' }}</h4><p>{{ current.status === 'published' ? '你可以继续维护介绍与封面，或下架保留为草稿。' : current.video ? '确认预览无误后发布。你也可以将它设为首页主片。' : '上传影片并完成预览后，即可发布到官网。' }}</p></div>
          <button v-if="current.status === 'draft'" class="button primary" :disabled="!canPublish" @click="publish">发布视频</button><button v-else class="button secondary" :disabled="busy || dirty" @click="unpublish">下架视频</button>
        </section>
        <div v-if="current" class="video-editor-footer"><span>更新于 {{ new Date(current.updatedAt).toLocaleString('zh-CN') }}</span><button :disabled="busy" @click="remove">删除视频</button></div>
      </section>
      <div v-else class="video-admin-empty"><Icon name="video" :size="42" /><h3>从一支影片开始</h3><p>产品宣传、功能演示和实践经验，<br />都可以在这里上传与管理。</p><button class="button primary" :disabled="busy || !ready" @click="create">上传新视频</button><small v-if="featured">当前首页主片：{{ featured.title }}</small></div>
    </div>
    <WebsiteDialog v-if="confirmation" :title="confirmation.title" :message="confirmation.message" :confirm-label="confirmation.label" @cancel="confirmation = undefined" @confirm="accept"><label v-if="confirmation.publishing" class="check-label video-publish-choice"><input v-model="publishAsFeatured" type="checkbox" />同时设为首页主片</label></WebsiteDialog>
  </section>
</template>
