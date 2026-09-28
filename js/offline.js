/* No paid services. Downloads occur only through the explicit prepare button. */
export class Offline {
  constructor(){this.registration=null;this.ready=false;this.onUpdate=null;this.installing=null;}
  async connect(){
    if(!('serviceWorker' in navigator)||!isSecureContext)throw new Error('ต้องเปิดผ่าน HTTPS หรือ localhost เพื่อเก็บ AI ออฟไลน์');
    if(this.registration&&navigator.serviceWorker.controller)return this.registration;
    if(this.installing)return this.installing;
    this.installing=(async()=>{
      const reg=await navigator.serviceWorker.register(new URL('../sw.js',import.meta.url),{updateViaCache:'none'});
      this.registration=reg;
      reg.addEventListener('updatefound',()=>{const next=reg.installing;next?.addEventListener('statechange',()=>{if(next.state==='installed'&&navigator.serviceWorker.controller)this.onUpdate?.();});});
      if(reg.waiting)this.onUpdate?.();
      await new Promise((resolve,reject)=>{
        const begun=Date.now();const timer=setInterval(()=>{
          if(navigator.serviceWorker.controller){clearInterval(timer);resolve();}
          else if(reg.installing?.state==='redundant'||Date.now()-begun>45000){clearInterval(timer);reject(new Error('ติดตั้งไฟล์ออฟไลน์ไม่สำเร็จ ตรวจว่าอัปโหลดไฟล์ครบ'));}
        },100);
      });return reg;
    })().finally(()=>{this.installing=null;});return this.installing;
  }
  async message(type,onProgress,timeout=600000){
    await this.connect();return new Promise((resolve,reject)=>{
      const channel=new MessageChannel();
      const timer=setTimeout(()=>{channel.port1.close();reject(new Error('ระบบออฟไลน์ไม่ตอบสนอง ปิดแอปทุกหน้าแล้วเปิดใหม่ หากยังไม่หายให้กดซ่อมไฟล์แอปผ่าน Wi-Fi'));},timeout);
      channel.port1.onmessage=({data})=>{
        if(data.progress){onProgress?.(data);return;}
        if(!data.done)return;clearTimeout(timer);channel.port1.close();
        if(data.error)reject(new Error(data.error));else{if('ready' in data)this.ready=data.ready;resolve(data);}
      };
      navigator.serviceWorker.controller.postMessage({type},[channel.port2]);
    });
  }
  status(){return this.message('OFFLINE_STATUS',null,50000);}
  prepare(onProgress){return this.message('PREPARE_OFFLINE',onProgress);}
  cancel(){return this.message('CANCEL_PREPARE',null,10000);}
}
