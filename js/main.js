/* Free local driving-warning prototype. Explicit asset download; no paid API. */
import {Camera} from './camera.js';
import {Detector,CLASS_TH} from './detector.js';
import {Tracker,assessCollision} from './tracker.js';
import {LaneFinder,assessDeparture,resetDeparture} from './lane.js';
import {VisionMeter} from './vision.js';
import {Alerts,LEVEL} from './alerts.js';
import {Geo} from './geo.js';
import {RoadData,assessSpeed,assessCurve,resetRoadAssessments} from './osm.js';
import {Health,STATE} from './health.js';
import {UI} from './ui.js';
import {Offline} from './offline.js';
import * as calib from './calibrate.js';
const $=id=>document.getElementById(id);
const ui=new UI(),camera=new Camera(ui.video),detector=new Detector(),tracker=new Tracker(),laneFinder=new LaneFinder(),vision=new VisionMeter(),alerts=new Alerts(),geo=new Geo(),roads=new RoadData(),health=new Health(),offline=new Offline();
const sample=document.createElement('canvas'),sctx=sample.getContext('2d',{willReadFrequently:true});
let running=false,starting=false,calibMode=false,preparing=false,soundOn=true,generation=0,qualityGeneration=0;
let lastAnalysis=0,lastInfer=0,lastRoad=0,analysisFrame=-1,inferFrame=-1;
let tracks=[],lane={ok:false,notices:[],confidence:0,offset:null},visionState={level:2,night:false,reason:'ยังไม่มีภาพใหม่'},threat={level:0,track:null},roadMatch=null,notice='เตรียม AI ผ่าน Wi-Fi แล้วตั้งกล้องขณะจอด';
function clearVisual(){qualityGeneration++;tracker.reset();laneFinder.reset();resetDeparture();tracks=[];lane={ok:false,notices:[],confidence:0,offset:null};threat={level:0,track:null};alerts.dismiss(['fcw','ldw']);}
function grabFrame(){const w=256,h=Math.max(72,Math.round(w*ui.video.videoHeight/ui.video.videoWidth));if(!h||!ui.video.videoWidth)return null;if(sample.width!==w||sample.height!==h){sample.width=w;sample.height=h;}sctx.drawImage(ui.video,0,0,w,h);return {data:sctx.getImageData(0,0,w,h).data,w,h};}
function loop(){
  if(!running)return;
  const now=performance.now(),token=generation;
  if(calibMode&&geo.moving){calibMode=false;ui.closeCalib();clearVisual();notice='ปิดการตั้งค่าเนื่องจากรถเคลื่อนที่';}
  if(camera.ready&&camera.frameId!==analysisFrame&&now-lastAnalysis>110){
    analysisFrame=camera.frameId;lastAnalysis=now;
    try{const frame=grabFrame();if(frame){const old=visionState.level;visionState=vision.update(frame,camera.settings());if(visionState.level>=2&&old<2)clearVisual();lane=visionState.level<2?laneFinder.update(frame,geo.hasSpeed?geo.speedKmh:0):{ok:false,notices:[],confidence:0,offset:null};}}
    catch(e){clearVisual();health.fail('อ่านภาพกล้องไม่สำเร็จ');}
  }
  if(camera.ready&&!detector.busy&&camera.frameId!==inferFrame&&now-lastInfer>[180,260,400][health.degradeLevel]){
    inferFrame=camera.frameId;lastInfer=now;const capturedAt=performance.now(),quality=qualityGeneration;
    detector.detect(ui.video,.45,capturedAt).then(dets=>{
      if(!running||token!==generation||!dets)return;
      health.markInference(capturedAt,detector.lastLatency);
      if(performance.now()-capturedAt>900||quality!==qualityGeneration){clearVisual();return;}
      tracks=tracker.update(dets,capturedAt,{width:ui.video.videoWidth,height:ui.video.videoHeight,corridor:calib.egoCorridor(ui.video.videoWidth,ui.video.videoHeight),focalPx:null});
      threat=assessCollision(tracks,geo.hasSpeed?geo.speedKmh:0,geo.hasSpeed);
    }).catch(e=>{if(running&&token===generation){clearVisual();health.fail(e.message||'AI ขัดข้อง');}});
  }
  health.tick(now,camera.ready,{frameAge:camera.frameAge(now),visionLevel:visionState.level,calibrated:calib.isVerified(ui.video.videoWidth,ui.video.videoHeight),visible:document.visibilityState==='visible'});
  if(!health.trustworthy||calibMode){threat={level:0,track:null};alerts.dismiss(['fcw','ldw']);}
  if(now-lastRoad>=1000){lastRoad=now;updateRoadData();}
  decide(Date.now());render();requestAnimationFrame(loop);
}
function updateRoadData(){
  if(!roads.settings.enabled||!geo.hasFix){roadMatch=null;return;}
  roads.update(geo.lat,geo.lon,geo.heading,geo.hasSpeed?geo.speedKmh:0).catch(()=>{});
  roadMatch=geo.hasSpeed?roads.match(geo.lat,geo.lon,geo.heading,geo.speedKmh,geo.accuracy):null;
}
function decide(now){
  if(calibMode)return;
  if(health.trustworthy&&visionState.level<2){
    if(threat.level){const what=CLASS_TH[threat.track?.cls]||'วัตถุ';alerts.fire('fcw',threat.level===2?LEVEL.CRITICAL:LEVEL.WARN,threat.level===2?`ระวังชน${what}ด้านหน้า`:`เข้าใกล้${what}ด้านหน้า`,'ระวังด้านหน้า');return;}
    const dep=assessDeparture(lane,geo.hasSpeed?geo.speedKmh:0,now);
    if(dep.fire){const side=dep.side==='left'?'ซ้าย':'ขวา';alerts.fire('ldw',LEVEL.WARN,`รถเบี่ยงใกล้ขอบเลน${side}`,`ระวังขอบเลน${side}`);return;}
  }
  if(health.state===STATE.FAILED){alerts.clear();return;}
  if(!geo.hasSpeed)return;
  const cv=assessCurve(roadMatch,geo.speedKmh,now);
  if(cv){alerts.fire('curve',LEVEL.WARN,`แผนที่มีโค้งข้างหน้าราว ${cv.distanceM} ม.`,'โค้งข้างหน้า ดูถนนและชะลอ');return;}
  const sp=assessSpeed(roadMatch,geo.speedKmh,now);
  if(sp)alerts.fire('speed',LEVEL.INFO,`เร็วเกินข้อมูลแผนที่ ${sp.limit} กม./ชม.`,'ตรวจป้ายจำกัดความเร็ว');
}
function baselineBand(){
  if(calibMode)return {tone:'idle',text:'ตั้งกล้องขณะจอด',sub:'เลื่อนเส้นให้ตรงถนน แล้วกดยืนยัน'};
  if(health.state===STATE.FAILED)return {tone:'critical',text:'ระบบไม่พร้อม',sub:health.reason};
  if(starting)return {tone:'idle',text:'กำลังเตรียมระบบ',sub:health.reason||''};
  if(!running)return {tone:'idle',text:'ระบบยังไม่เริ่มทำงาน',sub:notice};
  if(!health.trustworthy)return {tone:'warn',text:'การเตือนจากภาพยังไม่พร้อม',sub:health.reason||visionState.reason||'กำลังรอผลตรวจจับ'};
  return {tone:visionState.level===1?'warn':'ok',text:'กำลังเฝ้าระวัง',sub:!geo.hasSpeed?'ยังไม่มีความเร็วที่เชื่อถือได้ การเตือนบางอย่างจะไม่ทำงาน':visionState.reason||'ผู้ขับต้องมองถนนและควบคุมรถตลอดเวลา'};
}
function render(){
  const active=alerts.active(),base=baselineBand();
  ui.showBand(health.state===STATE.FAILED?null:active,base);
  ui.showSpeed(geo);ui.showLimit(roadMatch);ui.showLane(calib.isVerified(ui.video.videoWidth,ui.video.videoHeight)?lane:{ok:false});ui.setNight(visionState.night);
  ui.setLocked((running&&geo.moving)||starting||preparing);ui.showSystem(health.state,health.reason,roads.status);
  $('prepareBtn').disabled=running||starting||preparing||calibMode;$('cancelDownloadBtn').hidden=!preparing;
  $('startBtn').disabled=preparing||calibMode;
  if(calibMode)ui.drawCalibGuides();else ui.draw(tracks,laneFinder,threat,health.trustworthy&&running);
  ui.setSoundLabel(soundOn,alerts.hasThaiVoice);
}
async function start(){
  if(starting||running||preparing||calibMode)return;
  starting=true;const token=++generation;ui.setStartLabel(true);health.start();render();
  try{
    const status=await offline.status();if(token!==generation)return;
    if(!status.ready)throw new Error('ยังเตรียม AI ไม่ครบ กด “เตรียม AI ฟรีผ่าน Wi-Fi” ก่อน');
    await camera.open();if(token!==generation){camera.close();return;}
    camera.onLost=reason=>{clearVisual();health.fail(reason);render();};
    await detector.load(msg=>{health.reason=msg;render();});if(token!==generation){camera.close();detector.close();return;}
    health.start();geo.start();health.requestWakeLock();running=true;starting=false;
    lastAnalysis=lastInfer=lastRoad=0;analysisFrame=inferFrame=-1;vision.reset();clearVisual();ui.setStartLabel(true);requestAnimationFrame(loop);
  }catch(e){
    if(token!==generation)return;
    running=false;starting=false;camera.close();detector.close();geo.stop();health.releaseWakeLock();health.fail(e.message||'เริ่มระบบไม่สำเร็จ');ui.setStartLabel(false);render();
  }
}
function stop(message='หยุดระบบแล้ว'){generation++;running=false;starting=false;calibMode=false;ui.closeCalib();clearVisual();alerts.clear();camera.close();detector.close();geo.stop();health.stop();vision.reset();visionState={level:2,night:false};roadMatch=null;resetRoadAssessments();ui.setStartLabel(false);notice=message;render();}
async function openCalibration(){
  if(starting||preparing||(running&&geo.moving))return;
  calibMode=true;clearVisual();ui.openCalib();syncOsmUi();render();
  const token=generation;
  try{if(!camera.ready)await camera.open();if(token!==generation||!calibMode)return;preview();}
  catch(e){$('calibStatus').textContent=e.message||'เปิดกล้องไม่ได้';}
}
function preview(){if(!calibMode)return;ui.drawCalibGuides();requestAnimationFrame(preview);}
function closeCalibration(confirm=false){
  if(confirm){if((running&&geo.moving)||!camera.ready){$('calibStatus').textContent='ต้องจอดและเห็นภาพกล้องก่อนยืนยัน';return;}calib.confirm(ui.video.videoWidth,ui.video.videoHeight);}
  calibMode=false;ui.closeCalib();clearVisual();if(!running)camera.close();render();
}
$('startBtn').addEventListener('click',()=>{if(running||starting){stop();return;}alerts.primeFromUserGesture();start();});
$('soundBtn').addEventListener('click',()=>{soundOn=!soundOn;alerts.setEnabled(soundOn);render();});
$('calibBtn').addEventListener('click',openCalibration);
$('calibDone').addEventListener('click',()=>closeCalibration(true));
$('calibCancel').addEventListener('click',()=>closeCalibration(false));
$('calibReset').addEventListener('click',()=>{if(running&&geo.moving)return;calib.reset();clearVisual();ui.openCalib();render();});
ui.bindCalib(()=>{if(running&&geo.moving){closeCalibration(false);return;}clearVisual();$('calibStatus').textContent='ปรับแล้ว กรุณายืนยันเมื่อเส้นตรงกับถนน';render();});
function syncOsmUi(){ $('osmEnabled').checked=roads.settings.enabled;$('osmBudget').value=roads.settings.budgetMB;$('osmBudgetVal').textContent=roads.settings.budgetMB;$('osmUsage').textContent=`ข้อมูลที่อ่านในรอบนี้ประมาณ ${roads.dataUsedMB.toFixed(2)} MB (ไม่รวมไฟล์ AI/ส่วนเกินของเครือข่าย)`; }
$('osmEnabled').addEventListener('change',()=>{roads.setSettings({enabled:$('osmEnabled').checked,consentV:1});roadMatch=null;resetRoadAssessments();syncOsmUi();render();});
$('osmBudget').addEventListener('input',()=>{roads.setSettings({budgetMB:Number($('osmBudget').value)});syncOsmUi();});
$('osmClear').addEventListener('click',async()=>{try{await roads.clearCache();}catch(e){notice=e.message;}roadMatch=null;syncOsmUi();render();});
$('prepareBtn').addEventListener('click',async()=>{
  if(running||starting||preparing||calibMode)return;
  preparing=true;$('offlineStatus').textContent='กำลังเตรียมไฟล์ โปรดใช้ Wi-Fi ที่มีอยู่';render();
  try{const result=await offline.prepare(p=>{$('offlineStatus').textContent=`ดาวน์โหลด ${p.completed+1}/${p.total}: ${p.file}`;});$('offlineStatus').textContent=result.ready?'ไฟล์แอปและ AI พร้อมออฟไลน์แล้ว':`ไฟล์ยังไม่ครบ: ${result.missing.join(', ')}`;}
  catch(e){$('offlineStatus').textContent=e.message;}
  finally{preparing=false;render();}
});
$('cancelDownloadBtn').addEventListener('click',()=>offline.cancel().catch(()=>{}));
const repair=async()=>{
  if(running||starting||preparing)return;
  const scope=new URL('./',location.href).href;
  for(const reg of await navigator.serviceWorker?.getRegistrations?.()||[])if(reg.scope===scope)await reg.unregister();
  for(const name of await caches.keys())if(name.startsWith('navassist-shell-')||/^navassist-v\d+$/.test(name))await caches.delete(name);
  location.reload();
};
$('repairBtn').addEventListener('click',()=>repair().catch(e=>{$('offlineStatus').textContent=e.message;}));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible'&&(running||starting||calibMode)){stop('พักระบบเมื่อสลับแอป กดเริ่มใหม่ได้ทันที (ถ้าขยับแท่นกล้อง ให้จอดแล้วตั้งกล้องใหม่)');}});
window.addEventListener('pagehide',()=>{if(running||starting||calibMode)stop();if(preparing)offline.cancel().catch(()=>{});});
health.onChange=()=>render();alerts.onShow=()=>render();
offline.onUpdate=()=>{$('offlineStatus').textContent='มีรุ่นใหม่ กรุณาปิดแอปทุกหน้าแล้วเปิดอีกครั้งเมื่อจอด';};
syncOsmUi();ui.setStartLabel(false);render();window.__navAssistBooted=true;
offline.status().then(s=>{$('offlineStatus').textContent=s.ready?'ไฟล์แอปและ AI พร้อมออฟไลน์แล้ว':'ยังไม่ได้เตรียม AI ออฟไลน์ — ดาวน์โหลดฟรีผ่าน Wi-Fi ประมาณ 27 MB';}).catch(e=>{$('offlineStatus').textContent=e.message;});
