'use strict';
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const path=require('node:path');
const ALLOWED=new Set(['memory_status','memory_remember','memory_hybrid_retrieve','memory_verify_chain','memory_retrieval_trace','memory_ingest_agent_turn']);
const MAX=900000;
function fail(message){throw new Error(message);}
function parseBody(body,id){
  if(Buffer.byteLength(body)>MAX)fail('Cortex response too large. Reduce the query size.');
  const trimmed=body.trim();
  if(trimmed.startsWith('{')){const x=JSON.parse(trimmed);if(x.id===id)return x;}
  for(const block of body.split(/\r?\n\r?\n/)){
    const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(data){const x=JSON.parse(data);if(x.id===id)return x;}
  }
  fail('Cortex returned no matching MCP response. Check the endpoint.');
}
function unwrap(x){
  if(x.error)fail('Cortex rejected the MCP request. Check profile identity, token scope, and tool arguments.');
  const r=x.result;
  if(r?.isError)fail('Cortex tool failed. Check profile identity, token scope, and tool arguments.');
  return r;
}
async function hosted(cfg,token,name,args){
  let url;try{url=new URL(cfg.endpoint);}catch{fail('Set a valid HTTPS MCP endpoint in plugin settings.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)fail('Use an HTTPS MCP URL without credentials, query parameters, or fragments.');
  if(!token)fail('Save your hosted Cortex bearer token in plugin settings.');
  let session,version='2024-11-05';
  async function post(payload,expect=true){
    const headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':`Bearer ${token}`,'MCP-Protocol-Version':version};
    if(session)headers['Mcp-Session-Id']=session;
    let r;try{r=await fetch(url,{method:'POST',redirect:'error',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});}catch{fail('Cannot reach hosted Cortex. Check the HTTPS endpoint and network; then retry.');}
    if(!r.ok){await r.body?.cancel();fail(`Cortex HTTP ${r.status}. Check endpoint, token expiry, and scopes; then retry.`);}
    session=r.headers.get('mcp-session-id')||session;
    if(!expect){await r.body?.cancel();return;}
    let body='';const reader=r.body.getReader(),decoder=new TextDecoder();
    // Streaming MCP may keep an SSE response open. Stop at the matching result.
    while(true){const {done,value}=await reader.read();if(done)break;body+=decoder.decode(value,{stream:true});if(Buffer.byteLength(body)>MAX){await reader.cancel();fail('Cortex response too large. Reduce the query size.');}
      if(r.headers.get('content-type')?.includes('text/event-stream')){try{const result=parseBody(body,payload.id);await reader.cancel();return result;}catch(e){if(e.message.includes('too large'))throw e;}}
    }
    return parseBody(body,payload.id);
  }
  const init=unwrap(await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:version,capabilities:{},clientInfo:{name:'cortex-cindy',version:'0.1.0'}}}));
  version=init.protocolVersion;
  try{
    await post({jsonrpc:'2.0',method:'notifications/initialized'},false);
    return unwrap(await post({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}}));
  }finally{
    if(session)try{const r=await fetch(url,{method:'DELETE',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Mcp-Session-Id':session,'MCP-Protocol-Version':version},signal:AbortSignal.timeout(2000)});await r.body?.cancel();}catch{}
  }
}
function local(cfg,name,args){
  return new Promise((resolve,reject)=>{
    if(!cfg.executable?.startsWith('/')||!cfg.home?.startsWith('/'))return reject(new Error('Set absolute Cortex executable and profile paths in plugin settings.'));
    const env={...process.env,XIBALBA_CORTEX_HOME:cfg.home};
    delete env.XIBALBA_CORTEX_ALLOW_UNSCOPED_STDIO;delete env.XIBALBA_AGENT_ID;
    if(cfg.agentId)env.XIBALBA_AGENT_ID=cfg.agentId;
    const cp=spawn(cfg.executable,[],{env,stdio:['pipe','pipe','pipe'],shell:false});
    let finished=false,buffer='';
    const timer=setTimeout(()=>finish(new Error('Local Cortex timed out. Check the executable and profile identity; then retry.')),25000);
    function finish(err,value){if(finished)return;finished=true;clearTimeout(timer);cp.kill();err?reject(err):resolve(value);}
    const send=x=>cp.stdin.write(JSON.stringify(x)+'\n');
    cp.on('error',()=>finish(new Error('Cannot start local Cortex. Check the executable path and its installed dependencies.')));
    cp.stdin.on('error',()=>{});cp.stderr.resume();
    cp.on('exit',()=>finish(new Error('Local Cortex exited. Check the profile DID or explicit agent ID and backend dependencies.')));
    cp.stdout.setEncoding('utf8');
    cp.stdout.on('data',chunk=>{
      buffer+=chunk.toString();if(Buffer.byteLength(buffer)>MAX)return finish(new Error('Cortex response too large. Reduce the query size.'));
      let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);if(!line.trim())continue;
        try{const x=JSON.parse(line);if(x.id===1){unwrap(x);send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}});}else if(x.id===2)finish(null,unwrap(x));else if(x.id!==undefined&&x.method)send({jsonrpc:'2.0',id:x.id,error:{code:-32601,message:'Unsupported server request'}});}catch{finish(new Error('Local Cortex returned an invalid or failed MCP response. Check backend configuration and tool arguments.'));}
      }
    });
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'cortex-cindy',version:'0.1.0'}}});
  });
}
function history(request){
  const cfg=request.params?.config;
  if(!cfg||cfg.mode!=='local')return Promise.reject(new Error('History capture requires local Cortex.'));
  return new Promise((resolve,reject)=>{
    const cp=spawn(path.join(path.dirname(cfg.executable),'python'),[path.join(__dirname,'capture.py')],{stdio:['pipe','pipe','pipe'],shell:false});
    let out='',done=false;
    const timer=setTimeout(()=>finish(new Error('History capture timed out; checkpoint retained for retry.')),90000);
    function finish(err,value){if(done)return;done=true;clearTimeout(timer);cp.kill();err?reject(err):resolve(value);}
    cp.on('error',()=>finish(new Error('Cannot start the installed Cortex Python environment.')));
    cp.stderr.resume();cp.stdin.on('error',()=>{});
    cp.stdout.on('data',b=>{out+=b;if(Buffer.byteLength(out)>MAX)finish(new Error('History capture response exceeded its limit.'));});
    cp.on('exit',()=>{if(done)return;try{const value=JSON.parse(out);if(!value.ok)throw new Error(value.error||'History capture failed; checkpoint retained.');finish(null,value);}catch(e){finish(new Error(e.message.startsWith('History capture')?e.message:'History capture failed; check the source database, schema, profile and installed backend.'));}});
    cp.stdin.end(JSON.stringify({config:cfg,operation:({'capture/validate':'validate','capture/audit':'audit','capture/activities':'activities'})[request.method]||'sync',events:request.params?.events,sessionId:request.params?.sessionId,limit:request.params?.limit||50}));
  });
}
async function handle(request){
  if(['capture/validate','capture/sync','capture/audit','capture/activities'].includes(request.method))return history(request);
  const {config:cfg,name,args={}}=request.params||{};
  if(!cfg||!ALLOWED.has(name))fail('Unsupported Cortex operation. Use a declared plugin tool.');
  if(Buffer.byteLength(JSON.stringify(args))>210000)fail('Capture too large. Shorten the message or use Cortex ingestion directly.');
  if(request.method==='local/call'&&cfg.mode==='local')return local(cfg,name,args);
  if(request.method==='hosted/call'&&cfg.mode==='hosted')return hosted(cfg,request.cindy?.secrets?.cortex_token,name,args);
  fail('Choose local or hosted mode in plugin settings.');
}
if(require.main===module||globalThis.__CINDY_NODE__){readline.createInterface({input:process.stdin}).on('line',async line=>{let r;try{r=JSON.parse(line);const result=await handle(r);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');}catch(e){if(r?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:e.message}})+'\n');}});}
module.exports={handle,parseBody,local,hosted};
