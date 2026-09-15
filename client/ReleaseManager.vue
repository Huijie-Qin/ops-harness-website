<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { ReleaseDraft, ManagedRelease, ReleaseManifest } from '../shared/admin'
import { maxManifestBytes, maxPackageBytes } from '../shared/admin'
import { ApiError, guideApi, requestMessage, uploadFile } from './guide-api'
import WebsiteDialog from './WebsiteDialog.vue'

const props = defineProps<{ csrf: string }>()
const emit = defineEmits<{ error: [e: unknown]; dirty: [v: boolean]; busy: [v: boolean] }>()
const drafts = ref<ReleaseDraft[]>([]), releases = ref<ManagedRelease[]>([])
const current = ref<ReleaseDraft>(), published = ref<ManagedRelease>(), creating = ref(false)
const pendingManifest = ref<ReleaseManifest>()
const form = ref({ title: '', changelog: '', enabled: true }), baseline = ref('')
const busy = ref(false), notice = ref(''), error = ref(''), progress = ref(0), uploadName = ref('')
const errorElement = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>(), manifestInput = ref<HTMLInputElement>(), titleInput = ref<HTMLInputElement>()
const confirmation = ref<{ title: string; message: string; label?: string; action: () => void }>()
const lifetime = new AbortController()
let upload: AbortController | undefined
const manifest = computed(() => creating.value ? pendingManifest.value : current.value?.manifest)
const dirty = computed(() => Boolean(current.value || published.value || creating.value) &&
  (JSON.stringify(form.value) !== baseline.value || creating.value && !!pendingManifest.value))
const mainUploaded = computed(() => current.value?.files.some(f => f.name.endsWith(current.value?.platform === 'windows-x64' ? '.exe' : '.zip')))
const publishedFiles = computed(() => Object.entries(published.value?.targets ?? {}).flatMap(([platform, target]) => target!.downloads.map(f => ({ ...f, platform }))))
watch(dirty, v => emit('dirty', v)); watch(busy, v => emit('busy', v))
const call = <T,>(url: string, options: { method?: string; data?: unknown; timeout?: number } = {}) =>
  guideApi<T>(url, { ...options, csrf: props.csrf, signal: lifetime.signal })
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; notice.value = ''; error.value = ''
  try { await fn() } catch (e) {
    error.value = requestMessage(e)
    if (e instanceof ApiError && ['AUTH_REQUIRED', 'CSRF_REJECTED'].includes(e.code)) emit('error', e)
    await nextTick(); errorElement.value?.focus()
  } finally { busy.value = false }
}
async function list() {
  const result = await call<{ drafts: ReleaseDraft[]; releases: ManagedRelease[] }>('/api/admin/releases')
  drafts.value = result.drafts; releases.value = result.releases
}
function adopt(value: ReleaseDraft | ManagedRelease) {
  creating.value = false; pendingManifest.value = undefined
  if ('id' in value) {
    current.value = value; published.value = undefined
    drafts.value = drafts.value.map(draft => draft.id === value.id ? value : draft)
  }
  else { published.value = value; current.value = undefined }
  form.value = { title: value.title, changelog: value.notes.join('\n'), enabled: 'enabled' in value ? value.enabled : true }
  baseline.value = JSON.stringify(form.value)
}
function guard(action: () => void) {
  if (busy.value) return
  if (dirty.value) confirmation.value = { title: '放弃未保存的修改？', message: '已保存的草稿与上传文件会保留。', label: '放弃修改', action }
  else action()
}
function create() {
  guard(() => {
    creating.value = true; current.value = undefined; published.value = undefined; pendingManifest.value = undefined
    form.value = { title: '', changelog: '', enabled: true }; baseline.value = JSON.stringify(form.value)
    notice.value = ''; error.value = ''
    void nextTick(() => document.getElementById('choose-release-manifest')?.focus())
  })
}
async function importManifest(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (!file) return
  await run(async () => {
    try {
      if (creating.value) pendingManifest.value = undefined
      if (file.size > maxManifestBytes || !/\.ya?ml$/.test(file.name)) throw new ApiError('INVALID_MANIFEST')
      const source = { name: file.name, content: await file.text() }
      if (creating.value) {
        const result = await call<{ manifest: ReleaseManifest }>('/api/admin/releases/manifest', { method: 'POST', data: { manifest: source } })
        pendingManifest.value = result.manifest
        const existing = releases.value.find(r => r.version === result.manifest.version)
        if (existing) { form.value.title = existing.title; form.value.changelog = existing.notes.join('\n') }
        else if (!form.value.title || /^\S+ 版本更新$/.test(form.value.title)) form.value.title = `${result.manifest.version} 版本更新`
        notice.value = '已读取版本、平台和校验清单。填写更新说明并保存草稿后，即可上传安装包。'
      } else if (current.value) {
        const result = await call<{ draft: ReleaseDraft }>(`/api/admin/releases/drafts/${current.value.id}/manifest`, {
          method: 'PUT', data: { manifest: source, revision: current.value.revision }, timeout: 30 * 60 * 1000,
        })
        adopt(result.draft); await list(); notice.value = '描述文件已保存，已有软件包已通过校验。'
      }
    } finally { input.value = '' }
  })
  await nextTick(); if (!error.value) titleInput.value?.focus()
}
function notes() { return form.value.changelog.split(/\r?\n/).map(s => s.trim()).filter(Boolean) }
async function save() {
  await run(async () => {
    if (published.value) {
      const result = await call<{ release: ManagedRelease }>(`/api/admin/releases/published/${encodeURIComponent(published.value.version)}`, {
        method: 'PUT', data: { release: { title: form.value.title, notes: notes(), enabled: form.value.enabled }, revision: published.value.revision },
      }); adopt(result.release)
    } else {
      const id = current.value?.id
      if (!id && !pendingManifest.value) throw new ApiError('MANIFEST_REQUIRED')
      const draft = id ? { title: form.value.title, notes: notes(), version: current.value!.version, platform: current.value!.platform }
        : { title: form.value.title, notes: notes(), manifest: { name: pendingManifest.value!.name, content: pendingManifest.value!.content } }
      const result = await call<{ draft: ReleaseDraft }>(id ? `/api/admin/releases/drafts/${id}` : '/api/admin/releases', {
        method: id ? 'PUT' : 'POST', data: { draft, revision: current.value?.revision },
      }); adopt(result.draft)
    }
    await list(); notice.value = published.value ? '更新说明和显示状态已保存。' : '草稿已保存，请上传下方清单中的原始安装包。'
  })
}
function saveClick() {
  if (published.value?.enabled && !form.value.enabled) confirmation.value = { title: '下架这个版本？', message: '下载页和自动更新将不再提供这个版本，归档文件仍保留。', label: '保存并下架', action: () => void save() }
  else void save()
}
async function send(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? [])
  if (!current.value || !files.length) return
  await run(async () => {
    upload = new AbortController()
    try {
      for (const file of files) {
        const expected = current.value!.manifest?.files.find(f => f.name === file.name)
        if (!expected) throw new ApiError('PACKAGE_NOT_IN_MANIFEST')
        if (file.size > maxPackageBytes) throw new ApiError('UPLOAD_TOO_LARGE')
        if (file.size !== expected.size) throw new ApiError('PACKAGE_CHECKSUM_MISMATCH')
        uploadName.value = file.name; progress.value = 0
        const result = await uploadFile<{ draft: ReleaseDraft }>(`/api/admin/releases/drafts/${current.value!.id}/files?name=${encodeURIComponent(file.name)}`, file, {
          csrf: props.csrf, revision: current.value!.revision, signal: upload.signal, progress: v => progress.value = v,
        }); adopt(result.draft)
      }
      await list(); notice.value = '上传完成，文件大小与 SHA-512 均与描述文件一致。可以核对并发布。'
    } catch (e) {
      if (upload.signal.aborted) notice.value = '上传已取消，已通过校验的文件仍保留。'
      else throw e
    } finally { uploadName.value = ''; if (fileInput.value) fileInput.value.value = '' }
  })
}
function removeFile(name: string) {
  confirmation.value = { title: '移除这个草稿文件？', message: name, label: '移除文件', action: () => void run(async () => {
    adopt((await call<{ draft: ReleaseDraft }>(`/api/admin/releases/drafts/${current.value!.id}/files?name=${encodeURIComponent(name)}`, { method: 'DELETE', data: { revision: current.value!.revision } })).draft)
    await list()
  }) }
}
function discard() {
  confirmation.value = { title: '将发布草稿移至回收目录？', message: '已发布的版本和安装包不会受影响。', label: '移除草稿', action: () => void run(async () => {
    await call(`/api/admin/releases/drafts/${current.value!.id}`, { method: 'DELETE', data: { revision: current.value!.revision } })
    current.value = undefined; await list(); notice.value = '草稿已移至回收目录。'
  }) }
}
function publish() {
  const d = current.value
  if (!d) return
  confirmation.value = { title: `发布 ${d.version}？`, message: `${platformLabel(d.platform)} · ${d.files.length} 个文件。安装包已通过描述文件校验，发布前还会再次复核。确认后会出现在下载页并参与自动更新，发布后不可覆盖。`, label: '确认发布', action: () => void run(async () => {
    await call(`/api/admin/releases/drafts/${d.id}/publish`, { method: 'POST', data: { revision: d.revision }, timeout: 30 * 60 * 1000 })
    await list(); adopt(releases.value.find(r => r.version === d.version)!); notice.value = '发布成功，下载页和自动更新已更新。'
  }) }
}
function reload() {
  guard(() => void run(async () => {
    const id = current.value?.id, version = published.value?.version
    await list()
    const value = id ? drafts.value.find(d => d.id === id) : releases.value.find(r => r.version === version)
    if (value) adopt(value)
    else { current.value = undefined; published.value = undefined; creating.value = false; pendingManifest.value = undefined }
  }))
}
function accept() { const action = confirmation.value?.action; confirmation.value = undefined; action?.() }
function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`
}
function platformLabel(platform: string) { return platform === 'windows-x64' ? 'Windows x64' : 'macOS Apple 芯片' }
function uploaded(name: string) { return current.value?.files.some(f => f.name === name) }
function required(name: string) { return name.endsWith(manifest.value?.platform === 'windows-x64' ? '.exe' : '.zip') }
onMounted(() => run(list))
onBeforeUnmount(() => { lifetime.abort(); upload?.abort(); emit('dirty', false); emit('busy', false) })
</script>

<template>
  <section :aria-busy="busy">
    <div class="editor-heading">
      <div><h2>发布包管理</h2><p>先导入打包描述文件，再上传并校验安装包。</p></div>
      <div class="admin-actions"><button class="button secondary" :disabled="busy" @click="reload">刷新列表</button><button class="button primary" :disabled="busy" @click="create">新建发布</button></div>
    </div>
    <p v-if="error" ref="errorElement" class="admin-error" role="alert" tabindex="-1">{{ error }}</p>
    <p v-if="notice" class="admin-success" role="status">{{ notice }}</p>
    <div class="admin-layout">
      <aside class="admin-sidebar release-sidebar">
        <h3>发布草稿</h3><p v-if="!drafts.length" class="editor-help">尚无草稿</p>
        <nav aria-label="发布草稿"><button v-for="d in drafts" :key="d.id" :disabled="busy" :aria-current="current?.id === d.id ? 'page' : undefined" @click="guard(() => { adopt(d); error = ''; notice = '' })"><span>{{ d.version }} · {{ platformLabel(d.platform) }}</span><small>{{ d.published ? '已发布，可清理草稿' : !d.manifest ? '需补充描述文件' : `${d.files.length} 个文件 · 待发布` }}</small></button></nav>
        <h3>已发布版本</h3><p v-if="!releases.length" class="editor-help">尚未发布版本</p>
        <nav aria-label="已发布版本"><button v-for="r in releases" :key="r.version" :disabled="busy" :aria-current="published?.version === r.version ? 'page' : undefined" @click="guard(() => { adopt(r); error = ''; notice = '' })"><span>{{ r.version }} · {{ r.title }}</span><small>{{ r.enabled ? '已上架' : '已下架' }} · {{ new Date(r.publishedAt).toLocaleDateString() }}</small></button></nav>
      </aside>
      <section v-if="current || published || creating" class="admin-workspace release-workspace">
        <div class="editor-heading"><h3>{{ published ? '维护已发布版本' : current ? '发布草稿' : '创建发布草稿' }}</h3><span class="editor-help">{{ dirty ? '有未保存的修改' : creating ? '尚未创建' : '已保存' }}</span></div>
        <section v-if="creating || current && !current.manifest && !current.published" class="manifest-import" aria-labelledby="manifest-heading">
          <h3 id="manifest-heading">1. 导入描述文件</h3>
          <p>选择与安装包同一次打包生成的 <code>latest.yml</code>，macOS 使用 <code>latest-mac.yml</code>。将自动读取版本、平台和文件校验信息。</p>
          <p v-if="current" class="editor-help">此旧草稿需要补充对应版本的描述文件；已有文件也会重新校验。</p>
          <input ref="manifestInput" class="file-input" type="file" accept=".yml,.yaml" tabindex="-1" aria-label="选择打包描述文件" :disabled="busy || !!current && dirty" @change="importManifest" />
          <button id="choose-release-manifest" class="button secondary" :disabled="busy || !!current && dirty" @click="manifestInput?.click()">{{ pendingManifest ? '重新选择描述文件' : '选择描述文件' }}</button>
          <small>最多 32 KiB。无需上传 builder-debug.yml 或 .blockmap。</small>
        </section>
        <h3 v-if="current?.manifest" class="release-step-title">1. 描述文件已导入</h3>
        <div v-if="manifest || current || published" class="release-identity">
          <span><small>版本号</small><strong>{{ manifest?.version ?? current?.version ?? published?.version }}</strong></span>
          <span v-if="manifest || current"><small>平台</small><strong>{{ platformLabel(manifest?.platform ?? current!.platform) }}</strong></span>
          <span v-if="manifest"><small>描述文件</small><strong>{{ manifest.name }}</strong></span>
        </div>
        <form v-if="manifest || current || published" @submit.prevent="saveClick">
          <fieldset :disabled="busy || current?.published">
            <h3 v-if="!published" class="release-step-title">2. 填写更新说明</h3>
            <label class="release-title">版本标题<input ref="titleInput" v-model="form.title" required maxlength="120" placeholder="例如：工作效率更新" /></label>
            <label class="release-notes">更新说明 / Changelog<textarea v-model="form.changelog" required rows="5" maxlength="30030" placeholder="每行一条更新说明，例如：&#10;新增文档图片上传&#10;优化工作台启动速度"></textarea><small>每行一条，共 1–30 条，每条最多 1000 字。多个平台共享同版本的说明。</small></label>
            <label v-if="published" class="check-label"><input v-model="form.enabled" type="checkbox" />在下载页与自动更新中提供此版本</label>
            <button class="button primary" :disabled="busy || (!dirty && !creating) || current?.published">{{ busy ? '处理中…' : published ? '保存版本信息' : '保存草稿' }}</button>
          </fieldset>
        </form>
        <section v-if="manifest" class="package-upload" aria-labelledby="package-heading">
          <div class="editor-heading">
            <div><h3 id="package-heading">3. 上传并校验安装包</h3><p>文件名、大小和 SHA-512 必须与下方清单一致。单文件最多 2 GiB。</p></div>
            <div v-if="current" class="admin-actions">
              <input ref="fileInput" class="file-input" type="file" accept=".exe,.zip,.dmg" multiple tabindex="-1" aria-label="选择软件包文件" :disabled="busy || dirty || current.published" @change="send" />
              <button class="button secondary" :disabled="busy || dirty || current.published" @click="fileInput?.click()">上传软件包</button>
              <button v-if="uploadName" class="button secondary" @click="upload?.abort()">取消上传</button>
            </div>
          </div>
          <p v-if="creating" class="editor-help">保存草稿后即可上传下列文件。版本和校验清单将锁定。</p>
          <div v-if="uploadName" class="upload-progress" role="status"><span>{{ uploadName }}</span><progress :value="progress" max="100"></progress>{{ progress }}% · {{ progress === 100 ? '正在校验保存…' : '上传中' }}</div>
          <article v-for="file in manifest.files" :key="file.name" class="package-file">
            <div><strong>{{ file.name }}</strong><small>{{ size(file.size) }} · {{ required(file.name) ? '必需' : '可选' }} · <span :class="{ 'package-verified': uploaded(file.name) }">{{ uploaded(file.name) ? '校验通过' : '待上传' }}</span></small><details><summary>预期 SHA-512</summary><code>{{ file.sha512 }}</code></details></div>
            <button v-if="uploaded(file.name) && !current?.published" :disabled="busy || dirty" @click="removeFile(file.name)">移除</button>
          </article>
          <p class="editor-help">请保留打包生成的原始文件名。只有清单中列出的文件才能上传；校验失败的文件不会保存。</p>
        </section>
        <template v-if="current">
          <template v-if="!manifest"><article v-for="file in current.files" :key="file.name" class="package-file"><div><strong>{{ file.name }}</strong><small>{{ size(file.size) }} · {{ current.published ? '已发布' : '待描述文件校验' }}</small></div><button v-if="!current.published" :disabled="busy || dirty" @click="removeFile(file.name)">移除</button></article></template>
          <div class="editor-bottom"><button :disabled="busy" @click="discard">移除草稿</button><button class="button primary" :disabled="busy || dirty || !manifest || !mainUploaded || current.published" @click="publish">{{ current.published ? '已发布' : '核对并发布' }}</button></div>
        </template>
        <template v-if="published">
          <div class="package-upload"><h3>已发布安装包</h3><p class="editor-help">安装包不可覆盖。如需替换，请创建新版本。</p></div>
          <article v-for="file in publishedFiles" :key="file.platform + file.name" class="package-file"><div><strong>{{ file.name }}</strong><small>{{ platformLabel(file.platform) }} · {{ size(file.size) }}</small><details><summary>SHA-512 校验和</summary><code>{{ file.sha512 }}</code></details></div><a v-if="published.enabled" :href="`/updates/archive/${published.version}/${file.platform}/${encodeURIComponent(file.name)}`" download>下载</a></article>
        </template>
      </section>
      <div v-else class="admin-empty">新建发布并导入描述文件，或选择左侧的草稿和版本。</div>
    </div>
    <WebsiteDialog v-if="confirmation" :title="confirmation.title" :message="confirmation.message" :confirm-label="confirmation.label" @cancel="confirmation = undefined" @confirm="accept"><div v-if="confirmation.label === '确认发布'" class="release-review"><h3>{{ current?.title }}</h3><ul><li v-for="note in current?.notes" :key="note">{{ note }}</li></ul><p v-for="file in current?.files" :key="file.name">{{ file.name }} · {{ size(file.size) }} · 校验通过</p></div></WebsiteDialog>
  </section>
</template>
