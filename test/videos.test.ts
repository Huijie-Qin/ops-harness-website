import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { VideoCatalog, VideoInput } from '../shared/videos.js'
import { maxVideoFileBytes } from '../shared/videos.js'
import { VideoStore } from '../server/videos-store.js'
import { createVideoHandler } from '../server/videos-http.js'
import { validateMp4 } from '../server/videos-mp4.js'
import { createAdminHandler } from '../server/admin-http.js'
import { createGuideHandler } from '../server/guide-http.js'
import { GuideStore, encodeChapter } from '../server/guide-store.js'
import { MediaStore } from '../server/media-store.js'
import { ReleaseAdmin } from '../server/release-admin.js'
import { createHandler } from '../server/app.js'

// Structural fixture, deliberately not described as a decodable/codec-validated movie.
function box(type: string, ...parts: Buffer[]) {
  const payload = Buffer.concat(parts), header = Buffer.alloc(8)
  header.writeUInt32BE(payload.length + 8); header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, payload])
}
function movie(handler = 'vide', sample = 'avc1') {
  const description = Buffer.alloc(8); description.writeUInt32BE(1, 4)
  const hdlr = Buffer.alloc(24); hdlr.write(handler, 8)
  const table = box('stbl', box('stsd', description, box(sample, Buffer.alloc(78))))
  const track = box('trak', box('mdia', box('hdlr', hdlr), box('minf', table)))
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isommp42', 'binary')),
    box('moov', box('mvhd', Buffer.alloc(100)), track),
    box('mdat', Buffer.from('sample media bytes')),
  ])
}
const mp4 = movie()
const entry = (extra: Partial<VideoInput> = {}): VideoInput => ({
  title: '工作助手宣传片', description: '介绍生产系统对接与技能市场。', category: 'product', status: 'draft',
  featured: false, coverUrl: '', durationSeconds: 0, ...extra,
})
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'website-videos-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), seed = path.join(source, 'guide'), content = path.join(root, 'content')
  await mkdir(seed, { recursive: true })
  await writeFile(path.join(seed, 'one.md'), encodeChapter({ id: 'one', title: '入门', group: '入门', order: 10, summary: '', archived: false, markdown: '# 正文\n' }))
  const videos = new VideoStore(content), guides = new GuideStore(seed, content), media = new MediaStore(content, source)
  const releases = new ReleaseAdmin(path.join(root, 'releases'))
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const guide = await createGuideHandler(guides, { origin, password: 'test-password', admin: createAdminHandler(releases, media, undefined, undefined, undefined, videos) })
  const video = createVideoHandler(videos)
  server.on('request', createHandler({ schemaVersion: 1, websiteUrl: origin, host: '127.0.0.1', port: 4173, releaseDirectory: releases.root, contentDirectory: content, adminPasswordEnv: 'TEST_PASSWORD', configPath: 'test' },
    { clientRoot: root, guide: async (req, res, url) => await video(req, res, url) || await guide(req, res, url) }))
  const login = await fetch(origin + '/api/admin/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) })
  const session = await login.json(), headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: origin, 'X-CSRF-Token': session.csrf }
  const json = (url: string, data: unknown, method = 'POST', override: Record<string, string> = {}) => fetch(origin + url, {
    method, headers: { ...headers, 'Content-Type': 'application/json', ...override }, body: JSON.stringify(data),
  })
  const upload = (id: string, revision: string, bytes = mp4, extra: Record<string, string> = {}, name = '工作助手宣传片.mp4') => fetch(`${origin}/api/admin/videos/${id}/file?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Revision': revision, 'X-Video-Duration': '52.01', ...extra }, body: bytes,
  })
  const read = (): Promise<VideoCatalog> => fetch(origin + '/api/admin/videos', { headers }).then(r => r.json())
  async function create(extra: Partial<VideoInput> = {}) {
    const before = await read(), response = await json('/api/admin/videos', { entry: entry(extra), revision: before.revision })
    assert.equal(response.status, 200)
    const state: VideoCatalog = await response.json()
    return { state, id: state.items.find(item => !before.items.some(old => old.id === item.id))!.id }
  }
  return { root, origin, content, videos, headers, json, upload, read, create }
}

test('video catalog validates inputs, persists drafts, and publishes only uploaded metadata', async t => {
  const { read, json, create, upload, content, videos } = await fixture(t)
  const initial = await read()
  assert.deepEqual(initial.items, [])
  assert.equal((await json('/api/admin/videos', { entry: entry(), revision: 'stale' })).status, 409)
  for (const input of [entry({ title: '' }), entry({ title: 'a'.repeat(121) }), entry({ category: 'bad' as 'product' }), entry({ durationSeconds: -1 }),
    entry({ coverUrl: 'https://example.org/cover.png' }), entry({ coverUrl: '/assets/product/../secret.png' }), entry({ coverUrl: '/assets/product/%2e%2e.png' }),
    entry({ coverUrl: 'javascript:alert(1)' }), { ...entry(), extra: true }]) {
    const response = await json('/api/admin/videos', { entry: input, revision: initial.revision })
    assert.equal(response.status, 400); assert.equal((await response.json()).error, 'INVALID_VIDEO')
  }
  assert.equal((await (await json('/api/admin/videos', { entry: entry({ status: 'published', durationSeconds: 52 }), revision: initial.revision })).json()).error, 'VIDEO_FILE_REQUIRED')
  let { state, id } = await create({ featured: true })
  assert.equal(state.items[0]!.featured, false)
  assert.equal((await json(`/api/admin/videos/${id}`, { entry: entry({ title: '修改' }), revision: initial.revision }, 'PUT')).status, 409)
  const uploaded = await upload(id, state.revision)
  assert.equal(uploaded.status, 200)
  state = await uploaded.json()
  const stored = state.items[0]!
  assert.equal(stored.durationSeconds, 52.01)
  assert.equal(stored.video!.sha256, createHash('sha256').update(mp4).digest('hex'))
  assert.equal(stored.video!.size, mp4.length)
  assert.equal(stored.video!.contentType, 'video/mp4')
  assert.equal((await new VideoStore(content).list()).revision, state.revision)
  assert.deepEqual(await readFile(path.join(videos.files, stored.video!.sha256 + '.mp4')), mp4)
  const published = await json(`/api/admin/videos/${id}`, { entry: entry({ status: 'published', featured: true, durationSeconds: 52.01 }), revision: state.revision }, 'PUT')
  assert.equal(published.status, 200)
  state = await published.json()
  assert.equal(state.items[0]!.status, 'published')
  const replacement = await upload(id, state.revision)
  assert.equal(replacement.status, 409); assert.equal((await replacement.json()).error, 'VIDEO_MUST_BE_DRAFT')
})

test('draft previews require authentication; mutations require same-origin CSRF; authenticated HEAD is read-only', async t => {
  const { origin, headers, json, upload, create } = await fixture(t)
  let { state, id } = await create()
  for (const url of ['/api/admin/videos', `/api/admin/videos/${id}/preview`]) assert.equal((await fetch(origin + url)).status, 401)
  const unauthorized = await fetch(`${origin}/api/admin/videos/${id}/file?name=x.mp4`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Revision': state.revision }, body: mp4 })
  assert.equal(unauthorized.status, 401)
  assert.equal((await json('/api/admin/videos', { entry: entry(), revision: state.revision }, 'POST', { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await upload(id, state.revision, mp4, { 'X-CSRF-Token': '' })).status, 403)
  assert.equal((await upload(id, state.revision, mp4, { Origin: 'https://attacker.invalid' })).status, 403)
  state = await (await upload(id, state.revision)).json()
  const url = state.items[0]!.video!.url
  assert.deepEqual((await (await fetch(origin + '/api/videos')).json()).items, [])
  assert.equal((await fetch(origin + url)).status, 404)
  assert.equal((await fetch(origin + url, { method: 'HEAD' })).status, 404)
  const preview = await fetch(`${origin}/api/admin/videos/${id}/preview`, { headers: { Cookie: headers.Cookie, Range: 'bytes=0-15' } })
  assert.equal(preview.status, 206); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), mp4.subarray(0, 16))
  const head = await fetch(`${origin}/api/admin/videos/${id}/preview`, { method: 'HEAD', headers: { Cookie: headers.Cookie } })
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(mp4.length)); assert.equal(await head.text(), '')
  assert.equal((await fetch(`${origin}/api/admin/videos/${id}/preview`, { method: 'HEAD' })).status, 401)
})

test('published files support full GET, HEAD, single ranges and reject unsafe or unsatisfiable routes', async t => {
  const { create, upload, json, origin } = await fixture(t)
  let { state, id } = await create()
  state = await (await upload(id, state.revision)).json()
  state = await (await json(`/api/admin/videos/${id}`, { entry: entry({ status: 'published', durationSeconds: 52.01 }), revision: state.revision }, 'PUT')).json()
  const url = origin + state.items[0]!.video!.url
  const all = await fetch(url)
  assert.equal(all.status, 200); assert.equal(all.headers.get('content-type'), 'video/mp4'); assert.equal(all.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await all.arrayBuffer()), mp4)
  for (const [range, start, end] of [['bytes=0-15', 0, 15], ['bytes=16-', 16, mp4.length - 1], ['bytes=-8', mp4.length - 8, mp4.length - 1], ['bytes=0-999999', 0, mp4.length - 1]] as const) {
    const response = await fetch(url, { headers: { Range: range } })
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${mp4.length}`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4.subarray(start, end + 1))
  }
  const head = await fetch(url, { method: 'HEAD', headers: { Range: 'bytes=4-7' } })
  assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '4'); assert.equal(await head.text(), '')
  for (const range of [`bytes=${mp4.length}-`, 'bytes=6-2', 'bytes=0-1,4-5', 'bytes=-0', 'bytes=x-y']) {
    const response = await fetch(url, { headers: { Range: range } })
    assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), `bytes */${mp4.length}`)
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
  for (const route of ['/videos/catalog.json', '/videos/.uploads/a.upload', '/videos/%2e%2e%2ffile.mp4']) assert.equal((await fetch(origin + route)).status, 404)
})

test('featured publication is unique; withdrawal and soft deletion immediately revoke unreferenced public files', async t => {
  const { create, upload, json, read, origin, content } = await fixture(t)
  const first = await create()
  let state: VideoCatalog = await (await upload(first.id, first.state.revision)).json()
  state = await (await json(`/api/admin/videos/${first.id}`, { entry: entry({ status: 'published', featured: true, durationSeconds: 52.01 }), revision: state.revision }, 'PUT')).json()
  const second = await create({ category: 'feature' })
  state = await (await upload(second.id, second.state.revision)).json()
  state = await (await json(`/api/admin/videos/${second.id}`, { entry: entry({ status: 'published', featured: true, durationSeconds: 52.01 }), revision: state.revision }, 'PUT')).json()
  assert.deepEqual(state.items.filter(item => item.featured).map(item => item.id), [second.id])
  const url = origin + state.items[0]!.video!.url, etag = `"${state.items[0]!.video!.sha256}"`
  const publicCatalog = await (await fetch(origin + '/api/videos')).json()
  assert.equal(publicCatalog.items.length, 2)
  state = await (await json(`/api/admin/videos/${second.id}`, { entry: entry({ featured: true, durationSeconds: 52.01 }), revision: state.revision }, 'PUT')).json()
  assert.equal(state.items.find(item => item.id === second.id)!.featured, false)
  assert.equal((await fetch(url)).status, 200) // first published entry still references the deduplicated file
  state = await (await json(`/api/admin/videos/${first.id}`, { revision: state.revision }, 'DELETE')).json()
  assert.equal((await fetch(url, { headers: { 'If-None-Match': etag } })).status, 404)
  assert.deepEqual((await (await fetch(origin + '/api/videos')).json()).items, [])
  assert.equal(state.items.length, 1); assert.equal((await read()).revision, state.revision)
  const trash = path.join(content, 'videos/.trash'), entries = await readdir(trash)
  const removed = entries.find(name => name.startsWith(first.id))!
  assert.equal(JSON.parse(await readFile(path.join(trash, removed), 'utf8')).id, first.id)
  assert.equal((await readdir(path.join(content, 'videos/files'))).length, 1)
})

test('invalid, oversized, or encoded uploads preserve the old file and duration and clean temporary files', async t => {
  const { create, upload, read, origin, headers, content } = await fixture(t)
  let { state, id } = await create()
  state = await (await upload(id, state.revision)).json()
  for (const bytes of [Buffer.from('not an mp4'), mp4.subarray(0, mp4.length - 2), movie('soun'), movie('vide', 'encv')]) {
    const rejected = await upload(id, state.revision, bytes, { 'X-Video-Duration': '90' })
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).error, 'INVALID_MP4')
  }
  assert.equal((await upload(id, state.revision, mp4, {}, '../escape.mp4')).status, 400)
  assert.equal((await upload(id, state.revision, mp4, { 'X-Video-Duration': 'Infinity' })).status, 400)
  assert.equal((await upload(id, state.revision, mp4, { 'Content-Encoding': 'gzip' })).status, 415)
  const oversized = await new Promise<number>((resolve, reject) => {
    const req = request(`${origin}/api/admin/videos/${id}/file?name=big.mp4`, { method: 'POST', headers: {
      ...headers, 'Content-Type': 'application/octet-stream', 'X-Revision': state.revision, 'Content-Length': String(maxVideoFileBytes + 1),
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
    req.on('error', reject); req.end()
  })
  assert.equal(oversized, 413)
  assert.deepEqual(await read(), state)
  assert.deepEqual(await readdir(path.join(content, 'videos/.uploads')), [])
})

async function eventually(action: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await action()) return; await delay(10) }
  assert.fail('condition was not reached within one second')
}

test('interrupted and stale in-flight uploads are cleaned and cannot overwrite a newer catalog', async t => {
  const { create, read, json, origin, headers, content } = await fixture(t)
  const { state, id } = await create(), temp = path.join(content, 'videos/.uploads')
  const exists = async () => (await readdir(temp).catch(() => [])).length > 0
  const options = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Revision': state.revision, 'X-Video-Duration': '52' } }
  const interrupted = request(`${origin}/api/admin/videos/${id}/file?name=aborted.mp4`, options)
  interrupted.on('error', () => {}); interrupted.write(mp4.subarray(0, 24))
  await eventually(exists)
  interrupted.destroy()
  await eventually(async () => !await exists())
  assert.deepEqual(await read(), state)

  let finish!: () => void
  const response = new Promise<number>((resolve, reject) => {
    const req = request(`${origin}/api/admin/videos/${id}/file?name=stale.mp4`, options, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
    req.on('error', reject); req.write(mp4.subarray(0, 24)); finish = () => req.end(mp4.subarray(24))
  })
  await eventually(exists)
  const updated = await json(`/api/admin/videos/${id}`, { entry: entry({ title: '另一管理员已保存' }), revision: state.revision }, 'PUT')
  assert.equal(updated.status, 200)
  const next = await updated.json()
  finish(); assert.equal(await response, 409)
  await eventually(async () => !await exists())
  assert.deepEqual(await read(), next)
  assert.equal((await read()).items[0]!.video, undefined)
})

test('MP4 parser rejects oversized boxes, unsupported containers and malformed sample tables without decoding', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'website-mp4-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'candidate.mp4')
  await writeFile(file, mp4); await validateMp4(file)
  const badBrand = Buffer.from(mp4); badBrand.fill(0, 8, 24)
  const badLength = Buffer.from(mp4); badLength.writeUInt32BE(0xffffffff, 0)
  const badSample = Buffer.from(mp4); badSample.writeUInt32BE(99, badSample.indexOf('stsd') + 8)
  for (const bytes of [badBrand, badLength, badSample, Buffer.concat([mp4, Buffer.from([0])])]) {
    await writeFile(file, bytes)
    await assert.rejects(validateMp4(file), { code: 'INVALID_MP4' })
  }
})

test('busy storage and corrupt catalogs fail closed without overwriting the persisted content', async t => {
  const { create, json, origin, headers, videos, read } = await fixture(t)
  const { state, id } = await create()
  const lock = path.join(videos.root, '.videos-lock'), file = path.join(videos.root, 'catalog.json')
  await writeFile(lock, '')
  const busy = await json(`/api/admin/videos/${id}`, { entry: entry({ title: '不得覆盖' }), revision: state.revision }, 'PUT')
  assert.equal(busy.status, 409); assert.equal((await busy.json()).error, 'CONTENT_BUSY')
  await unlink(lock)
  assert.deepEqual(await read(), state)
  const unsafe = JSON.stringify({ schemaVersion: 1, items: [{ ...state.items[0], coverUrl: 'https://external.invalid/track.png' }] })
  await writeFile(file, unsafe)
  for (const route of ['/api/videos', '/api/admin/videos']) {
    const response = await fetch(origin + route, { headers })
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'CONTENT_UNAVAILABLE')
  }
  assert.equal(await readFile(file, 'utf8'), unsafe)
})

test('publication and deduplicated uploads reject same-size disk corruption and preserve the draft', async t => {
  const { create, upload, json, read, videos } = await fixture(t)
  let { state, id } = await create()
  state = await (await upload(id, state.revision)).json()
  const damaged = Buffer.from(mp4); damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1
  await writeFile(path.join(videos.files, `${state.items[0]!.video!.sha256}.mp4`), damaged)
  const response = await json(`/api/admin/videos/${id}`, { entry: entry({ status: 'published', durationSeconds: 52.01 }), revision: state.revision }, 'PUT')
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'CONTENT_UNAVAILABLE')
  assert.equal((await upload(id, state.revision)).status, 503)
  assert.deepEqual(await read(), state)
})
