import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { GuideStore, GuideError, decodeChapter, encodeChapter } from '../server/guide-store.js'
import { createGuideHandler } from '../server/guide-http.js'
import { readAdminPassword, minimumAdminPasswordLength } from '../server/guide-config.js'
import { createHandler } from '../server/app.js'
import { renderMarkdown } from '../shared/markdown.js'
import type { ChapterDraft } from '../shared/guide.js'

const draft: ChapterDraft = { id:'start',title:'开始使用',group:'入门',order:10,summary:'开始第一项工作',archived:false,markdown:'## 操作\n\n阅读资料，完成工作。\n' }
const iconHash=createHash('sha256').update('/* test-only icon */').digest('base64')
test('six-character administrator passwords are limited to loopback development',t=>{
  const envName='DSH_OPS_WEBSITE_TEST_PASSWORD_POLICY'
  const previous=process.env[envName]
  t.after(()=>{if(previous===undefined)delete process.env[envName];else process.env[envName]=previous})
  process.env[envName]='local!'
  const local={adminPasswordEnv:envName,host:'127.0.0.1',websiteUrl:'http://127.0.0.1:4173'}
  assert.equal(readAdminPassword(local,true)?.length,6)
  assert.equal(minimumAdminPasswordLength({dev:true,host:'::1',websiteUrl:'http://[::1]:4173'}),6)
  assert.throws(()=>readAdminPassword(local),/16 to 256/)
  assert.throws(()=>readAdminPassword(local,false),/16 to 256/)
  for(const config of [{...local,host:'0.0.0.0'},{...local,host:'::'},{...local,websiteUrl:'https://docs.example.com'},{...local,websiteUrl:'http://localhost.example.com'}]){
    assert.throws(()=>readAdminPassword(config,true),/16 to 256/)
  }
  process.env[envName]='short'
  assert.throws(()=>readAdminPassword(local,true),/6 to 256/)
  process.env[envName]='x'.repeat(257)
  assert.throws(()=>readAdminPassword(local,true),/6 to 256/)
  process.env[envName]='x'.repeat(16)
  assert.equal(readAdminPassword(local)?.length,16)
  delete process.env[envName]
  assert.equal(readAdminPassword(local,true),undefined)
})
async function fixture(t:TestContext) {
  const root=await mkdtemp(path.join(tmpdir(),'website-guide-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const seeds=path.join(root,'seeds'); await mkdir(seeds)
  await writeFile(path.join(seeds,'start.md'),encodeChapter(draft))
  const store=new GuideStore(seeds,path.join(root,'state'));await store.initialize()
  return {root,seeds,store}
}
test('Markdown frontmatter round-trips Chinese, BOM and CRLF; rejects invalid metadata and aliases',()=>{
  const raw=encodeChapter(draft)
  assert.deepEqual(decodeChapter('\ufeff'+raw.replace(/\n/g,'\r\n')),draft)
  assert.throws(()=>decodeChapter(raw.replace('order: 10','order: wrong')),GuideError)
  assert.throws(()=>decodeChapter(raw.replace('id: start','id: ../outside')),GuideError)
  assert.throws(()=>decodeChapter('---\nid: start\na: &a [*a]\n---\nbody'),GuideError)
  assert.throws(()=>encodeChapter({...draft,markdown:'x'.repeat(140000)}),GuideError)
})
test('all shipped chapters remain independently editable Markdown files',async()=>{
  const directory=new URL('../content/guide/',import.meta.url)
  const files=(await readdir(directory)).filter(file=>file.endsWith('.md'))
  assert.ok(files.length>0)
  const ids=new Set<string>()
  for(const file of files){const chapter=decodeChapter(await readFile(new URL(file,directory),'utf8'));assert.equal(file,`${chapter.id}.md`);assert.ok(!ids.has(chapter.id));ids.add(chapter.id)}
})
test('online edits survive restart, preserve source bytes, search content and create history',async t=>{
  const {store,seeds,root}=await fixture(t),base=await store.get('start'),source=await readFile(path.join(seeds,'start.md'),'utf8')
  const saved=await store.save({...draft,markdown:'## 新内容\n\n独特搜索词'},base.revision)
  assert.equal(saved.source,'online');assert.notEqual(saved.revision,base.revision)
  assert.equal(await readFile(path.join(seeds,'start.md'),'utf8'),source)
  assert.equal((await store.list(false,'独特搜索词'))[0]?.id,'start')
  assert.equal((await store.history('start'))[0]?.revision,base.revision)
  assert.equal((await new GuideStore(seeds,path.join(root,'state')).get('start')).revision,saved.revision)
  const restored=await store.restore('start',base.revision,saved.revision)
  assert.equal(restored.markdown,draft.markdown)
  assert.ok((await store.history('start')).some(entry=>entry.revision===saved.revision))
  const archived=await store.archive('start',true,restored.revision)
  assert.equal((await store.list()).length,0);assert.equal((await store.list(true)).length,1)
  await store.archive('start',false,archived.revision);assert.equal((await store.list()).length,1)
})
test('concurrent saves reject stale revisions; process lock rejects another writer',async t=>{
  const {store}=await fixture(t),base=await store.get('start')
  const results=await Promise.allSettled([store.save({...draft,title:'甲'},base.revision),store.save({...draft,title:'乙'},base.revision)])
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
  assert.ok(results.some(result=>result.status==='rejected' && result.reason.code==='REVISION_CONFLICT'))
  await assert.rejects(store.save({...draft,id:'new'},'wrong'),{code:'REVISION_CONFLICT'})
  await store.save({...draft,id:'new'},null)
  await writeFile(path.join(store.root,'.write-lock'),'')
  await assert.rejects(store.save({...draft,id:'another'},null),{code:'CONTENT_BUSY'})
})
test('paths, current-file symlinks and mismatched document IDs fail closed',async t=>{
  const {store,root}=await fixture(t)
  await assert.rejects(store.get('../start'),{code:'INVALID_CHAPTER_ID'})
  await writeFile(path.join(store.root,'current','start.md'),encodeChapter({...draft,id:'other'}))
  await assert.rejects(store.get('start'),{code:'INVALID_CHAPTER_ID'})
  if(process.platform==='win32'){t.diagnostic('Symlink fixture requires privileges on Windows');return}
  await writeFile(path.join(root,'outside.md'),encodeChapter({...draft,id:'linked'}))
  await symlink(path.join(root,'outside.md'),path.join(store.root,'current','linked.md'))
  await assert.rejects(store.get('linked'))
  await assert.rejects(store.save({...draft,id:'linked'},null))
})
test('reader does not execute raw HTML or unsafe links and uses controlled image paths',()=>{
  const html=renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n\n![external](https://evil.example/track.png)\n\n![tool](/assets/product/tools.jpg)\n\n```html\n<script>bad</script>\n```')
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('src="https://evil'))
  assert.ok(html.includes('src="/assets/product/tools.jpg"'));assert.ok(html.includes('&lt;script&gt;'))
})

async function httpFixture(t:TestContext,password:string|undefined='test-password-for-guide-only') {
  const {store,root}=await fixture(t)
  let clock=Date.now()
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))})
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  await writeFile(path.join(root,'index.html'),'<html><body>test</body></html>')
  const guide=await createGuideHandler(store,{origin,password,now:()=>clock})
  server.on('request',createHandler({schemaVersion:1,websiteUrl:origin,host:'127.0.0.1',port:4173,releaseDirectory:path.join(root,'releases'),contentDirectory:path.join(root,'state'),adminPasswordEnv:'DSH_OPS_WEBSITE_ADMIN_PASSWORD',configPath:'test'},{clientRoot:root,guide,adminIconHash:iconHash}))
  const send=(route:string,data:unknown,headers:Record<string,string>={},method='POST')=>fetch(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)})
  async function login(){const response=await send('/api/admin/login',{password});assert.equal(response.status,200);const body=await response.json();return {Cookie:response.headers.get('set-cookie')!.split(';')[0]!, 'X-CSRF-Token':body.csrf}}
  return {store,origin,send,login,advance:(duration:number)=>{clock+=duration}}
}
test('admin login, publish, history restore and logout enforce real sessions and CSRF',async t=>{
  const {origin,send,login}=await httpFixture(t)
  assert.equal((await fetch(origin+'/api/admin/guides')).status,401)
  assert.equal((await send('/api/admin/login',{password:'wrong'})).status,401)
  assert.equal((await send('/api/admin/login',{password:'wrong'},{Origin:'https://evil.example'})).status,403)
  const headers=await login()
  const base=(await (await fetch(origin+'/api/admin/guides/start',{headers})).json()).chapter
  const data={chapter:{...draft,title:'浏览器维护'},revision:base.revision}
  assert.equal((await send('/api/admin/guides/start',data,{Cookie:headers.Cookie},'PUT')).status,403)
  assert.equal((await send('/api/admin/guides/start',data,{...headers,Origin:'https://evil.example'},'PUT')).status,403)
  const saved=await send('/api/admin/guides/start',data,headers,'PUT');assert.equal(saved.status,200);const current=(await saved.json()).chapter
  assert.equal((await (await fetch(origin+'/api/guide/start')).json()).chapter.title,'浏览器维护')
  assert.equal((await send('/api/admin/guides/start',data,headers,'PUT')).status,409)
  const history=await (await fetch(origin+'/api/admin/guides/start/history',{headers})).json();assert.equal(history.history[0].revision,base.revision)
  assert.equal((await send('/api/admin/guides/start/restore',{historyRevision:base.revision,revision:current.revision},headers)).status,200)
  const exported=await fetch(origin+'/api/admin/guides/start/export',{headers});assert.ok(exported.headers.get('content-type')?.startsWith('text/markdown'));assert.equal(decodeChapter(await exported.text()).title,draft.title)
  assert.equal((await send('/api/admin/logout',{},headers)).status,200)
  assert.equal((await send('/api/admin/guides/start',data,headers,'PUT')).status,401)
})
test('sessions expire; login failures are throttled; public release APIs stay read-only',async t=>{
  const {origin,send,login,advance}=await httpFixture(t)
  const headers=await login();advance(8*60*60*1000+1)
  assert.equal((await fetch(origin+'/api/admin/guides',{headers})).status,401)
  for(let n=0;n<5;n++)assert.equal((await send('/api/admin/login',{password:'wrong'})).status,401)
  assert.equal((await send('/api/admin/login',{password:'wrong'})).status,429)
  advance(300001);assert.equal((await send('/api/admin/login',{password:'wrong'})).status,401)
  assert.equal((await send('/api/releases',{})).status,405)
  const legacy=await fetch(origin+'/guide/admin',{redirect:'manual'});assert.equal(legacy.status,308);assert.equal(legacy.headers.get('location'),'/admin')
  const page=await fetch(origin+'/admin'),publicPage=await fetch(origin+'/guide')
  assert.equal(page.headers.get('cache-control'),'no-store')
  assert.equal(page.headers.get('x-robots-tag'),'noindex, nofollow')
  assert.ok(page.headers.get('content-security-policy')?.includes("style-src 'self' 'unsafe-inline'"))
  assert.ok(!publicPage.headers.get('content-security-policy')?.includes('unsafe-inline'))
  assert.ok(page.headers.get('content-security-policy')?.includes(`script-src 'self' 'sha256-${iconHash}';`))
  assert.ok(publicPage.headers.get('content-security-policy')?.includes("script-src 'self';"))
})
test('unconfigured admin cannot log in while chapters remain publicly readable',async t=>{
  const {origin,send}=await httpFixture(t,'')
  const session=await (await fetch(origin+'/api/admin/session')).json();assert.equal(session.configured,false)
  assert.equal((await send('/api/admin/login',{password:'anything'})).status,503)
  assert.equal((await fetch(origin+'/api/guide')).status,200)
})
test('overlapping failed logins cannot bypass the attempt limit',async t=>{
  const {send}=await httpFixture(t)
  const results=await Promise.all(Array.from({length:9},()=>send('/api/admin/login',{password:'wrong'})))
  const rejected=results.filter(response=>response.status===401).length
  assert.ok(rejected>=1&&rejected<=5)
  assert.equal(results.filter(response=>response.status===429).length,9-rejected)
  assert.ok(results.filter(response=>response.status===429).every(response=>Number(response.headers.get('retry-after'))>0))
})

test('login limits apply before parsing, ignore forwarded identities, and sessions rotate and idle-expire',async t=>{
  const {origin,send,login,advance}=await httpFixture(t)
  const first=await login(),secondResponse=await send('/api/admin/login',{password:'test-password-for-guide-only'},first)
  assert.equal(secondResponse.status,200)
  const second={Cookie:secondResponse.headers.get('set-cookie')!.split(';')[0]!}
  assert.ok(secondResponse.headers.get('set-cookie')!.includes('HttpOnly'))
  assert.ok(secondResponse.headers.get('set-cookie')!.includes('SameSite=Strict'))
  assert.equal((await fetch(origin+'/api/admin/guides',{headers:first})).status,401)
  assert.equal((await fetch(origin+'/api/admin/guides',{headers:second})).status,200)
  advance(30*60*1000+1)
  assert.equal((await fetch(origin+'/api/admin/guides',{headers:second})).status,401)
  const huge=await send('/api/admin/login',{password:'x'.repeat(4000)})
  assert.equal(huge.status,413)
  for(let n=0;n<4;n++)assert.equal((await send('/api/admin/login',{password:42},{'X-Forwarded-For':`192.0.2.${n}`})).status,401)
  const limited=await send('/api/admin/login',{password:'test-password-for-guide-only'},{'X-Forwarded-For':'203.0.113.1'})
  assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'300')
  advance(300001);assert.equal((await send('/api/admin/login',{password:'test-password-for-guide-only'})).status,200)
})

test('successful logins cannot reset the global attempt budget',async t=>{
  const {send,advance}=await httpFixture(t)
  for(let n=0;n<50;n++)assert.equal((await send('/api/admin/login',{password:'test-password-for-guide-only'})).status,200)
  const limited=await send('/api/admin/login',{password:'test-password-for-guide-only'})
  assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'300')
  advance(300001)
  assert.equal((await send('/api/admin/login',{password:'test-password-for-guide-only'})).status,200)
})

test('a stalled login body is disconnected and releases its login slot',async t=>{
  const {origin,login}=await httpFixture(t),start=Date.now()
  await new Promise<void>((resolve,reject)=>{
    const req=httpRequest(origin+'/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Content-Length':'100'}},res=>{res.resume();reject(new Error('Expected the stalled request to disconnect'))})
    req.on('error',()=>resolve())
    req.setTimeout(8000,()=>{req.destroy();reject(new Error('Login body exceeded its deadline'))})
    t.after(()=>req.destroy())
    req.flushHeaders()
  })
  assert.ok(Date.now()-start<7500)
  await login()
})
