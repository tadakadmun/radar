/* Classic worker: dynamic ES import plus MediaPipe's WASM importScripts loader. */
let model=null,lastStamp=0;
self.onmessage=async({data})=>{
  const {id,type}=data;
  try{
    if(type==='load'){
      const {LIB_BASE,MODEL_URL}=await import('./assets.js');
      self.postMessage({type:'progress',message:'กำลังเปิด AI จากไฟล์ที่เตรียมไว้'});
      const {FilesetResolver,ObjectDetector}=await import(`${LIB_BASE}/vision_bundle.mjs`);
      const fileset=await FilesetResolver.forVisionTasks(`${LIB_BASE}/wasm`);
      let lastError;
      for(const delegate of ['GPU','CPU']){
        try{
          model=await ObjectDetector.createFromOptions(fileset,{baseOptions:{modelAssetPath:MODEL_URL,delegate},runningMode:'VIDEO',scoreThreshold:.42,maxResults:12});
          self.postMessage({id,delegate});return;
        }catch(e){lastError=e;model?.close?.();model=null;}
      }
      throw lastError||new Error('เปิดโมเดลไม่ได้');
    }
    if(type==='detect'){
      try{
        if(!model)throw new Error('AI ยังไม่พร้อม');
        const stamp=Math.max(lastStamp+.01,data.stamp);lastStamp=stamp;
        const result=model.detectForVideo(data.bitmap,stamp);
        const detections=[];
        for(const d of result.detections||[]){const cat=d.categories?.[0],b=d.boundingBox;if(cat&&b)detections.push({class:cat.categoryName,score:cat.score,bbox:[b.originX,b.originY,b.width,b.height]});}
        self.postMessage({id,detections});
      }finally{data.bitmap?.close?.();}
    }
  }catch(e){self.postMessage({id,error:e?.message||'AI ขัดข้อง'});}
};
