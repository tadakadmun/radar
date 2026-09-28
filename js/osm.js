/* Optional public road data. OFF by default. Queries reveal an approximate location tile. */
import {toLocalMeters,circleRadius,clamp} from './util.js';
import * as store from './store.js';
const ENDPOINTS=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
const TILE=.02,MARGIN=.003,TTL=7*24*3600*1000,PREFIX='osm:',KEY='navassist.osm.settings';
const tileId=(lat,lon)=>`${PREFIX}${Math.floor(lat/TILE)}_${Math.floor(lon/TILE)}`;
const diff=(a,b)=>{const d=Math.abs(a-b)%360;return Math.min(d,360-d);};
function bearing(a,b){const p=toLocalMeters(b.lat,b.lon,a.lat,a.lon);return (Math.atan2(p.x,p.y)*180/Math.PI+360)%360;}
export function parseMaxspeed(tag){const s=String(tag||'').trim().toLowerCase();const m=s.match(/^(\d+(?:\.\d+)?)\s*(km\/h|kph|kmh|mph)?$/);if(!m)return null;const value=Number(m[1])*(m[2]==='mph'?1.609344:1);return value>0&&value<=160?Math.round(value):null;}
function projection(lat,lon,a,b){const p=toLocalMeters(lat,lon,a.lat,a.lon),q=toLocalMeters(b.lat,b.lon,a.lat,a.lon),len=q.x*q.x+q.y*q.y,t=len?clamp((p.x*q.x+p.y*q.y)/len,0,1):0;return {distance:Math.hypot(p.x-q.x*t,p.y-q.y*t),point:{lat:a.lat+(b.lat-a.lat)*t,lon:a.lon+(b.lon-a.lon)*t}};}
export class RoadData {
 constructor(){this.loaded=new Map();this.pending=new Set();this.lastFetch=0;this.bytesThisSession=0;this.status='ข้อมูลถนนออนไลน์ปิดอยู่';this.settings={enabled:false,budgetMB:5,consentV:0};this.generation=0;this.ctrl=null;this.endpoint=0;this.candidate=null;this.persistent=true;
  try{const v=JSON.parse(localStorage.getItem(KEY)||'null');if(v){this.settings.budgetMB=clamp(Number(v.budgetMB)||5,5,100);this.settings.enabled=v.enabled===true&&v.consentV===1;this.settings.consentV=v.consentV===1?1:0;}}catch{}
  store.prune(PREFIX,TTL).catch(()=>{this.persistent=false;});
 }
 setSettings(patch){this.settings={...this.settings,...patch,budgetMB:clamp(Number(patch.budgetMB??this.settings.budgetMB)||5,5,100)};if(!this.settings.enabled){this.generation++;this.ctrl?.abort();this.candidate=null;this.status='ข้อมูลถนนออนไลน์ปิดอยู่';}try{localStorage.setItem(KEY,JSON.stringify(this.settings));}catch{}}
 get dataUsedMB(){return this.bytesThisSession/1048576;}
 get budgetExceeded(){return this.bytesThisSession>=this.settings.budgetMB*1048576;}
 async update(lat,lon,heading,speed){
  if(!this.settings.enabled)return;
  const generation=this.generation,id=tileId(lat,lon);
  if(this.loaded.has(id)||this.pending.has(id))return;
  this.pending.add(id);
  try{
   let cached;try{cached=await store.get(id);}catch{this.persistent=false;}
   if(generation!==this.generation||!this.settings.enabled)return;
   if(cached?.schema===2&&Array.isArray(cached.ways)&&Date.now()-cached.t<TTL){this.loaded.set(id,cached.ways);this.status='ใช้ข้อมูลถนนที่เก็บไว้';return;}
   if(!navigator.onLine){this.status='ออฟไลน์ ไม่มีข้อมูลพื้นที่นี้';return;}
   if(this.budgetExceeded){this.status='ถึงงบข้อมูลที่ตั้งไว้';return;}
   if(Date.now()-this.lastFetch<30000)return;
   this.lastFetch=Date.now();await this.fetchTile(id,generation);
   while(this.loaded.size>6)this.loaded.delete(this.loaded.keys().next().value);
  }finally{this.pending.delete(id);}
 }
 async fetchTile(id,generation){
  const [y,x]=id.slice(PREFIX.length).split('_').map(Number),box=[y*TILE-MARGIN,x*TILE-MARGIN,(y+1)*TILE+MARGIN,(x+1)*TILE+MARGIN].map(v=>v.toFixed(5)).join(',');
  const query=`[out:json][timeout:12];way(${box})["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link)$"];out geom tags;`;
  const ctrl=new AbortController();this.ctrl=ctrl;const timer=setTimeout(()=>ctrl.abort(),15000);
  try{
   const response=await fetch(ENDPOINTS[this.endpoint++%ENDPOINTS.length],{method:'POST',body:'data='+encodeURIComponent(query),headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:ctrl.signal,credentials:'omit'});
   if(!response.ok||!response.body)throw new Error('บริการข้อมูลถนนไม่ตอบสนอง');
   const remaining=Math.max(0,this.settings.budgetMB*1048576-this.bytesThisSession),reader=response.body.getReader(),parts=[];let total=0;
   while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;this.bytesThisSession+=value.byteLength;if(total>Math.min(remaining,3*1048576)){await reader.cancel();ctrl.abort();throw new Error('หยุดดาวน์โหลดข้อมูลถนนเนื่องจากถึงงบ');}parts.push(value);}
   const all=new Uint8Array(total);let offset=0;for(const p of parts){all.set(p,offset);offset+=p.length;}
   const json=JSON.parse(new TextDecoder().decode(all));
   if(generation!==this.generation||!this.settings.enabled)return;
   const ways=(json.elements||[]).filter(v=>v.type==='way'&&Array.isArray(v.geometry)&&v.geometry.length>=2).map(v=>({
    id:v.id,name:v.tags?.name||null,oneway:v.tags?.oneway||null,
    maxspeed:v.tags?.['maxspeed:conditional']?null:parseMaxspeed(v.tags?.maxspeed),
    forward:v.tags?.['maxspeed:conditional']?null:parseMaxspeed(v.tags?.['maxspeed:forward']),
    backward:v.tags?.['maxspeed:conditional']?null:parseMaxspeed(v.tags?.['maxspeed:backward']),geom:v.geometry.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)),
   })).filter(w=>w.geom.length>=2);
   this.loaded.set(id,ways);
   try{await store.set(id,{schema:2,t:Date.now(),ways});this.persistent=true;}catch{this.persistent=false;}
   this.status=this.persistent?'ข้อมูลถนนจาก OSM (ป้ายจริงเป็นหลัก)':'เก็บถาวรไม่ได้ ใช้ข้อมูลในรอบนี้เท่านั้น';
  }catch(e){if(this.settings.enabled&&generation===this.generation)this.status=e.name==='AbortError'?'หยุดโหลดข้อมูลถนน':e.message;}
  finally{clearTimeout(timer);if(this.ctrl===ctrl)this.ctrl=null;}
 }
 async clearCache(){this.generation++;this.ctrl?.abort();this.loaded.clear();this.candidate=null;for(const k of await store.keys())if(typeof k==='string'&&k.startsWith(PREFIX))await store.del(k);this.status='ล้างข้อมูลถนนแล้ว';}
 match(lat,lon,heading,speed,accuracy=Infinity){
  if(!this.settings.enabled||!Number.isFinite(heading)||!Number.isFinite(accuracy)||accuracy>20||speed<12){this.candidate=null;return null;}
  const byWay=new Map();
  for(const ways of this.loaded.values())for(const way of ways)for(let i=0;i<way.geom.length-1;i++){
   const a=way.geom[i],b=way.geom[i+1];if(Math.abs(a.lat-lat)>.005&&Math.abs(b.lat-lat)>.005)continue;
   const p=projection(lat,lon,a,b);if(p.distance>18)continue;
   const brg=bearing(a,b),forward=diff(brg,heading)<=90,align=forward?diff(brg,heading):diff((brg+180)%360,heading);if(align>35)continue;
   if(['yes','1','true'].includes(way.oneway)&&!forward||way.oneway==='-1'&&forward)continue;
   const cost=p.distance+align*.3,old=byWay.get(way.id);
   if(!old||cost<old.cost)byWay.set(way.id,{way,idx:i,forward,cost,projection:p.point});
  }
  const choices=[...byWay.values()].sort((a,b)=>a.cost-b.cost),best=choices[0];
  if(!best||choices[1]&&choices[1].cost-best.cost<8){this.candidate=null;return null;}
  const key=best.way.id+':'+best.forward,now=Date.now();if(this.candidate?.key!==key){this.candidate={key,since:now};return null;}
  if(now-this.candidate.since<1500)return null;
  return {key,way:best.way,maxspeed:(best.forward?best.way.forward:best.way.backward)??best.way.maxspeed,curve:this.curveAhead(best,speed),matchedAt:now};
 }
 curveAhead(m,speed){
  const g=m.way.geom,order=m.forward?g.slice(m.idx+1):g.slice(0,m.idx+1).reverse();
  const pts=[{x:0,y:0},...order.map(p=>toLocalMeters(p.lat,p.lon,m.projection.lat,m.projection.lon))];
  const ahead=clamp(speed/3.6*6,80,400);let acc=0,radius=Infinity,distance=0;
  for(let i=1;i<pts.length-1;i++){acc+=Math.hypot(pts[i].x-pts[i-1].x,pts[i].y-pts[i-1].y);if(acc>ahead)break;if(acc<15)continue;const r=circleRadius(pts[i-1],pts[i],pts[i+1]);if(r<radius){radius=r;distance=acc;}}
  if(!Number.isFinite(radius)||radius>900)return null;
  return {radiusM:Math.round(radius),distanceM:Math.round(distance),advisoryThresholdKmh:Math.sqrt(.2*9.81*radius)*3.6};
 }
}
let sp={key:null,since:0,last:0},cv={key:null,last:0};
export function resetRoadAssessments(){sp={key:null,since:0,last:0};cv={key:null,last:0};}
export function assessSpeed(match,speed,now){
 const key=match?`${match.key}:${match.maxspeed}`:null;
 if(!match?.maxspeed||!Number.isFinite(speed)||now-match.matchedAt>2500||speed<25){sp.since=0;sp.key=null;return null;}
 if(sp.key!==key){sp.key=key;sp.since=now;}
 const over=speed-match.maxspeed;if(speed<=match.maxspeed*1.08||over<5){sp.since=0;return null;}
 if(!sp.since){sp.since=now;return null;}if(now-sp.since<4000||now-sp.last<25000)return null;
 sp.last=now;return {limit:match.maxspeed,over:Math.round(over)};
}
export function assessCurve(match,speed,now){const c=match?.curve;if(!c||!Number.isFinite(speed)||now-match.matchedAt>2500||speed<40||speed<=c.advisoryThresholdKmh*1.15)return null;if(cv.key===match.key&&now-cv.last<20000)return null;cv={key:match.key,last:now};return c;}
