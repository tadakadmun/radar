/* Free offline assets. App updates wait until old app windows close. */
const SHELL_CACHE='navassist-shell-free-20260927-r1';
const AI_CACHE='navassist-ai-v1';
const BASE=new URL('./',self.location.href);
const CORE=[ './','./index.html','./style.css','./manifest.json',
  './js/main.js','./js/ui.js','./js/camera.js','./js/detector.js','./js/detector-worker.js',
  './js/assets.js','./js/offline.js','./js/tracker.js','./js/lane.js','./js/vision.js',
  './js/alerts.js','./js/geo.js','./js/osm.js','./js/store.js','./js/health.js','./js/calibrate.js','./js/util.js' ];
const OPTIONAL=['./icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png'];
const urls=list=>list.map(p=>new URL(p,BASE).href);
const CORE_URLS=urls(CORE), ALL_URLS=new Set(urls([...CORE,...OPTIONAL]));
const LIB='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';
const AI_URLS=[`${LIB}/vision_bundle.mjs`,`${LIB}/wasm/vision_wasm_internal.js`,`${LIB}/wasm/vision_wasm_internal.wasm`,`${LIB}/wasm/vision_wasm_nosimd_internal.js`,`${LIB}/wasm/vision_wasm_nosimd_internal.wasm`,'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite'];
const AI_SET=new Set(AI_URLS), preparations=new Map();
function valid(res,url){
  if(!res||!res.ok||res.type==='opaque')return false;
  const type=(res.headers.get('content-type')||'').toLowerCase();
  if(/\.(mjs|js)$/.test(url))return /(?:java|ecma)script/.test(type);
  if(/\.wasm$/.test(url))return type.includes('wasm')||type.includes('octet-stream');
  if(/\.tflite$/.test(url))return type.includes('octet-stream')||type.includes('flatbuffer');
  if(/\.css$/.test(url))return type.includes('text/css');
  if(/\.json$/.test(url))return type.includes('json');
  if(/\.png$/.test(url))return type.includes('image/png');
  return type.includes('text/html');
}
async function getNetwork(url,signal){const res=await fetch(url,{cache:'no-store',signal});if(!valid(res,url))throw new Error('โหลดไฟล์ไม่ถูกต้อง: '+new URL(url).pathname.split('/').pop()+' (HTTP '+res.status+')');return res;}
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(SHELL_CACHE);
    try{
      await Promise.all(CORE_URLS.map(async url=>{const res=await getNetwork(url,AbortSignal.timeout(20000));await cache.put(url,res);}));
    }catch(e){await caches.delete(SHELL_CACHE);throw e;}
    await Promise.allSettled(urls(OPTIONAL).map(async url=>{await cache.put(url,await getNetwork(url,AbortSignal.timeout(10000)));}));
    // No skipWaiting: a running driving session keeps one coherent app version.
  })());
});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  const target=await caches.open(AI_CACHE);
  // Preserve valid, pinned AI files from this app's legacy cache before retiring it.
  for(const name of await caches.keys()){
    if(!/^navassist-v\d+$/.test(name))continue;
    const old=await caches.open(name);
    for(const url of AI_URLS){if(await target.match(url))continue;const res=await old.match(url);if(valid(res,url))await target.put(url,res);}
  }
  for(const name of await caches.keys()){
    if(name!==SHELL_CACHE&&(/^navassist-shell-/.test(name)||/^navassist-v\d+$/.test(name)))await caches.delete(name);
  }
  await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
  const req=event.request;if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(AI_SET.has(url.href)){
    // Inference cannot silently download anything. Preparation is an explicit user action.
    event.respondWith((async()=>{const hit=await (await caches.open(AI_CACHE)).match(req);return valid(hit,url.href)?hit:new Response('ต้องเตรียม AI ออฟไลน์ก่อนเริ่ม',{status:503});})());return;
  }
  if(url.origin!==BASE.origin||!url.pathname.startsWith(BASE.pathname))return;
  const canonical=url.origin+url.pathname;
  if(!ALL_URLS.has(canonical)&&req.mode!=='navigate')return;
  event.respondWith((async()=>{
    const cache=await caches.open(SHELL_CACHE),key=req.mode==='navigate'?new URL('index.html',BASE).href:canonical;
    const hit=await cache.match(key);
    return valid(hit,key)?hit:new Response('ไฟล์แอปไม่ครบ โปรดเชื่อมต่อ Wi-Fi แล้วซ่อมไฟล์แอป',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});
  })());
});
async function status(){
  const shell=await caches.open(SHELL_CACHE),ai=await caches.open(AI_CACHE),missing=[];
  for(const u of CORE_URLS)if(!valid(await shell.match(u),u))missing.push(u);
  for(const u of AI_URLS)if(!valid(await ai.match(u),u))missing.push(u);
  return {ready:missing.length===0,missing:missing.map(u=>new URL(u).pathname.split('/').pop()),version:SHELL_CACHE};
}
self.addEventListener('message',event=>{
  const port=event.ports?.[0],clientId=event.source?.id;
  if(!port||!clientId)return;
  const send=value=>port.postMessage(value);
  event.waitUntil((async()=>{
    try{
      if(event.data?.type==='OFFLINE_STATUS'){send({done:true,...await status()});return;}
      if(event.data?.type==='CANCEL_PREPARE'){preparations.get(clientId)?.abort();send({done:true});return;}
      if(event.data?.type!=='PREPARE_OFFLINE')return;
      if(preparations.has(clientId))throw new Error('กำลังเตรียมไฟล์อยู่');
      const ctrl=new AbortController();preparations.set(clientId,ctrl);
      try{
        const cache=await caches.open(AI_CACHE);
        for(let i=0;i<AI_URLS.length;i++){
          const url=AI_URLS[i];send({progress:true,completed:i,total:AI_URLS.length,file:new URL(url).pathname.split('/').pop()});
          if(ctrl.signal.aborted)throw new Error('ยกเลิกการดาวน์โหลด');
          const old=await cache.match(url);if(valid(old,url))continue;
          const timer=setTimeout(()=>ctrl.abort(),90000);
          try{
            const response=await getNetwork(url,ctrl.signal),bytes=await response.arrayBuffer();
            if(bytes.byteLength<32)throw new Error('ไฟล์ AI ไม่สมบูรณ์');
            const head=new Uint8Array(bytes,0,8);
            if(url.endsWith('.wasm')&&!(head[0]===0&&head[1]===97&&head[2]===115&&head[3]===109))throw new Error('ไฟล์ WASM ไม่ถูกต้อง');
            if(url.endsWith('.tflite')&&String.fromCharCode(...head.slice(4,8))!=='TFL3')throw new Error('ไฟล์โมเดลไม่ถูกต้อง');
            await cache.put(url,new Response(bytes,{status:200,headers:response.headers}));
          }finally{clearTimeout(timer);}
        }
        send({done:true,...await status()});
      }finally{preparations.delete(clientId);}
    }catch(e){send({done:true,error:e?.message||'เตรียมไฟล์ไม่สำเร็จ'});}
  })());
});
