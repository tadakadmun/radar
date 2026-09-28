/* Inference runs in a dedicated worker. No paid API and no image upload. */
export const ROAD_CLASSES=new Set(['person','bicycle','car','motorcycle','bus','truck','train']);
export const CLASS_TH={person:'คนเดินถนน',bicycle:'จักรยาน',car:'รถยนต์',motorcycle:'รถจักรยานยนต์',bus:'รถโดยสาร',truck:'รถบรรทุก',train:'รถไฟ'};
export const CLASS_HEIGHT_M={person:1.7,bicycle:1.1,motorcycle:1.3,car:1.5,bus:3.2,truck:3.2,train:3.8};
export class Detector {
  constructor(){this.worker=null;this.ready=false;this.busy=false;this.lastLatency=0;this.pending=new Map();this.seq=0;this.generation=0;this.loading=null;}
  request(type,data={},transfer=[],timeout=5000){
    const id=++this.seq;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(type==='load'?'เตรียม AI ไม่สำเร็จภายในเวลา':'AI ตอบสนองช้าเกินไป กรุณาหยุดแล้วเริ่มใหม่'));if(type==='detect')this.close();},timeout);
      this.pending.set(id,{resolve,reject,timer});
      try{this.worker.postMessage({id,type,...data},transfer);}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  async load(onProgress){
    if(this.ready)return;
    if(this.loading)return this.loading;
    if(!globalThis.Worker||!globalThis.createImageBitmap)throw new Error('เบราว์เซอร์นี้ไม่รองรับการประมวลผลภาพเบื้องหลัง');
    this.worker=new Worker(new URL('./detector-worker.js',import.meta.url));
    this.worker.onmessage=({data})=>{
      if(data.type==='progress'){onProgress?.(data.message);return;}
      const p=this.pending.get(data.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(data.id);
      data.error?p.reject(new Error(data.error)):p.resolve(data);
    };
    this.worker.onerror=()=>this.close(new Error('ตัวประมวลผล AI หยุดทำงาน'));
    const generation=this.generation;
    this.loading=this.request('load',{},[],90000).then(res=>{if(generation!==this.generation)throw new Error('ยกเลิก');this.ready=true;this.delegate=res.delegate;}).catch(e=>{this.close();throw e;}).finally(()=>{this.loading=null;});
    return this.loading;
  }
  async detect(video,minScore=.45,capturedAt=performance.now()){
    if(!this.ready||this.busy)return null;
    this.busy=true;const generation=this.generation;let bitmap;
    try{
      bitmap=await createImageBitmap(video);
      if(generation!==this.generation){bitmap.close();return null;}
      const result=await this.request('detect',{bitmap,stamp:capturedAt},[bitmap],4000);
      this.lastLatency=performance.now()-capturedAt;
      return result.detections.filter(d=>ROAD_CLASSES.has(d.class)&&d.score>=minScore&&d.bbox.every(Number.isFinite)&&d.bbox[2]>0&&d.bbox[3]>0);
    }finally{if(generation===this.generation)this.busy=false;}
  }
  close(error=new Error('ยกเลิกระบบตรวจจับ')){
    this.generation++;this.worker?.terminate();this.worker=null;this.ready=false;this.busy=false;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();
  }
}
