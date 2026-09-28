/* Fresh speed/course and a movement latch: losing GPS never means stopped. */
import { ema, haversine } from './util.js';
export class Geo {
  constructor(){this.lat=null;this.lon=null;this.accuracy=null;this.speedKmh=null;this.speedSource=null;this.lastFix=0;this.lastSpeed=0;this.watchId=null;this.error=null;this._prev=null;this._moving=false;this._stoppedSince=null;this._course=null;this._courseAt=0;this.orientationBound=false;}
  get hasFix(){return this.lat!=null&&Date.now()-this.lastFix<5000&&this.accuracy<=35;}
  get hasSpeed(){return this.hasFix&&Number.isFinite(this.speedKmh)&&Date.now()-this.lastSpeed<3000;}
  get moving(){return this._moving;}
  get heading(){return this.hasSpeed&&this.speedKmh>12&&Date.now()-this._courseAt<3000?this._course:null;}
  get headingAbsolute(){return this.heading!=null;}
  // Road matching uses recent GPS course only. Phone orientation is not vehicle heading.
  requestOrientationPermission(){}
  start(){
    if(!navigator.geolocation){this.error='ไม่มีบริการตำแหน่ง';return;}
    if(this.watchId!=null)return;
    this.watchId=navigator.geolocation.watchPosition(p=>this.acceptFix(p),e=>{this.error=e.code===1?'ยังไม่ได้อนุญาตตำแหน่ง':'สัญญาณตำแหน่งขาดหาย';this._stoppedSince=null;},{enableHighAccuracy:true,maximumAge:0,timeout:10000});
  }
  acceptFix(pos){
    const c=pos.coords,now=Date.now(),stamp=Number.isFinite(pos.timestamp)?pos.timestamp:now;
    if(!Number.isFinite(c.latitude)||!Number.isFinite(c.longitude)||!Number.isFinite(c.accuracy)||now-stamp>5000||stamp>now+1000||stamp<=this.lastFix)return;
    if(this.lastFix&&stamp-this.lastFix>2500)this._stoppedSince=null;
    this.error=null;this.lat=c.latitude;this.lon=c.longitude;this.accuracy=c.accuracy;this.lastFix=stamp;
    let raw=null,source=null;
    if(c.accuracy<=35&&Number.isFinite(c.speed)&&c.speed>=0&&c.speed<100){raw=c.speed*3.6;source='gps';}
    else if(this._prev&&c.accuracy<=15&&this._prev.accuracy<=15){
      const dt=(stamp-this._prev.t)/1000;
      const d=haversine(this._prev.lat,this._prev.lon,c.latitude,c.longitude);
      if(dt>=1&&dt<=5&&d>c.accuracy+this._prev.accuracy){const v=d/dt*3.6;if(v<180){raw=v;source='derived';}}
    }
    if(raw!=null){
      this.speedKmh=this.lastSpeed&&stamp-this.lastSpeed<3000?ema(this.speedKmh,raw,.65):raw;
      this.lastSpeed=stamp;this.speedSource=source;
      if(raw>=5){this._moving=true;this._stoppedSince=null;}
      else if(raw<=2&&source==='gps'&&c.accuracy<=20){
        if(this._stoppedSince==null)this._stoppedSince=stamp;
        if(stamp-this._stoppedSince>=5000)this._moving=false;
      }else this._stoppedSince=null;
    }else{this.speedKmh=null;this.speedSource=null;this._stoppedSince=null;}
    if(Number.isFinite(c.heading)&&raw>12&&c.accuracy<=20){this._course=((c.heading%360)+360)%360;this._courseAt=stamp;}
    this._prev={lat:c.latitude,lon:c.longitude,accuracy:c.accuracy,t:stamp};
  }
  stop(){if(this.watchId!=null)navigator.geolocation.clearWatch(this.watchId);this.watchId=null;this._prev=null;this._stoppedSince=null;this.lastFix=0;this.lastSpeed=0;this.speedKmh=null;}
}
