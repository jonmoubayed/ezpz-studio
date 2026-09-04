import {spawn} from 'node:child_process'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import net from 'node:net'
const root=await mkdtemp(path.join(tmpdir(),'ezpz-frontend-integration-'))
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve))
const backend=path.resolve(process.env.EZPZ_BACKEND_REPO||'../ezpz-studio')
const server=spawn(process.env.EZPZ_TEST_PYTHON||'python3',['-m','backend.server','--root',root,'--port',String(port)],{env:{...process.env,PYTHONPATH:backend,EZPZ_DATABASE_URL:`sqlite:///${root}/test.db`,EZPZ_BLOB_ROOT:path.join(root,'blobs'),EZPZ_SEED_DEMO:'false'},stdio:['ignore','ignore','pipe']})
let serverErrors='';server.stderr.on('data',d=>serverErrors+=d);server.on('error',e=>serverErrors+=e.message)
try{
 let ready=false;for(let i=0;i<50;i++){try{const response=await fetch(`http://127.0.0.1:${port}/v1/health`);if(response.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}
 if(!ready)throw new Error(`Isolated backend did not start. Set EZPZ_BACKEND_REPO if needed.\n${serverErrors}`)
 const test=spawn(path.resolve('node_modules/.bin/tsx'),['tests/api.integration.ts'],{env:{...process.env,STUDIO_TEST_URL:`http://127.0.0.1:${port}`},stdio:'inherit'})
 const result=await new Promise(resolve=>test.on('exit',resolve));if(result!==0)process.exitCode=1
}finally{server.kill('SIGTERM');await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));await rm(root,{recursive:true,force:true})}
