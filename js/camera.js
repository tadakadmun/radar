/* Camera lifecycle and actual-frame heartbeat. No microphone is requested. */
const PROFILES = [{width:{ideal:640},height:{ideal:480}}, {width:{ideal:480},height:{ideal:360}}, {}];
export class Camera {
  constructor(video) { this.video=video; this.stream=null; this.track=null; this.onLost=null; this.lost=false; this.epoch=0; this.frameId=0; this.lastFrameAt=0; this.callbackId=null; this.poll=null; }
  get ready() { return !!this.stream && this.track?.readyState==='live' && this.video.readyState>=2 && this.video.videoWidth>0 && !this.lost; }
  frameAge(now=performance.now()) { return this.lastFrameAt ? now-this.lastFrameAt : Infinity; }
  async open() {
    this.close(); const token=this.epoch;
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('เปิดกล้องไม่ได้ ต้องใช้ HTTPS หรือ localhost');
    let lastError;
    try {
      for(const profile of PROFILES) {
        try {
          const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},frameRate:{ideal:24,max:30},...profile},audio:false});
          if(token!==this.epoch){stream.getTracks().forEach(t=>t.stop());throw new Error('ยกเลิกการเปิดกล้อง');}
          this.stream=stream;break;
        } catch(e) { lastError=e; if(token!==this.epoch || e.name==='NotAllowedError') throw e; }
      }
      if(!this.stream) throw lastError || new Error('ไม่พบกล้อง');
      this.track=this.stream.getVideoTracks()[0]; this.lost=false;
      this.track.addEventListener('ended',()=>{if(token===this.epoch)this.markLost('กล้องถูกปิด');});
      this.track.addEventListener('mute',()=>{if(token===this.epoch)this.markLost('กล้องหยุดส่งภาพ');});
      this.track.addEventListener('unmute',()=>{if(token===this.epoch)this.lost=false;});
      this.video.srcObject=this.stream;
      const playing=this.video.play();
      await Promise.all([playing,this.waitForFrames(token)]);
      if(token!==this.epoch) throw new Error('ยกเลิกการเปิดกล้อง');
      this.watchFrames(token);
      return this.settings();
    } catch(e) {
      if(token===this.epoch)this.close();
      if(e.name==='NotAllowedError') throw new Error('ยังไม่ได้อนุญาตกล้อง เปิดสิทธิ์แล้วลองใหม่');
      throw e;
    }
  }
  waitForFrames(token) {
    return new Promise((resolve,reject)=>{
      const started=performance.now();
      const timer=setInterval(()=>{
        if(token!==this.epoch){clearInterval(timer);reject(new Error('ยกเลิกการเปิดกล้อง'));}
        else if(this.video.readyState>=2 && this.video.videoWidth){clearInterval(timer);resolve();}
        else if(performance.now()-started>8000){clearInterval(timer);reject(new Error('กล้องไม่ส่งภาพภายใน 8 วินาที'));}
      },50);
    });
  }
  watchFrames(token) {
    this.lastFrameAt=performance.now(); this.frameId=0;
    if(this.video.requestVideoFrameCallback) {
      const next=()=>{if(token!==this.epoch)return;this.frameId++;this.lastFrameAt=performance.now();this.callbackId=this.video.requestVideoFrameCallback(next);};
      this.callbackId=this.video.requestVideoFrameCallback(next);
    } else {
      let last=-1;
      this.poll=setInterval(()=>{if(token!==this.epoch)return;const t=this.video.currentTime;if(t!==last && this.ready){last=t;this.frameId++;this.lastFrameAt=performance.now();}},80);
    }
  }
  markLost(reason){this.lost=true;this.onLost?.(reason);}
  settings(){try{return this.track?.getSettings?.()||{};}catch{return {};}}
  // Browsers do not give calibrated focal length in pixels. Do not mix mm and pixels.
  fovDeg(){return null;}
  async reopen(){return this.open();}
  close(){
    this.epoch++;clearInterval(this.poll);this.poll=null;
    if(this.callbackId!=null)this.video.cancelVideoFrameCallback?.(this.callbackId);
    this.callbackId=null;this.stream?.getTracks().forEach(t=>t.stop());
    this.stream=null;this.track=null;this.video.srcObject=null;this.lastFrameAt=0;this.frameId=0;
  }
}
