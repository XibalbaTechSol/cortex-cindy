'use strict';
const $=id=>document.getElementById(id),channel=new BroadcastChannel('cortex-cindy');
const defaults={mode:'local',executable:'',home:'',agentId:'',endpoint:'',recording:false,historyCapture:false,historyDatabase:'',archiveFiles:false,captureActivity:false};
let revision=0;
const saves=new Map();
function saveSettings(cfg){
 const id=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{saves.delete(id);reject(new Error('Settings save was not confirmed. Reload settings and check the recording state.'));},10000);
  saves.set(id,{resolve,reject,timer});channel.postMessage({type:'save-settings',id,config:cfg,expectedRevision:revision});
 });
}
const fields=['mode','executable','home','agentId','endpoint','historyDatabase'];
function message(t){$('message').textContent=t;}
async function request(path,options){const r=await fetch(path,options);if(!r.ok)throw new Error('Settings could not be saved. Reopen this page and retry.');return r;}
function mode(){ $('local').hidden=$('mode').value!=='local';$('hosted').hidden=$('mode').value!=='hosted';}
async function secretState(){const data=await(await request('/secrets')).json();const entries=Array.isArray(data)?data:(data.secrets||[]);const saved=Array.isArray(entries)?entries.some(x=>x.key==='cortex_token'&&x.saved):Boolean(entries.cortex_token?.saved);$('token-state').textContent=saved?'A token is stored in Cindy’s protected vault.':'No hosted token saved.';}
async function load(){const cfg={...defaults,...await(await request('/kv')).json()};revision=Number.isSafeInteger(cfg.settingsRevision)?cfg.settingsRevision:0;fields.forEach(k=>$(k).value=cfg[k]);$('recording').checked=cfg.recording;$('historyCapture').checked=cfg.historyCapture;$('archiveFiles').checked=cfg.archiveFiles;$('captureActivity').checked=cfg.captureActivity;mode();await secretState();await request('/wake');channel.postMessage({type:'status-request'});}
$('mode').onchange=mode;
$('settings').onsubmit=async e=>{e.preventDefault();try{const cfg={};fields.forEach(k=>cfg[k]=$(k).value.trim());cfg.recording=$('recording').checked;cfg.historyCapture=$('historyCapture').checked;cfg.archiveFiles=$('archiveFiles').checked;cfg.captureActivity=$('captureActivity').checked;
  if((cfg.archiveFiles||cfg.captureActivity)&&!cfg.historyCapture)throw new Error('File snapshots and activity metadata require history capture.');
  if(cfg.historyCapture&&(cfg.mode!=='local'||!cfg.historyDatabase.startsWith('/')||!cfg.recording))throw new Error('History capture requires local Cortex, an absolute database path, and recording enabled.');
  if(cfg.mode==='hosted'){const u=new URL(cfg.endpoint);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('Use an HTTPS MCP URL without credentials, query parameters, or fragments.');}
  else if(!cfg.executable.startsWith('/')||!cfg.home.startsWith('/'))throw new Error('Use absolute executable and profile paths.');
  if($('token').value){await request('/secrets/cortex_token',{method:'PUT',body:JSON.stringify({value:$('token').value})});$('token').value='';}
  await request('/wake');await saveSettings(cfg);await secretState();message(cfg.recording?'Saved. Recording is enabled.':'Saved. Recording is paused.');
}catch(e){message(e.message);}};
$('clear-token').onclick=async()=>{try{await request('/secrets/cortex_token',{method:'DELETE'});$('token').value='';await secretState();message('Saved token removed.');}catch(e){message(e.message);}};
let testTimer;
$('test').onclick=async()=>{try{$('test').disabled=true;message('Checking saved connection…');await request('/wake');channel.postMessage({type:'test-connection'});testTimer=setTimeout(()=>{$('test').disabled=false;message('Connection check timed out. Check the saved settings and retry.');},40000);}catch(e){$('test').disabled=false;message(e.message);}};
channel.onmessage=e=>{const d=e.data;if(d.type==='settings-result'){const pending=saves.get(d.id);if(!pending)return;clearTimeout(pending.timer);saves.delete(d.id);if(d.ok){revision=d.revision;pending.resolve();}else pending.reject(new Error(d.message));}if(d.type==='connection-result'){clearTimeout(testTimer);$('test').disabled=false;message(d.ok?'Connected: Cortex memory_status succeeded.':d.message);}if(d.type==='status')$('status').textContent=`This run: ${d.recorded} recorded · ${d.skipped} skipped · ${d.failed} failed. ${d.lastResult}`;};
load().catch(e=>message(e.message));
