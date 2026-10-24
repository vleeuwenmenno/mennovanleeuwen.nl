// Generic branch-source regression. No inpaint dependency, server, external API or GPU.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
const dir = mkdtempSync(join(tmpdir(), 'agents-source-branches-'))
process.env.DATA_DIR = dir
try {
  const { database } = await import('../server/db.ts')
  const { branchThread, deleteThread } = await import('../server/agents.ts')
  const { imageSource } = await import('../server/agentImageSources.ts')
  const { imageAgainInput } = await import('../server/agentImages.ts')
  const db = database()
  for (const id of [1,2]) db.prepare('INSERT INTO users(id,github_id,login,github_token,created_at,updated_at) VALUES(?,?,?,?,0,0)').run(id,id,`fixture-${id}`,'')
  const owner = { id:1 } as never, other = { id:2 } as never
  const thread = randomUUID()
  db.prepare('INSERT INTO agent_threads(id,user_id,title,mode,model,created_at,updated_at) VALUES(?,1,?, ?, ?,0,0)').run(thread,'Source fixture','quick','test')
  const bytes = readFileSync(new URL('./fixtures/agent-image-sources/source.png',import.meta.url))
  const attachments = JSON.stringify([{kind:'image',name:'source.png',mime:'image/png',data:bytes.toString('base64'),size:bytes.length}])
  const message = Number(db.prepare('INSERT INTO agent_messages(thread_id,role,content,attachments,created_at) VALUES(?,?,?,?,0)').run(thread,'user','Edit this source',attachments).lastInsertRowid)
  const sourceId = `attachment:${message}:0`
  const source = imageSource(owner,sourceId)
  const images: { id:string; operation:string }[] = []
  let last = message
  for (const operation of ['generate']) {
    const id=randomUUID()
    const settings = { preset:'sdxl',model:'test.safetensors',clip:'',vae:'',loras:[],steps:20,cfg:7,sampler:'euler',scheduler:'normal',seed:42,prompt:'Edit shape',negative_prompt:'',denoise:0.65,width:512,height:512,source }
    // Metadata contains references, never a source byte copy.
    delete (settings.source as Partial<typeof source>).bytes
    db.prepare('INSERT INTO agent_images(id,thread_id,name,body,metadata,created_at) VALUES(?,?,?,?,?,0)').run(id,thread,'output.png',bytes,JSON.stringify(settings))
    last=Number(db.prepare('INSERT INTO agent_messages(thread_id,role,content,tool_name,created_at) VALUES(?,?,?,?,0)').run(thread,'tool',JSON.stringify({image:{id}}),'generate_image').lastInsertRowid)
    images.push({id,operation})
  }
  const first = branchThread(owner,thread,{messageId:last})
  const second = branchThread(owner,first.thread.id,{messageId:first.messages.at(-1)!.id})
  const firstCopied = first.messages.find(m=>m.role==='user')!.id
  const secondCopied = second.messages.find(m=>m.role==='user')!.id
  assert.notEqual(firstCopied,message)
  assert.notEqual(secondCopied,firstCopied)
  deleteThread(owner,thread)
  for (const image of images) {
    const again=imageAgainInput(owner,first.thread.id,image.id)
    assert.equal(again.denoise,0.65)
    assert.equal(again.prompt,'Edit shape')
    assert.equal(again.source_image_id,sourceId)
    const restored=imageSource(owner,again.source_image_id)
    assert.deepEqual(restored.bytes,bytes)
    assert.equal(restored.url,`/api/agents/threads/${first.thread.id}/messages/${firstCopied}/attachments/0`)
    assert.throws(()=>imageSource(other,again.source_image_id),/No such source image/)
    assert.throws(()=>imageAgainInput(other,first.thread.id,image.id),/No such thread/)
  }
  deleteThread(owner,first.thread.id)
  for (const image of images) {
    assert.equal(imageAgainInput(owner,second.thread.id,image.id).source_image_id,sourceId)
    const restored=imageSource(owner,sourceId)
    assert.deepEqual(restored.bytes,bytes)
    assert.equal(restored.url,`/api/agents/threads/${second.thread.id}/messages/${secondCopied}/attachments/0`)
  }
  // Canonical references from an intermediate branch also resolve through its descendants.
  assert.deepEqual(imageSource(owner,`attachment:${firstCopied}:0`).bytes,bytes)
  deleteThread(owner,second.thread.id)
  assert.throws(()=>imageSource(owner,sourceId),/No such source image/)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_image_source_aliases').get() as {n:number}).n,0)
  db.close()
  console.log('PASS attachment aliases: img2img Again inputs, branch-of-branch, original deletion, owner isolation, stable IDs/bytes, current preview URLs and cascade cleanup')
} finally { rmSync(dir,{recursive:true,force:true}) }
