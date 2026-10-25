
'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),headless:true,args:['--no-sandbox']});let total=0;
 try{for(const theme of ['light','dark'])for(const width of [320,850]){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));let cfg={};let tokenSaved=false;
  await context.route('https://plugin.test/**',async route=>{const url=new URL(route.request().url());const name=url.pathname.slice(1)||'settings.html';const req=route.request();
   if(name==='runtime.html')return route.fulfill({contentType:'text/html',body:'<script>globalThis.cindy={onHostMessage(){},send(){},node:{request:async()=>({ok:true,result:{content:[]}})}};</script><script src="/main.js"></script>'});
   if(name==='kv'){if(req.method()==='PUT'){assert.ok(req.frame().url().endsWith('/runtime.html'));cfg=req.postDataJSON();return route.fulfill({status:204});}return route.fulfill({json:cfg});}
   if(name==='secrets')return route.fulfill({json:[{key:'cortex_token',saved:tokenSaved}]});
   if(name==='secrets/cortex_token'){tokenSaved=req.method()==='PUT';return route.fulfill({status:204});}
   if(name==='wake')return route.fulfill({json:{state:'awake'}});
   const f=path.join(__dirname,'..',name);return route.fulfill({body:fs.readFileSync(f),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
  });
  const runtime=await context.newPage();await runtime.goto('https://plugin.test/runtime.html');
  await page.goto('https://plugin.test/');await page.locator('#token-state').filter({hasText:'No hosted token saved.'}).waitFor({state:'attached'});
  assert.equal(await page.locator('#executable').inputValue(),'');assert.equal(await page.locator('#home').inputValue(),'');
  await page.addStyleTag({content:`:root{color-scheme:${theme};--text-primary:${theme==='dark'?'#eee':'#111'};--text-secondary:${theme==='dark'?'#ccc':'#555'};--surface:${theme==='dark'?'#222':'#fff'};--border-default:${theme==='dark'?'#777':'#aaa'}}`});
  assert.equal(await page.locator('#recording').isChecked(),false);assert.equal(await page.locator('#hosted').isVisible(),false);
  await page.locator('#mode').selectOption('hosted');await page.locator('#endpoint').fill('https://cortex.example/mcp');await page.locator('#token').fill('test-token-not-a-real-secret');await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.getByRole('status').filter({hasText:'Saved. Recording is paused.'}).waitFor();
  assert.ok(tokenSaved);assert.equal(cfg.endpoint,'https://cortex.example/mcp');assert.equal('token' in cfg,false);assert.equal(await page.locator('#token').inputValue(),'');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);assert.deepEqual(errors,[]);
  // Two independently loaded settings windows: the stale one must not restart capture.
  await page.locator('#recording').check();await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.locator('#message').filter({hasText:'Saved. Recording is enabled.'}).waitFor();
  const stale=await context.newPage();await stale.goto('https://plugin.test/');await stale.locator('#token-state').filter({hasText:'A token is stored'}).waitFor({state:'attached'});assert.equal(await stale.locator('#recording').isChecked(),true);
  await page.locator('#recording').uncheck();await page.getByRole('button',{name:'Save settings',exact:true}).click();await page.locator('#message').filter({hasText:'Saved. Recording is paused.'}).waitFor();
  await stale.getByRole('button',{name:'Save settings',exact:true}).click();await stale.locator('#message').filter({hasText:'Settings changed in another window or tool.'}).waitFor();assert.equal(cfg.recording,false);
  total++;await context.close();
 }console.log(`Settings UI: ${total} viewport/theme combinations passed; vault-only token storage, default pause, resident-only writes and stale-window rejection verified.`);}finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
