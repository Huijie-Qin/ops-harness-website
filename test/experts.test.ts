import { crc32, deflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { GuideStore, encodeChapter } from '../server/guide-store.js'
import { MediaStore } from '../server/media-store.js'
import { ReleaseAdmin } from '../server/release-admin.js'
import { KnowledgeStore } from '../server/knowledge-store.js'
import { ExpertStore } from '../server/expert-store.js'
import { createAdminHandler } from '../server/admin-http.js'
import { createGuideHandler } from '../server/guide-http.js'
import { createHandler } from '../server/app.js'

// Deflate-only ZIP writer: local headers + central directory + EOCD, no data descriptors.
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
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const skillZip = (name: string, body = '按步骤撰写推送文案。') => archive([{ name: `${name}/SKILL.md`, data: Buffer.from(`---\nname: ${name}\ndescription: ${name} 的说明\n---\n\n# 用法\n\n${body}\n`, 'utf8') }])
const owner = { name: '张三', employeeId: 'z00123456' }

function draft(extra: Record<string, unknown> = {}) {
  return {
    name: '推送运营助手', summary: '策划推送活动、撰写文案并复盘效果。',
    appearance: { icon: 'megaphone', accent: '#2F6BFF', background: '#EEF3FF' },
    categoryIds: ['push'], tags: ['推送'], starterPrompts: ['帮我策划一次周末促活推送'], sortOrder: 1000,
    builtinTools: ['shell', 'filesystem'], responsibility: '# 推送运营助手\n\n负责策划推送活动。\n',
    skills: [], tools: [{ toolId: 'webfetch', required: true }],
    knowledge: [{ kind: 'onebox', ref: 'handbook', name: '推送运营手册', required: false }],
    owner, ...extra,
  }
}

function expertPackage(options: { definition?: Record<string, unknown>; responsibility?: string; skills?: Array<{ name: string; bytes: Buffer }>; tamper?: (files: { name: string; data: Buffer }[]) => void; origin?: Record<string, unknown> } = {}) {
  const skills = options.skills ?? [{ name: 'push-copywriting', bytes: skillZip('push-copywriting') }]
  const responsibility = Buffer.from(options.responsibility ?? '# 推送运营助手\n\n负责策划推送活动、撰写文案。\n', 'utf8')
  const definition = {
    name: '推送运营助手', summary: '策划推送活动、撰写文案并复盘效果。',
    appearance: { icon: 'megaphone', accent: '#2F6BFF', background: '#EEF3FF' },
    categoryIds: ['push'], tags: ['推送'], starterPrompts: ['帮我策划一次周末促活推送'],
    builtinTools: ['shell', 'filesystem'],
    skills: skills.map(skill => ({ name: skill.name, required: true, file: `skills/${skill.name}.zip`, sha256: sha(skill.bytes), size: skill.bytes.length })),
    tools: [{ toolId: 'webfetch', required: true }],
    customTools: [],
    knowledge: [
      { kind: 'onebox', ref: 'handbook', name: '推送运营手册', spaceId: '7100123', required: true },
      { kind: 'onebox', ref: 'review', name: '活动复盘库', required: false },
    ],
    owner, suggestedAllowlist: ['s00526367'],
    ...options.definition,
  }
  const definitionBytes = Buffer.from(JSON.stringify(definition), 'utf8')
  const files = [
    { name: 'expert.json', data: definitionBytes },
    { name: 'AGENTS.md', data: responsibility },
    ...skills.map(skill => ({ name: `skills/${skill.name}.zip`, data: skill.bytes })),
  ]
  const manifest = {
    format: 'dsh-ops-expert-package', schemaVersion: 1, exportedAt: '2026-09-26T08:00:00.000Z', appVersion: '0.1.0',
    origin: { expertId: 'product-default-custom-a1b2c3', employeeId: 'z00123456', ...options.origin },
    files: files.map(file => ({ path: file.name, size: file.data.length, sha256: sha(file.data) })),
  }
  const all = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') }, ...files]
  options.tamper?.(all)
  return archive(all)
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'website-experts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'repository/content'), seed = path.join(source, 'guide')
  await mkdir(seed, { recursive: true })
  await writeFile(path.join(seed, 'one.md'), encodeChapter({ id: 'one', title: '入门', group: '入门', order: 10, summary: '', archived: false, markdown: '# 正文\n' }))
  const content = path.join(root, 'content')
  const guides = new GuideStore(seed, content), media = new MediaStore(content, source), releases = new ReleaseAdmin(path.join(root, 'releases'))
  const knowledge = new KnowledgeStore(content)
  const experts = new ExpertStore(content, knowledge)
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const guide = await createGuideHandler(guides, { origin, password: 'test-admin-password-only', admin: createAdminHandler(releases, media, undefined, knowledge, experts) })
  server.on('request', createHandler({ schemaVersion: 1, websiteUrl: origin, host: '127.0.0.1', port: 4173, releaseDirectory: releases.root, contentDirectory: content, adminPasswordEnv: 'DSH_OPS_WEBSITE_ADMIN_PASSWORD', configPath: 'test' },
    { clientRoot: root, knowledge, experts, guide: async (req, res, url) => await media.serve(req, res, url) || await guide(req, res, url) }))
  const login = await fetch(origin + '/api/admin/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-admin-password-only' }) })
  const session = await login.json(), headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: origin, 'X-CSRF-Token': session.csrf }
  const json = (url: string, data: unknown, method = 'POST') => fetch(origin + url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const upload = (url: string, bytes: Buffer, extra: Record<string, string> = {}) =>
    fetch(origin + url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', ...extra }, body: bytes })
  const list = () => fetch(origin + '/api/admin/experts', { headers }).then(r => r.json())
  const catalog = (employee?: string, extra: Record<string, string> = {}) => fetch(origin + '/api/experts/v1/catalog', { headers: { ...(employee ? { 'X-Ops-Employee-Id': employee } : {}), ...extra } })
  return { root, origin, content, headers, json, upload, list, catalog, experts }
}

async function createPublished(f: Awaited<ReturnType<typeof fixture>>, visibility: unknown = { mode: 'allowlist', employeeIds: ['s00526367'] }) {
  const created = await f.json('/api/admin/experts', { id: 'push-ops', draft: draft(), revision: (await f.list()).revision })
  assert.equal(created.status, 200)
  let { revision } = await created.json()
  const skill = await f.upload('/api/admin/experts/push-ops/skills?name=push-copywriting.zip', skillZip('push-copywriting'), { 'X-Revision': revision })
  assert.equal(skill.status, 200); revision = (await skill.json()).revision
  const published = await f.json('/api/admin/experts/push-ops/publish', { revision })
  assert.equal(published.status, 200); revision = (await published.json()).revision
  const distributed = await f.json('/api/admin/experts/push-ops/distribution', { revision, distribution: { status: 'active', visibility, allowClone: true } }, 'PUT')
  assert.equal(distributed.status, 200)
  return (await distributed.json()).revision as string
}

test('drafts are validated, published immutably and versioned', async t => {
  const f = await fixture(t)
  const initial = await f.list()
  assert.deepEqual(initial.experts, [])
  const bad = await f.json('/api/admin/experts', { draft: { ...draft(), appearance: { icon: 'nope' } }, revision: initial.revision })
  assert.equal(bad.status, 400)
  assert.equal((await bad.json()).error, 'INVALID_EXPERT')
  const reserved = await f.json('/api/admin/experts', { id: 'import', draft: draft(), revision: initial.revision })
  assert.equal(reserved.status, 409)
  const created = await f.json('/api/admin/experts', { id: 'push-ops', draft: draft({ responsibility: '' }), revision: initial.revision })
  assert.equal(created.status, 200)
  const body = await created.json()
  assert.equal(body.expert.presetId, 'cloud-push-ops')
  assert.equal(body.expert.distribution.status, 'disabled')
  const stale = await f.json('/api/admin/experts/push-ops', { draft: draft(), revision: initial.revision }, 'PUT')
  assert.equal(stale.status, 409)
  const unpublishable = await f.json('/api/admin/experts/push-ops/publish', { revision: body.revision })
  assert.equal(unpublishable.status, 400)
  assert.match((await unpublishable.json()).issues.join(), /职责不能为空/)
  const saved = await f.json('/api/admin/experts/push-ops', { draft: draft(), revision: body.revision }, 'PUT')
  const { revision } = await saved.json()
  const smuggled = await f.json('/api/admin/experts/push-ops', { draft: draft({ skills: [{ name: 'x', sha256: 'a'.repeat(64), size: 1, kind: 'zip', required: true }] }), revision }, 'PUT')
  assert.equal(smuggled.status, 400)
  const published = await f.json('/api/admin/experts/push-ops/publish', { revision })
  assert.equal(published.status, 200)
  const after = await published.json()
  assert.equal(after.expert.published.version, 1)
  assert.equal(after.expert.distribution.status, 'active')
  assert.equal(after.expert.draftChanged, false)
  const again = await f.json('/api/admin/experts/push-ops/publish', { revision: after.revision })
  assert.equal(again.status, 409)
  assert.equal((await again.json()).error, 'NOTHING_TO_PUBLISH')
  assert.deepEqual(await readdir(path.join(f.content, 'experts', 'versions', 'push-ops')), ['1.json'])
})

test('the catalog and downloads only reach visible employees', async t => {
  const f = await fixture(t)
  await createPublished(f)
  const anonymous = await (await f.catalog()).json()
  assert.deepEqual(anonymous.experts, [])
  assert.equal(anonymous.identity.recognized, false)
  const listed = await f.catalog('S00526367')
  assert.equal(listed.status, 200)
  assert.equal(listed.headers.get('vary'), 'X-Ops-Employee-Id')
  const entry = (await listed.json()).experts[0]
  assert.equal(entry.id, 'push-ops')
  assert.equal(entry.presetId, 'cloud-push-ops')
  assert.equal(entry.owner.employeeId, 'z00123456')
  assert.equal(entry.skills[0].name, 'push-copywriting')
  assert.deepEqual((await (await f.catalog('z00123456')).json()).experts.map((item: { id: string }) => item.id), ['push-ops'])
  assert.deepEqual((await (await f.catalog('x00000001')).json()).experts, [])
  const etag = listed.headers.get('etag')!
  assert.equal((await f.catalog('s00526367', { 'If-None-Match': etag })).status, 304)
  assert.notEqual((await f.catalog('z00123456')).headers.get('etag'), etag)
  assert.equal((await f.catalog('s00526367', { Origin: 'http://evil.example' })).status, 403)
  assert.equal((await f.catalog('bad id!')).status, 400)

  const responsibility = await fetch(f.origin + '/api/experts/v1/experts/push-ops/versions/1/responsibility', { headers: { 'X-Ops-Employee-Id': 's00526367' } })
  assert.equal(responsibility.status, 200)
  const text = await responsibility.text()
  assert.match(text, /负责策划推送活动/)
  assert.equal(`"${sha(Buffer.from(text, 'utf8'))}"`, responsibility.headers.get('etag'))
  assert.equal(entry.responsibility.sha256, sha(Buffer.from(text, 'utf8')))
  const skill = await fetch(f.origin + '/api/experts/v1/experts/push-ops/versions/1/skills/push-copywriting', { headers: { 'X-Ops-Employee-Id': 's00526367' } })
  assert.equal(skill.status, 200)
  assert.equal(sha(Buffer.from(await skill.arrayBuffer())), entry.skills[0].sha256)
  for (const [url, employee] of [
    ['/api/experts/v1/experts/push-ops/versions/1/responsibility', 'x00000001'],
    ['/api/experts/v1/experts/push-ops/versions/1/skills/push-copywriting', undefined],
    ['/api/experts/v1/experts/push-ops/versions/2/responsibility', 's00526367'],
    ['/api/experts/v1/experts/push-ops/versions/1/skills/other', 's00526367'],
  ] as const) {
    const response = await fetch(f.origin + url, { headers: employee ? { 'X-Ops-Employee-Id': employee } : {} })
    assert.equal(response.status, 404, url)
  }
})

test('taking an expert off sale or narrowing the allowlist applies immediately', async t => {
  const f = await fixture(t)
  const revision = await createPublished(f, { mode: 'everyone' })
  assert.equal((await (await f.catalog()).json()).experts.length, 1)
  const narrowed = await f.json('/api/admin/experts/push-ops/distribution', { revision, distribution: { status: 'active', visibility: { mode: 'allowlist', employeeIds: [] }, allowClone: false } }, 'PUT')
  const next = (await narrowed.json()).revision
  assert.equal((await (await f.catalog()).json()).experts.length, 0)
  const ownerView = (await (await f.catalog('z00123456')).json()).experts
  assert.equal(ownerView.length, 1)
  assert.equal(ownerView[0].allowClone, false)
  await f.json('/api/admin/experts/push-ops/distribution', { revision: next, distribution: { status: 'disabled', visibility: { mode: 'everyone' }, allowClone: true } }, 'PUT')
  assert.equal((await (await f.catalog('z00123456')).json()).experts.length, 0)
  assert.equal((await fetch(f.origin + '/api/experts/v1/experts/push-ops/versions/1/responsibility', { headers: { 'X-Ops-Employee-Id': 'z00123456' } })).status, 404)
})

test('an expert package imports as a draft and matches its origin on re-import', async t => {
  const f = await fixture(t)
  const uploaded = await f.upload('/api/admin/experts/import', expertPackage())
  assert.equal(uploaded.status, 200)
  const { preview } = await uploaded.json()
  assert.equal(preview.target.mode, 'create')
  assert.equal(preview.expert.owner.employeeId, 'z00123456')
  assert.deepEqual(preview.skills.map((item: { name: string }) => item.name), ['push-copywriting'])
  assert.deepEqual(preview.errors, [])
  assert.ok(preview.warnings.some((warning: string) => warning.includes('活动复盘库')))
  assert.deepEqual(preview.suggestedAllowlist, ['s00526367'])
  const applied = await f.json(`/api/admin/experts/import/${preview.importId}/apply`, { target: { mode: 'create', id: 'push-ops' }, adoptAllowlist: true, publish: true, revision: (await f.list()).revision })
  assert.equal(applied.status, 200)
  const expert = (await applied.json()).expert
  assert.equal(expert.published.version, 1)
  assert.deepEqual(expert.distribution.visibility, { mode: 'allowlist', employeeIds: ['s00526367'] })
  assert.equal(expert.importedFrom.expertId, 'product-default-custom-a1b2c3')
  assert.equal((await (await f.catalog('s00526367')).json()).experts[0].knowledge[0].spaceId, '7100123')
  assert.equal((await fetch(`${f.origin}/api/admin/experts/import/${preview.importId}`, { headers: f.headers })).status, 404)

  const second = await (await f.upload('/api/admin/experts/import', expertPackage({ responsibility: '# 推送运营助手\n\n新版职责。\n', skills: [{ name: 'push-review', bytes: skillZip('push-review') }] }))).json()
  assert.deepEqual(second.preview.target, { mode: 'update', id: 'push-ops' })
  assert.equal(second.preview.changes.responsibility, true)
  assert.deepEqual(second.preview.changes.skills, { added: ['push-review'], removed: ['push-copywriting'], updated: [] })
  const update = await f.json(`/api/admin/experts/import/${second.preview.importId}/apply`, { target: second.preview.target, revision: (await f.list()).revision })
  const updated = (await update.json()).expert
  assert.equal(updated.published.version, 1)
  assert.equal(updated.draftChanged, true)
  assert.match(updated.draft.responsibility, /新版职责/)
})

test('tampered, foreign or unsupported packages are rejected with reasons', async t => {
  const f = await fixture(t)
  const rejected = async (bytes: Buffer) => {
    const response = await f.upload('/api/admin/experts/import', bytes)
    assert.equal(response.status, 400)
    return (await response.json()) as { error: string; issues?: string[] }
  }
  const corrupted = await rejected(expertPackage({ tamper: files => { files[2]!.data = Buffer.from('# 被改过的职责\n', 'utf8') } }))
  assert.equal(corrupted.error, 'INVALID_EXPERT_PACKAGE')
  assert.match(corrupted.issues!.join(), /AGENTS\.md/)
  const extra = await rejected(expertPackage({ tamper: files => { files.push({ name: 'evil.exe', data: Buffer.from('MZ') }) } }))
  assert.match(extra.issues!.join(), /evil\.exe/)
  assert.equal((await rejected(archive([{ name: '../escape.json', data: Buffer.from('{}') }]))).error, 'INVALID_EXPERT_PACKAGE')
  const wrongSkill = await rejected(expertPackage({ skills: [{ name: 'push-copywriting', bytes: skillZip('other-name') }] }))
  assert.match(wrongSkill.issues!.join(), /push-copywriting/)
  // A custom tool that would carry a secret or a machine path never gets past the package check.
  const secret = await rejected(expertPackage({ definition: {
    tools: [{ customTool: 'crm-query', required: true }],
    customTools: [crmTool({ headers: { Authorization: 'Bearer sk-live-123' }, credentials: [] })],
  } }))
  assert.match(secret.issues!.join(), /Authorization/)
  const localCommand = await rejected(expertPackage({ definition: {
    tools: [{ customTool: 'files', required: true }],
    customTools: [{ key: 'files', name: '文件', transport: 'stdio', serverName: 'files', command: 'C:\\tools\\files.exe', credentials: [] }],
  } }))
  assert.match(localCommand.issues!.join(), /本机文件路径/)
  const missingMetric = await f.upload('/api/admin/experts/import', expertPackage({ definition: { knowledge: [{ kind: 'metric', knowledgeId: 'metrics-none', required: true }] } }))
  const preview = (await missingMetric.json()).preview
  assert.ok(preview.errors.some((error: string) => error.includes('metrics-none')))
  const refused = await f.json(`/api/admin/experts/import/${preview.importId}/apply`, { target: preview.target, revision: (await f.list()).revision })
  assert.equal(refused.status, 400)
  assert.equal((await refused.json()).error, 'EXPERT_PACKAGE_REJECTED')
  const discarded = await fetch(`${f.origin}/api/admin/experts/import/${preview.importId}`, { method: 'DELETE', headers: f.headers })
  assert.equal(discarded.status, 200)
})

function crmTool(extra: Record<string, unknown> = {}) {
  return {
    key: 'crm-query', name: 'CRM 查询', transport: 'streamable-http', serverName: 'crm', url: 'https://crm.example.internal/mcp',
    headers: { 'X-Api-Key': '{{credential:api-key}}', 'X-Tenant-Id': 'acme' },
    credentials: [{ key: 'api-key', label: 'CRM 访问令牌', location: { kind: 'header', name: 'X-Api-Key' }, hint: 'CRM 个人设置 → API 令牌' }],
    ...extra,
  }
}
const withTool = (tool = crmTool(), origin: Record<string, unknown> = {}) => expertPackage({ origin, definition: { tools: [{ toolId: 'webfetch', required: true }, { customTool: tool.key, required: true }], customTools: [tool] } })

test('custom tools join the library on import, are reused or renamed, and reach only visible experts', async t => {
  const f = await fixture(t)
  const tools = () => fetch(f.origin + '/api/admin/expert-tools', { headers: f.headers }).then(r => r.json())
  const first = (await (await f.upload('/api/admin/experts/import', withTool())).json()).preview
  assert.deepEqual(first.errors, [])
  assert.deepEqual(first.customTools.map((row: { key: string; resolution: string; libraryKey: string }) => [row.key, row.resolution, row.libraryKey]), [['crm-query', 'new', 'crm-query']])
  assert.deepEqual(first.tools.map((row: { name: string; known: boolean }) => [row.name, row.known]), [['网页抓取', true], ['CRM 查询', true]])
  const applied = await f.json(`/api/admin/experts/import/${first.importId}/apply`, { target: { mode: 'create', id: 'push-ops' }, adoptAllowlist: true, publish: true, revision: (await f.list()).revision })
  assert.equal(applied.status, 200)
  assert.deepEqual((await applied.json()).expert.draft.tools, [{ toolId: 'webfetch', required: true }, { customTool: 'crm-query', required: true }])
  const library = await tools()
  assert.deepEqual(library.tools.map((tool: { key: string; usage: Array<{ id: string; published: boolean }> }) => [tool.key, tool.usage]), [['crm-query', [{ id: 'push-ops', name: '推送运营助手', draft: true, published: true }]]])

  // Only employees who see an expert receive its tool; the entry carries slots, never a value.
  const visible = await f.catalog('s00526367')
  const body = await visible.json()
  assert.equal(body.customTools.length, 1)
  assert.equal(body.customTools[0].revision, library.tools[0].revision)
  assert.deepEqual(body.customTools[0].headers, { 'X-Api-Key': '{{credential:api-key}}', 'X-Tenant-Id': 'acme' })
  assert.deepEqual((await (await f.catalog('x00000001')).json()).customTools, [])

  // The same package again: the identical tool is reused.
  const again = (await (await f.upload('/api/admin/experts/import', withTool())).json()).preview
  assert.equal(again.customTools[0].resolution, 'reuse')
  await fetch(`${f.origin}/api/admin/experts/import/${again.importId}`, { method: 'DELETE', headers: f.headers })

  // Another expert brings a different tool under the same server name: the admin must choose.
  const other = withTool(crmTool({ url: 'https://crm-test.example.internal/mcp' }), { expertId: 'product-default-custom-d4e5f6' })
  const conflict = (await (await f.upload('/api/admin/experts/import', other)).json()).preview
  assert.deepEqual(conflict.customTools[0].resolution, 'conflict')
  assert.deepEqual(conflict.customTools[0].rename, { key: 'crm-query-2', serverName: 'crm_2' })
  assert.deepEqual(conflict.customTools[0].affected, [{ id: 'push-ops', name: '推送运营助手' }])
  assert.deepEqual(conflict.errors, [])
  const unresolved = await f.json(`/api/admin/experts/import/${conflict.importId}/apply`, { target: { mode: 'create', id: 'crm-test' }, revision: (await f.list()).revision })
  assert.equal(unresolved.status, 400)
  assert.match((await unresolved.json()).issues.join(), /更新已有工具/)
  const renamed = await f.json(`/api/admin/experts/import/${conflict.importId}/apply`, { target: { mode: 'create', id: 'crm-test' }, tools: { 'crm-query': 'rename' }, revision: (await f.list()).revision })
  assert.equal(renamed.status, 200)
  assert.deepEqual((await renamed.json()).expert.draft.tools[1], { customTool: 'crm-query-2', required: true })
  const both = await tools()
  assert.deepEqual(both.tools.map((tool: { key: string; serverName: string }) => [tool.key, tool.serverName]), [['crm-query', 'crm'], ['crm-query-2', 'crm_2']])

  // Editing an entry takes effect at once: its revision and the catalog of everyone using it change.
  const etag = (await f.catalog('s00526367')).headers.get('etag')
  const edit = (url: string, extra: Record<string, unknown> = {}) => ({ name: 'CRM 查询', url, timeoutMs: 60000, credentials: [{ key: 'api-key', label: 'CRM 访问令牌', hint: '找 CRM 管理员申请' }], ...extra })
  const secretUrl = await f.json('/api/admin/expert-tools/crm-query', { tool: edit('https://crm.example.internal/mcp?token=abc'), revision: both.revision }, 'PUT')
  assert.equal(secretUrl.status, 400)
  assert.equal((await secretUrl.json()).error, 'INVALID_EXPERT_TOOL')
  const saved = await f.json('/api/admin/expert-tools/crm-query', { tool: edit('https://crm2.example.internal/mcp'), revision: both.revision }, 'PUT')
  assert.equal(saved.status, 200)
  const savedTool = (await saved.json()).tool
  assert.notEqual(savedTool.revision, both.tools[0].revision)
  assert.equal(savedTool.credentials[0].hint, '找 CRM 管理员申请')
  const next = await f.catalog('s00526367')
  assert.notEqual(next.headers.get('etag'), etag)
  assert.equal((await next.json()).customTools[0].url, 'https://crm2.example.internal/mcp')

  // An entry still referenced cannot be removed.
  const inUse = await f.json('/api/admin/expert-tools/crm-query', { revision: (await tools()).revision }, 'DELETE')
  assert.equal(inUse.status, 409)
  assert.match((await inUse.json()).issues.join(), /push-ops/)
})

test('admin routes require the session and CSRF', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.origin + '/api/admin/experts')).status, 401)
  assert.equal((await fetch(f.origin + '/api/admin/expert-tools')).status, 401)
  const noCsrf = await fetch(f.origin + '/api/admin/experts', { method: 'POST', headers: { Cookie: f.headers.Cookie, Origin: f.origin, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(noCsrf.status, 403)
  const crossSite = await fetch(f.origin + '/api/admin/experts', { method: 'POST', headers: { ...f.headers, Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(crossSite.status, 403)
})
