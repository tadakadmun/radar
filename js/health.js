/* Readiness measures frame freshness and inference freshness, not temperature. */
import { ema } from './util.js';
export const STATE={OFF:'off',STARTING:'starting',READY:'ready',DEGRADED:'degraded',FAILED:'failed'};
export class Health {
  constructor(){this.state=STATE.OFF;this.reason=null;this.onChange=null;this.wakeLock=null;this.generation=0;this.reset();}
  reset(){this.lastInference=0;this.inferMs=0;this.degradeLevel=0;this.startedAt=performance.now();this.visualReady=false;}
  set(state,reason=null){if(state===this.state&&reason===this.reason)return;this.state=state;this.reason=reason;this.onChange?.(state,reason);}
  start(){this.reset();this.set(STATE.STARTING,'กำลังเตรียมระบบ');}
  stop(){this.generation++;this.visualReady=false;this.set(STATE.OFF);this.releaseWakeLock();}
  fail(reason){this.visualReady=false;this.set(STATE.FAILED,reason);}
  markInference(capturedAt,inferMs){this.lastInference=capturedAt;this.inferMs=ema(this.inferMs,inferMs,.25);this.degradeLevel=this.inferMs>500?2:this.inferMs>240?1:0;}
  tick(now,cameraReady,{frameAge=Infinity,visionLevel=2,calibrated=false,visible=true}={}){
    this.visualReady=false;
    if(this.state===STATE.OFF||this.state===STATE.FAILED)return this.state;
    if(!visible){this.set(STATE.DEGRADED,'พักการเตือนขณะสลับแอป');return this.state;}
    if(!cameraReady||frameAge>1500){this.fail('กล้องไม่ส่งภาพใหม่ กรุณาหยุดแล้วเริ่มใหม่เมื่อจอด');return this.state;}
    if(!this.lastInference){if(now-this.startedAt>12000)this.fail('ระบบตรวจจับไม่ตอบสนอง');return this.state;}
    const age=now-this.lastInference;
    if(age>4000){this.fail('ผลตรวจจับขาดหาย กรุณาเริ่มใหม่เมื่อจอด');return this.state;}
    if(age>900){this.set(STATE.DEGRADED,'ผลตรวจจับช้าเกินไป พักการเตือนจากภาพ');return this.state;}
    if(visionLevel>=2){this.set(STATE.DEGRADED,'ภาพไม่ชัดพอ พักการเตือนจากภาพ');return this.state;}
    if(!calibrated){this.set(STATE.DEGRADED,'ต้องจอดและยืนยันการตั้งกล้องก่อนเปิดการเตือนจากภาพ');return this.state;}
    this.visualReady=true;
    this.set(STATE.READY,visionLevel===1?'ทัศนวิสัยลดลง โปรดระวัง':null);return this.state;
  }
  get trustworthy(){return this.visualReady&&this.state===STATE.READY;}
  async requestWakeLock(){
    const token=this.generation;if(this.wakeLock)return;
    try{if(!navigator.wakeLock)return;const lock=await navigator.wakeLock.request('screen');if(token!==this.generation){await lock.release();return;}this.wakeLock=lock;lock.addEventListener('release',()=>{if(this.wakeLock===lock)this.wakeLock=null;});}catch{}
  }
  releaseWakeLock(){try{this.wakeLock?.release()?.catch?.(()=>{});}catch{}this.wakeLock=null;}
}
