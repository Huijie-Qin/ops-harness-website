import { crc32, deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { GuideStore, encodeChapter } from '../server/guide-store.js'
import { MediaStore } from '../server/media-store.js'
import { ReleaseAdmin } from '../server/release-admin.js'
import { KnowledgeStore } from '../server/knowledge-store.js'
import { createAdminHandler } from '../server/admin-http.js'
import { createGuideHandler } from '../server/guide-http.js'
import { createHandler } from '../server/app.js'
import { maxSkillFileBytes, maxTypicalIndicators } from '../shared/knowledge.js'

// Minimal writer: local headers + central directory + EOCD, deflate only, no data descriptors.
function archive(files: { name: string; data?: Buffer }[]) {
  const locals: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'), plain = file.data ?? Buffer.alloc(0)
    const deflated = deflateRawSync(plain), crc = crc32(plain)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(plain.length, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28)
    const header = Buffer.concat([local, name, deflated])
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0, 8); record.writeUInt16LE(8, 10)
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(deflated.length, 20); record.writeUInt32LE(plain.length, 24)
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42)
    locals.push(header); central.push(Buffer.concat([record, name]))
    offset += header.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
const skillMarkdown = (name = 'metric-skill', description = '指标知识库配套技能，说明检索口径。') =>
  Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n\n# 使用说明\n\n先取卡片索引，再取口径。\n`, 'utf8')
function entry(extra: Record<string, unknown> = {}) {
  return {
    tenant_name: '示例零售', tenant_id: 'tenant-retail',
    knowledge_retrieve_workflow_id: { get_card_index: 'wf-card-index', get_card_meta: 'wf-card-meta', quer_card_data: 'wf-card-data' },
    knowledge_id: { card_index_knowledge_base: 'kb-card-index', card_meta_knowledge_base: 'kb-card-meta' },
    knowledge_base_meta: {
      knowledge_description: '零售业务的核心指标口径与报表说明。', indicators_cover: '1,200 项', reports_cover: '32 张', update_frequency: '每日 07:00',
      typical_indicators: ['GMV', '动销率'],
    },
    enabled: true, ...extra,
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'website-knowledge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'repository/content'), seed = path.join(source, 'guide')
  await mkdir(seed, { recursive: true })
  await writeFile(path.join(seed, 'one.md'), encodeChapter({ id: 'one', title: '入门', group: '入门', order: 10, summary: '', archived: false, markdown: '# 正文\n' }))
  const content = path.join(root, 'content')
  const guides = new GuideStore(seed, content), media = new MediaStore(content, source), releases = new ReleaseAdmin(path.join(root, 'releases'))
  const knowledge = new KnowledgeStore(content)
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const guide = await createGuideHandler(guides, { origin, password: 'test-admin-password-only', admin: createAdminHandler(releases, media, undefined, knowledge) })
  server.on('request', createHandler({ schemaVersion: 1, websiteUrl: origin, host: '127.0.0.1', port: 4173, releaseDirectory: releases.root, contentDirectory: content, adminPasswordEnv: 'DSH_OPS_WEBSITE_ADMIN_PASSWORD', configPath: 'test' },
    { clientRoot: root, knowledge, guide: async (req, res, url) => await media.serve(req, res, url) || await guide(req, res, url) }))
  const login = await fetch(origin + '/api/admin/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-admin-password-only' }) })
  const session = await login.json(), headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: origin, 'X-CSRF-Token': session.csrf }
  const json = (url: string, data: unknown, method = 'POST') => fetch(origin + url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const upload = (url: string, bytes: Buffer, extra: Record<string, string> = {}) =>
    fetch(origin + url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', ...extra }, body: bytes })
  const read = () => fetch(origin + '/api/admin/knowledge', { headers }).then(r => r.json())
  return { root, origin, content, headers, json, upload, read, knowledge }
}

test('knowledge entries are created, edited and removed under revision control and reject invalid input', async t => {
  const { json, read, knowledge, content } = await fixture(t)
  let state = await read()
  assert.deepEqual(state.items, []); assert.equal(state.schemaVersion, 1)
  assert.equal((await json('/api/admin/knowledge', { entry: entry(), revision: 'stale' })).status, 409)
  let response = await json('/api/admin/knowledge', { entry: entry(), revision: state.revision })
  assert.equal(response.status, 200)
  let created = await response.json()
  assert.match(created.entry.id, /^metrics-[a-f0-9]{10}$/)
  assert.equal(created.entry.knowledge_retrieve_workflow_id.quer_card_data, 'wf-card-data')
  assert.equal(created.entry.created_at, created.entry.updated_at)
  const id = created.entry.id
  assert.equal((await json('/api/admin/knowledge', { entry: entry({ id, tenant_id: 'tenant-other' }), revision: created.revision })).status, 409)
  assert.equal((await (await json('/api/admin/knowledge', { entry: entry({ id, tenant_id: 'tenant-other' }), revision: created.revision })).json()).error, 'KNOWLEDGE_ID_TAKEN')
  assert.equal((await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-second' }), revision: created.revision })).json()).error, 'TENANT_ID_TAKEN')
  for (const invalid of [entry({ id: 'Metrics-Bad' }), entry({ id: 'wrong-prefix' }), entry({ tenant_name: '' }), entry({ enabled: 'yes' }),
    entry({ knowledge_base_meta: { knowledge_description: '描述', typical_indicators: Array.from({ length: maxTypicalIndicators + 1 }, (_, i) => `指标${i}`) } }),
    entry({ knowledge_retrieve_workflow_id: { get_card_index: 'a', get_card_meta: 'b' } }), entry({ extra: true })]) {
    const rejected = await json('/api/admin/knowledge', { entry: invalid, revision: created.revision })
    assert.equal(rejected.status, 400); assert.equal((await rejected.json()).error, 'INVALID_KNOWLEDGE')
  }
  response = await json(`/api/admin/knowledge/${id}`, { entry: entry({ tenant_name: '示例零售集团', enabled: false }), revision: created.revision }, 'PUT')
  assert.equal(response.status, 200)
  const updated = await response.json()
  assert.equal(updated.entry.tenant_name, '示例零售集团'); assert.equal(updated.entry.enabled, false)
  assert.equal(updated.entry.created_at, created.entry.created_at)
  assert.notEqual(updated.revision, created.revision)
  assert.equal((await json(`/api/admin/knowledge/${id}`, { entry: entry(), revision: created.revision }, 'PUT')).status, 409)
  assert.equal((await (await json(`/api/admin/knowledge/${id}`, { entry: entry({ id: 'metrics-renamed' }), revision: updated.revision }, 'PUT')).json()).error, 'INVALID_KNOWLEDGE')
  assert.equal((await (await json('/api/admin/knowledge/metrics-missing', { entry: entry(), revision: updated.revision }, 'PUT')).json()).error, 'KNOWLEDGE_NOT_FOUND')
  assert.ok((await readdir(path.join(content, 'knowledge/.trash'))).some(name => /^catalog-.*\.json$/.test(name)))
  // A second store on the same directory reads the persisted state, including the revision.
  state = await new KnowledgeStore(content).list()
  assert.equal(state.revision, updated.revision); assert.equal(state.items.length, 1)
  assert.equal((await json(`/api/admin/knowledge/${id}`, { revision: created.revision }, 'DELETE')).status, 409)
  const removed = await json(`/api/admin/knowledge/${id}`, { revision: updated.revision }, 'DELETE')
  assert.equal(removed.status, 200); assert.equal((await removed.json()).revision, (await knowledge.list()).revision)
  assert.deepEqual((await read()).items, [])
})

test('the public catalog omits withdrawn entries, answers If-None-Match and never lists admin-only state', async t => {
  const { json, read, origin } = await fixture(t)
  const base = await read()
  const first = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: base.revision })).json()
  const second = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-hidden', tenant_id: 'tenant-hidden', enabled: false }), revision: first.revision })).json()
  const response = await fetch(origin + '/api/knowledge/metrics')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const etag = response.headers.get('etag')
  assert.equal(etag, `"${second.revision}"`)
  const catalog = await response.json()
  assert.equal(catalog.schemaVersion, 1); assert.equal(catalog.revision, second.revision)
  assert.deepEqual(catalog.items.map((item: { id: string }) => item.id), ['metrics-retail'])
  assert.deepEqual(catalog.items[0], first.entry)
  assert.equal(catalog.updatedAt, second.updatedAt)
  const cached = await fetch(origin + '/api/knowledge/metrics', { headers: { 'If-None-Match': etag! } })
  assert.equal(cached.status, 304); assert.equal(cached.headers.get('etag'), etag)
  assert.equal((await cached.text()).length, 0)
  assert.equal((await fetch(origin + '/api/knowledge/metrics', { headers: { 'If-None-Match': '"other"' } })).status, 200)
  assert.equal((await fetch(origin + '/api/knowledge/metrics', { method: 'POST' })).status, 405)
  assert.equal((await fetch(origin + '/api/knowledge/metrics/metrics-retail')).status, 404)
})

test('skill files are validated, stored by content hash and served to anonymous readers', async t => {
  const { json, upload, read, origin, content } = await fixture(t)
  const base = await read()
  let current = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: base.revision })).json()
  const api = '/api/admin/knowledge/metrics-retail/skill'
  assert.equal((await fetch(origin + '/api/knowledge/metrics/metrics-retail/skill')).status, 404)
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics/metrics-retail/skill')).json()).error, 'SKILL_NOT_FOUND')
  const packaged = archive([{ name: 'metric-skill/' }, { name: 'metric-skill/SKILL.md', data: skillMarkdown() }, { name: 'metric-skill/references/glossary.md', data: Buffer.from('# 词表\n') }])
  let response = await upload(`${api}?name=metric-skill.zip`, packaged, { 'X-Revision': current.revision })
  assert.equal(response.status, 200)
  current = await response.json()
  assert.equal(current.entry.skill.name, 'metric-skill')
  assert.equal(current.entry.skill.kind, 'zip')
  assert.equal(current.entry.skill.file_name, 'metric-skill.zip')
  assert.equal(current.entry.skill.size, packaged.length)
  assert.equal(current.entry.skill.sha256, createHash('sha256').update(packaged).digest('hex'))
  assert.deepEqual(await readdir(path.join(content, 'knowledge/skills')), [`${current.entry.skill.sha256}.zip`])
  const download = await fetch(origin + '/api/knowledge/metrics/metrics-retail/skill')
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'application/zip')
  assert.equal(download.headers.get('etag'), `"${current.entry.skill.sha256}"`)
  assert.equal(download.headers.get('x-skill-name'), 'metric-skill')
  assert.equal(download.headers.get('x-skill-sha256'), current.entry.skill.sha256)
  assert.equal(download.headers.get('cache-control'), 'no-store')
  assert.match(download.headers.get('content-disposition')!, /metric-skill\.zip$/)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), packaged)
  assert.equal((await fetch(origin + '/api/knowledge/metrics/metrics-retail/skill', { headers: { 'If-None-Match': `"${current.entry.skill.sha256}"` } })).status, 304)
  // A SKILL.md at the archive root is accepted, and identical bytes reuse the stored file.
  const previous = current.entry.skill.sha256
  const flat = archive([{ name: 'SKILL.md', data: skillMarkdown('flat-skill') }])
  current = await (await upload(`${api}?name=flat.zip`, flat, { 'X-Revision': current.revision })).json()
  assert.equal(current.entry.skill.name, 'flat-skill')
  // Replacing the file must be visible at once: the old validator no longer matches.
  const replaced = await fetch(origin + '/api/knowledge/metrics/metrics-retail/skill', { headers: { 'If-None-Match': `"${previous}"` } })
  assert.equal(replaced.status, 200)
  assert.equal(replaced.headers.get('etag'), `"${current.entry.skill.sha256}"`)
  assert.equal(replaced.headers.get('x-skill-name'), 'flat-skill')
  current = await (await upload(`${api}?name=again.zip`, flat, { 'X-Revision': current.revision })).json()
  assert.equal((await readdir(path.join(content, 'knowledge/skills'))).length, 2)
  const plain = skillMarkdown('plain-skill')
  current = await (await upload(`${api}?name=SKILL.md`, plain, { 'X-Revision': current.revision })).json()
  assert.equal(current.entry.skill.kind, 'md'); assert.equal(current.entry.skill.name, 'plain-skill')
  assert.equal((await fetch(origin + '/api/knowledge/metrics/metrics-retail/skill')).headers.get('content-type'), 'text/markdown; charset=utf-8')
  for (const [name, bytes] of [
    ['escape.zip', archive([{ name: '../SKILL.md', data: skillMarkdown() }])],
    ['backslash.zip', archive([{ name: 'metric-skill\\SKILL.md', data: skillMarkdown() }])],
    ['absent.zip', archive([{ name: 'metric-skill/README.md', data: Buffer.from('# 空\n') }])],
    ['twice.zip', archive([{ name: 'SKILL.md', data: skillMarkdown() }, { name: 'metric-skill/SKILL.md', data: skillMarkdown() }])],
    ['mismatch.zip', archive([{ name: 'other-name/SKILL.md', data: skillMarkdown('metric-skill') }])],
    ['sibling.zip', archive([{ name: 'metric-skill/SKILL.md', data: skillMarkdown() }, { name: 'extra/notes.md', data: Buffer.from('x') }])],
    ['deep.zip', archive([{ name: 'a/b/SKILL.md', data: skillMarkdown() }])],
    ['nameless.zip', archive([{ name: 'SKILL.md', data: Buffer.from('---\ndescription: 没有名称\n---\n') }])],
    ['blank.zip', archive([{ name: 'SKILL.md', data: Buffer.from('---\nname: metric-skill\ndescription: "  "\n---\n') }])],
    ['SKILL.md', Buffer.from('没有 frontmatter 的说明\n')],
    ['notes.txt', skillMarkdown()],
  ] as const) {
    const rejected = await upload(`${api}?name=${encodeURIComponent(name)}`, bytes, { 'X-Revision': current.revision })
    assert.equal(rejected.status, 400, name)
    assert.equal((await rejected.json()).error, 'INVALID_SKILL_FILE', name)
  }
  assert.equal((await upload(`${api}?name=big.md`, Buffer.alloc(maxSkillFileBytes + 1), { 'X-Revision': current.revision })).status, 413)
  assert.equal((await upload(`${api}?name=stale.md`, plain, { 'X-Revision': 'stale' })).status, 409)
  assert.equal((await upload(`/api/admin/knowledge/metrics-missing/skill?name=a.md`, plain, { 'X-Revision': current.revision })).status, 404)
  assert.ok(!(await readdir(path.join(content, 'knowledge/skills'))).some(name => name.endsWith('.upload')))
  current = await (await json('/api/admin/knowledge/metrics-retail/skill', { revision: current.revision }, 'DELETE')).json()
  assert.equal(current.entry.skill, undefined)
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics/metrics-retail/skill')).json()).error, 'SKILL_NOT_FOUND')
  assert.equal((await json('/api/admin/knowledge/metrics-retail/skill', { revision: current.revision }, 'DELETE')).status, 404)
  assert.equal((await json('/api/admin/knowledge/metrics-retail', { revision: current.revision }, 'DELETE')).status, 200)
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics/metrics-retail/skill')).json()).error, 'KNOWLEDGE_NOT_FOUND')
})

test('a skill upload with the wrong content type and a withdrawn entry are refused by the public reader', async t => {
  const { json, upload, read, origin, headers } = await fixture(t)
  const base = await read()
  const created = await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-retail' }), revision: base.revision })).json()
  const wrongType = await fetch(origin + '/api/admin/knowledge/metrics-retail/skill?name=a.md', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain', 'X-Revision': created.revision }, body: 'x',
  })
  assert.equal(wrongType.status, 415); assert.equal((await wrongType.json()).error, 'BINARY_REQUIRED')
  const attached = await (await upload('/api/admin/knowledge/metrics-retail/skill?name=SKILL.md', skillMarkdown(), { 'X-Revision': created.revision })).json()
  const hidden = await (await json('/api/admin/knowledge/metrics-retail', { entry: entry({ enabled: false }), revision: attached.revision }, 'PUT')).json()
  assert.equal(hidden.entry.skill.name, 'metric-skill')
  assert.equal((await (await fetch(origin + '/api/knowledge/metrics/metrics-retail/skill')).json()).error, 'KNOWLEDGE_NOT_FOUND')
  assert.deepEqual((await (await fetch(origin + '/api/knowledge/metrics')).json()).items, [])
})

test('knowledge administration rejects anonymous, cross-origin and missing CSRF requests', async t => {
  const { origin, headers } = await fixture(t)
  for (const route of ['/api/admin/knowledge', '/api/admin/knowledge/metrics-retail', '/api/admin/knowledge/metrics-retail/skill']) {
    assert.equal((await fetch(origin + route)).status, 401)
    assert.equal((await fetch(origin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
    for (const override of [{ 'X-CSRF-Token': '' }, { Origin: 'https://evil.example' }]) {
      assert.equal((await fetch(origin + route, { method: 'POST', headers: { ...headers, ...override, 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
    }
  }
})

test('a skill name may be used by only one knowledge entry in the catalog', async t => {
  const { json, upload, read } = await fixture(t)
  const first = (await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-first' }), revision: (await read()).revision })).json())
  const second = (await (await json('/api/admin/knowledge', { entry: entry({ id: 'metrics-second', tenant_id: 'tenant-second' }), revision: first.revision })).json())
  const zip = archive([{ name: 'shared-guide/SKILL.md', data: skillMarkdown('shared-guide') }])
  const attached = await upload('/api/admin/knowledge/metrics-first/skill?name=shared-guide.zip', zip, { 'X-Revision': second.revision })
  assert.equal(attached.status, 200)
  const duplicate = await upload('/api/admin/knowledge/metrics-second/skill?name=shared-guide.zip', zip, { 'X-Revision': (await attached.json()).revision })
  assert.equal(duplicate.status, 409)
  assert.equal((await duplicate.json()).error, 'SKILL_NAME_TAKEN')
})
