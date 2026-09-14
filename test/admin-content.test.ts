import { crc32, deflateSync } from 'node:zlib'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { GuideStore, encodeChapter } from '../server/guide-store.js'
import { MediaStore } from '../server/media-store.js'
import { ReleaseAdmin } from '../server/release-admin.js'
import { createAdminHandler } from '../server/admin-http.js'
import { createGuideHandler } from '../server/guide-http.js'
import { createHandler } from '../server/app.js'
import { renderMarkdown } from '../shared/markdown.js'
import { maxImageBytes } from '../shared/admin.js'
import { ContentSync } from '../server/content-sync.js'

function pngChunk(type:string, data:Buffer){const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc])}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6
const image=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',deflateSync(Buffer.from([0,120,100,220,255]))),pngChunk('IEND',Buffer.alloc(0))])
const notes={version:'9.9.9',platform:'windows-x64',title:'测试发布',notes:['新增图文编辑','支持目录管理']}
async function fixture(t:TestContext){
  const root=await mkdtemp(path.join(tmpdir(),'website-admin-content-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const source=path.join(root,'repository/content'),seed=path.join(source,'guide');await mkdir(seed,{recursive:true})
  for(const [id,group,order] of [['one','入门',10],['two','入门',20],['three','进阶',30]] as const)await writeFile(path.join(seed,id+'.md'),encodeChapter({id,title:id,group,order,summary:'',archived:false,markdown:'# 正文\n'}))
  const guides=new GuideStore(seed,path.join(root,'content')),media=new MediaStore(path.join(root,'content'),source),releases=new ReleaseAdmin(path.join(root,'releases'))
  const sync=new ContentSync(guides,media,source)
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))})
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  const guide=await createGuideHandler(guides,{origin,password:'test-admin-password-only',admin:createAdminHandler(releases,media,sync)})
  server.on('request',createHandler({schemaVersion:1,websiteUrl:origin,host:'127.0.0.1',port:4173,releaseDirectory:releases.root,contentDirectory:path.join(root,'content'),adminPasswordEnv:'DSH_OPS_WEBSITE_ADMIN_PASSWORD',configPath:'test'},{clientRoot:root,guide:async(req,res,url)=>await media.serve(req,res,url)||await guide(req,res,url)}))
  const login=await fetch(origin+'/api/admin/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:'test-admin-password-only'})})
  const session=await login.json(),headers={Cookie:login.headers.get('set-cookie')!.split(';')[0]!,Origin:origin,'X-CSRF-Token':session.csrf}
  const json=(url:string,data:unknown,method='POST')=>fetch(origin+url,{method,headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(data)})
  const upload=(url:string,bytes:Buffer,extra:Record<string,string>={})=>fetch(origin+url,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream',...extra},body:bytes})
  return {root,origin,headers,json,upload,guides,media,releases,source,sync}
}
test('directory changes reorder reader/search, hide without deleting, retain archived position and reject stale or invalid saves',async t=>{
  const {json,guides,origin}=await fixture(t),current=await guides.navigation()
  const navigation={groups:[{id:'advanced',title:'工作进阶',chapters:['three','one']},{id:'start',title:'开始',chapters:['two']}],hidden:['one']}
  assert.equal((await json('/api/admin/navigation',{navigation,revision:current.revision},'PUT')).status,200)
  assert.deepEqual((await (await fetch(origin+'/api/guide')).json()).chapters.map((c:{id:string})=>c.id),['three','two'])
  assert.equal((await fetch(origin+'/api/guide/one')).status,200)
  assert.equal((await json('/api/admin/navigation',{navigation,revision:current.revision},'PUT')).status,409)
  const rev=(await guides.navigation()).revision
  await assert.rejects(guides.saveNavigation({...navigation,groups:[{id:'bad',title:'重复',chapters:['one','one','three']}]},rev),{code:'INVALID_NAVIGATION'})
  const base=await guides.get('three');await guides.archive('three',true,base.revision)
  assert.deepEqual((await guides.readerList('')).map(c=>c.id),['two'])
  assert.equal((await guides.navigation()).groups[0]!.chapters[0],'three')
  await guides.save({id:'four',title:'新章',group:'开始',order:40,summary:'',archived:false,markdown:'新内容'},null)
  assert.ok((await guides.navigation()).groups.find(g=>g.id==='start')!.chapters.includes('four'))
  assert.notEqual((await guides.navigation()).revision,rev)
})
test('authenticated image upload is deduplicated, publicly served, survives restart and renders inside Markdown',async t=>{
  const {upload,origin,media,root}=await fixture(t)
  const response=await upload('/api/admin/images?name=screen.png',image);assert.equal(response.status,200)
  const saved=(await response.json()).image
  assert.equal(saved.width,1);assert.match(saved.url,/^\/media\/[a-f0-9]{64}\.png$/)
  const publicImage=await fetch(origin+saved.url);assert.equal(publicImage.status,200);assert.equal(publicImage.headers.get('content-type'),'image/png');assert.equal(publicImage.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()),image)
  assert.equal((await upload('/api/admin/images?name=duplicate.png',image)).status,200)
  assert.equal((await media.list()).length,1);assert.equal((await new MediaStore(path.join(root,'content')).list()).length,1)
  const html=renderMarkdown(`说明文字\n\n![截图](${saved.url})\n\n后续步骤`);assert.ok(html.includes(`src="${saved.url}"`));assert.ok(html.includes('<p>后续步骤</p>'))
  assert.ok(!renderMarkdown('![a](/media/evil.svg)').includes('<img'))
  const damaged = Buffer.from(image); damaged[45] = damaged[45]! ^ 1
  assert.equal((await upload('/api/admin/images?name=damaged.png',damaged)).status,400)
  assert.equal((await upload('/api/admin/images?name=evil.png',Buffer.from('<svg onload="alert(1)"/>'))).status,400)
  assert.equal((await upload('/api/admin/images?name=../outside.png',image)).status,400)
  assert.equal((await upload('/api/admin/images?name=big.png',Buffer.alloc(maxImageBytes+1))).status,413)
  assert.ok(!(await readdir(media.root)).some(n=>n.endsWith('.upload')))
})
test('release drafts upload with CAS, publish through the immutable catalog, edit changelog and withdraw',async t=>{
  const {json,upload,origin,headers,releases}=await fixture(t)
  let response=await json('/api/admin/releases',{draft:notes});assert.equal(response.status,200)
  let draft=(await response.json()).draft;const api=`/api/admin/releases/drafts/${draft.id}`
  assert.equal((await json(api+'/publish',{revision:draft.revision})).status,400)
  assert.equal((await upload(api+'/files?name=Office-1.0.0-x64.exe',Buffer.from('MZ-test'),{'X-Revision':draft.revision})).status,400)
  const bytes=Buffer.from('MZ-isolated-test-only-never-execute'),old=draft.revision
  response=await upload(api+'/files?name=Office-9.9.9-x64.exe',bytes,{'X-Revision':draft.revision});assert.equal(response.status,200);draft=(await response.json()).draft
  assert.equal(draft.files[0].size,bytes.length)
  assert.equal((await upload(api+'/files?name=Office-9.9.9-x64.zip',bytes,{'X-Revision':old})).status,409)
  assert.equal((await json(api,{draft:{...notes,version:'9.9.10'},revision:draft.revision},'PUT')).status,409)
  response=await json(api+'/publish',{revision:draft.revision});assert.equal(response.status,200)
  const download=await fetch(origin+'/updates/archive/9.9.9/windows-x64/Office-9.9.9-x64.exe');assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes)
  let state=await (await fetch(origin+'/api/admin/releases',{headers})).json();let release=state.releases[0]
  assert.equal(state.drafts[0].published,true)
  assert.equal((await upload(api+'/files?name=Office-9.9.9-x64.zip',bytes,{'X-Revision':state.drafts[0].revision})).status,409)
  response=await json('/api/admin/releases/published/9.9.9',{release:{title:'新标题',notes:['修复说明'],enabled:false},revision:release.revision},'PUT');assert.equal(response.status,200)
  assert.equal((await json('/api/admin/releases/published/9.9.9',{release:{title:'过期',notes:['失效修改'],enabled:true},revision:release.revision},'PUT')).status,409)
  assert.equal((await fetch(origin+'/updates/archive/9.9.9/windows-x64/Office-9.9.9-x64.exe')).status,404)
  assert.equal((await (await fetch(origin+'/api/releases')).json()).releases.length,0)
  assert.deepEqual(await readFile(path.join(releases.root,'archive/9.9.9/windows-x64/Office-9.9.9-x64.exe')),bytes)
  assert.equal((await json(api,{revision:state.drafts[0].revision},'DELETE')).status,200)
  assert.equal((await releases.list()).drafts.length,0)
})
test('new mutation routes reject anonymous, cross-origin and missing CSRF requests',async t=>{
  const {origin,headers}=await fixture(t)
  for(const route of ['/api/admin/navigation','/api/admin/images','/api/admin/releases']){
    assert.equal((await fetch(origin+route)).status,401)
    for(const override of [{'X-CSRF-Token':''},{Origin:'https://evil.example'}])assert.equal((await fetch(origin+route,{method:'POST',headers:{...headers,...override,'Content-Type':'application/json'},body:'{}'})).status,403)
  }
})
test('publication refuses changed bytes after upload review and keeps the draft recoverable',async t=>{
  const {json,upload,releases}=await fixture(t)
  const draft=(await (await json('/api/admin/releases',{draft:notes})).json()).draft,api=`/api/admin/releases/drafts/${draft.id}`
  const saved=(await (await upload(api+'/files?name=Office-9.9.9-x64.exe',Buffer.from('MZ-reviewed'),{'X-Revision':draft.revision})).json()).draft
  await writeFile(path.join(releases.drafts,draft.id,'files/Office-9.9.9-x64.exe'),'MZ-changed')
  assert.equal((await json(api+'/publish',{revision:saved.revision})).status,409)
  assert.equal((await releases.list()).releases.length,0)
  assert.equal((await releases.get(draft.id)).published,false)
  assert.ok(!(await readdir(releases.root)).some(n=>n.startsWith('.staging')||n==='.publish.lock'))
})
test('renaming an initial group does not create duplicate IDs when a new chapter uses its former name',async t=>{
  const {guides}=await fixture(t),nav=await guides.navigation()
  const {revision,...value}=nav;value.groups[0]!.title='新名称';await guides.saveNavigation(value,revision)
  await guides.save({id:'added',title:'新章节',group:'入门',order:50,summary:'',archived:false,markdown:'内容'},null)
  const next=await guides.navigation();assert.equal(new Set(next.groups.map(g=>g.id)).size,next.groups.length)
  const {revision:rev,...changed}=next;await guides.saveNavigation(changed,rev)
})
test('cancelled upload cleans partial bytes and allows a later upload',async t=>{
  const {origin,headers,media,upload}=await fixture(t)
  const req=request(origin+'/api/admin/images?name=cancel.png',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'}})
  req.on('error',()=>{});req.write(image.subarray(0,16))
  // Wait until the server is actually writing a partial upload before aborting it.
  for(let n=0;n<100;n++){if((await readdir(media.root).catch(()=>[])).some(n=>n.endsWith('.upload')))break;await new Promise(r=>setTimeout(r,10))}
  req.destroy()
  for(let n=0;n<100;n++){if(!(await readdir(media.root)).some(n=>n.endsWith('.upload')))break;await new Promise(r=>setTimeout(r,10))}
  assert.ok(!(await readdir(media.root)).some(n=>n.endsWith('.upload')))
  assert.equal((await upload('/api/admin/images?name=retry.png',image)).status,200)
})
test('uploaded file removal retains a recoverable copy and symlink paths fail closed',async t=>{
  const {json,upload,releases,root}=await fixture(t)
  const draft=(await (await json('/api/admin/releases',{draft:notes})).json()).draft,api=`/api/admin/releases/drafts/${draft.id}`
  const saved=(await (await upload(api+'/files?name=Office-9.9.9-x64.exe',Buffer.from('MZ-test'),{'X-Revision':draft.revision})).json()).draft
  assert.equal((await json(api+'/files?name=Office-9.9.9-x64.exe',{revision:saved.revision},'DELETE')).status,200)
  assert.equal((await releases.get(draft.id)).files.length,0)
  assert.equal((await readdir(path.join(releases.root,'.trash'))).length,1)
  if(process.platform!=='win32'){
    const id='12345678-1234-4234-8234-123456789abc';await mkdir(path.join(root,'outside'));await symlink(path.join(root,'outside'),path.join(releases.drafts,id))
    await assert.rejects(releases.get(id));await assert.rejects(releases.save(id,notes,null))
  }
})

test('tree creation targets a stable directory ID and rejects stale directory revisions without leaving a document',async t=>{
  const {guides,json}=await fixture(t),initial=await guides.navigation()
  const nav=await guides.saveNavigation({groups:[...initial.groups,{id:'duplicate-a',title:'同名目录',chapters:[]},{id:'duplicate-b',title:'同名目录',chapters:[]}],hidden:[]},initial.revision)
  const chapter={id:'new-document',title:'新文档',group:'同名目录',order:40,summary:'',archived:false,markdown:'# 新内容'}
  const result=await json('/api/admin/guides/new-document',{chapter,revision:null,groupId:'duplicate-b',navigationRevision:nav.revision},'PUT')
  assert.equal(result.status,200)
  const current=await guides.navigation()
  assert.deepEqual(current.groups.find(g=>g.id==='duplicate-a')!.chapters,[])
  assert.deepEqual(current.groups.find(g=>g.id==='duplicate-b')!.chapters,['new-document'])
  const stale=await json('/api/admin/guides/stale-document',{chapter:{...chapter,id:'stale-document'},revision:null,groupId:'duplicate-a',navigationRevision:nav.revision},'PUT')
  assert.equal(stale.status,409)
  await assert.rejects(guides.get('stale-document'),{code:'CHAPTER_NOT_FOUND'})
})

test('explicit content sync preserves other source files, backs up overwritten Markdown, and serves media/navigation from a fresh checkout',async t=>{
  const {root,source,origin,headers,json,upload,guides,media,sync}=await fixture(t)
  const original=await readFile(path.join(source,'guide/one.md'))
  await writeFile(path.join(source,'development.json'),'source-only content')
  const uploaded=await upload('/api/admin/images?name=example.png',image),picture=(await uploaded.json()).image
  const {revision,source:from,updatedAt,...one}=await guides.get('one')
  await guides.save({...one,title:'修改后的文档',markdown:`图文内容\n\n![示例](${picture.url})`},revision)
  const nav=await guides.navigation()
  await guides.saveNavigation({groups:[...nav.groups].reverse().map(g=>({...g,title:g.title+'目录',chapters:[...g.chapters].reverse()})),hidden:['two']},nav.revision)
  const preview=await (await fetch(origin+'/api/admin/content-sync',{headers})).json()
  assert.ok(preview.files.some((file:{path:string})=>file.path==='content/guide/one.md'))
  assert.ok(preview.files.some((file:{path:string})=>file.path==='content/guide/navigation.json'))
  assert.ok(preview.files.some((file:{path:string})=>file.path==='content'+picture.url))
  assert.equal((await fetch(origin+'/api/admin/content-sync')).status,401)
  assert.equal((await fetch(origin+'/api/admin/content-sync',{method:'POST',headers:{Cookie:headers.Cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({revision:preview.revision})})).status,403)
  assert.equal((await json('/api/admin/content-sync',{revision:preview.revision,path:'../outside'})).status,400)
  assert.deepEqual(await readFile(path.join(source,'guide/one.md')),original)
  const response=await json('/api/admin/content-sync',{revision:preview.revision});assert.equal(response.status,200)
  const result=await response.json()
  assert.equal(result.files,4)
  assert.deepEqual(await readFile(path.join(root,'content/sync-backups',result.backupId,'old/guide/one.md')),original)
  assert.equal(await readFile(path.join(source,'development.json'),'utf8'),'source-only content')
  assert.deepEqual(await readFile(path.join(source,picture.url.slice(1))),image)
  assert.equal((await sync.preview()).files.length,0)
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../scripts/copy-guide.mjs',import.meta.url))],{cwd:path.dirname(source)})
  const builtContent=path.join(path.dirname(source),'dist/content')
  const freshState=path.join(root,'fresh-state'),freshGuides=new GuideStore(path.join(builtContent,'guide'),freshState),freshMedia=new MediaStore(freshState,builtContent)
  await freshGuides.initialize()
  assert.equal((await freshGuides.get('one')).title,'修改后的文档')
  assert.deepEqual((await freshGuides.readerList('')).map(c=>c.id),['three','one'])
  assert.equal((await freshMedia.list())[0]!.url,picture.url)
  const server=createServer(async(req,res)=>{await freshMedia.serve(req,res,new URL(req.url!,'http://127.0.0.1'))})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  try{const imageResponse=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}${picture.url}`);assert.equal(imageResponse.status,200);assert.equal(imageResponse.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()),image)}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  assert.equal((await guides.get('one')).source,'online')
  assert.equal((await media.list()).length,1)
})

test('content sync refuses changed source/online revisions, corrupt images, symlinks and unfinished recovery markers',async t=>{
  const {root,source,guides,sync,upload,media}=await fixture(t)
  const {revision,source:from,updatedAt,...one}=await guides.get('one')
  await guides.save({...one,title:'在线版本'},revision)
  const original=await readFile(path.join(source,'guide/one.md'))
  const preview=await sync.preview()
  await writeFile(path.join(source,'guide/one.md'),'local edits must survive')
  await assert.rejects(sync.apply(preview.revision),{code:'REVISION_CONFLICT'})
  assert.equal(await readFile(path.join(source,'guide/one.md'),'utf8'),'local edits must survive')
  await writeFile(path.join(source,'guide/one.md'),original)
  const before=await sync.preview(),current=await guides.get('one')
  await guides.save({...one,title:'更新的在线版本'},current.revision)
  await assert.rejects(sync.apply(before.revision),{code:'REVISION_CONFLICT'})
  const picture=(await (await upload('/api/admin/images?name=image.png',image)).json()).image
  await writeFile(path.join(media.root,picture.url.split('/').at(-1)!),'corrupt')
  await assert.rejects(sync.preview(),{code:'INVALID_IMAGE'})
  assert.deepEqual(await readFile(path.join(source,'guide/one.md')),original)
  await writeFile(path.join(media.root,picture.url.split('/').at(-1)!),image)
  if(process.platform!=='win32'){
    await rm(path.join(source,'guide/one.md'))
    const outside=path.join(root,'outside.md');await writeFile(outside,'outside')
    await symlink(outside,path.join(source,'guide/one.md'))
    await assert.rejects(sync.preview())
    assert.equal(await readFile(outside,'utf8'),'outside')
    await rm(path.join(source,'guide/one.md'));await writeFile(path.join(source,'guide/one.md'),original)
  }
  await writeFile(path.join(root,'content/content-sync-review.json'),JSON.stringify({backupId:'unfinished'}))
  await assert.rejects(sync.preview(),{code:'CONTENT_SYNC_REVIEW'})
  assert.deepEqual(await readFile(path.join(source,'guide/one.md')),original)
})
