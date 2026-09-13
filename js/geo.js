/* geo.js — ตำแหน่ง ความเร็ว และทิศทาง
 *
 * ความเร็วคือสัญญาณที่มีค่าที่สุดในระบบทั้งหมด และได้มาฟรี
 * ใช้กำหนดว่าจะเตือนอะไรเมื่อไหร่ ใช้ปิดปุ่มตอนรถวิ่ง และใช้เทียบกับป้ายจำกัดความเร็ว
 *
 * เรื่องทิศทาง: บน Android ค่า alpha ของ deviceorientation ไม่ใช่ทิศเหนือจริง
 * เว้นแต่ event บอกว่า absolute จึงต้องเช็คก่อน ไม่งั้นจะได้ตัวเลขที่ดูน่าเชื่อถือแต่ผิด
 */

import { ema, haversine } from './util.js';

export class Geo {
  constructor() {
    this.lat = null; this.lon = null;
    this.accuracy = null;
    this.speedKmh = 0;
    this.speedSource = null;   // 'gps' | 'derived' | null
    this.heading = null;
    this.headingAbsolute = false;
    this.lastFix = 0;
    this.watchId = null;
    this.orientationBound = false;
    this.error = null;
    this._prev = null;
  }

  get hasFix() {
    return this.lat != null && Date.now() - this.lastFix < 6000 && (this.accuracy ?? 999) < 60;
  }

  get moving() { return this.hasFix && this.speedKmh >= 5; }

  /** ต้องเรียกใน user gesture สำหรับ iOS (เข็มทิศ) */
  requestOrientationPermission() {
    if (this.orientationBound) return;
    const bind = () => {
      const handler = e => {
        let h = null, abs = false;
        if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
          h = e.webkitCompassHeading; abs = true;
        } else if (e.absolute === true && e.alpha != null) {
          h = (360 - e.alpha) % 360; abs = true;
        } else if (e.alpha != null) {
          h = (360 - e.alpha) % 360; abs = false;
        }
        if (h != null) { this.heading = h; this.headingAbsolute = abs; }
      };
      window.addEventListener('deviceorientationabsolute', handler, true);
      window.addEventListener('deviceorientation', handler, true);
      this.orientationBound = true;
    };

    try {
      const D = window.DeviceOrientationEvent;
      if (D && typeof D.requestPermission === 'function') {
        // ต้องเรียกแบบ synchronous ใน gesture — ผล promise ค่อยจัดการทีหลัง
        D.requestPermission().then(p => { if (p === 'granted') bind(); }).catch(() => { });
      } else {
        bind();
      }
    } catch { }
  }

  start() {
    if (!navigator.geolocation) { this.error = 'อุปกรณ์นี้ไม่มี GPS'; return; }
    if (this.watchId != null) return;
    this.watchId = navigator.geolocation.watchPosition(
      pos => this.#onFix(pos),
      err => {
        this.error = err.code === err.PERMISSION_DENIED
          ? 'ยังไม่ได้อนุญาตตำแหน่ง' : 'ยังหาสัญญาณ GPS ไม่พบ';
      },
      { enableHighAccuracy: true, maximumAge: 1500, timeout: 10000 },
    );
  }

  #onFix(pos) {
    const c = pos.coords, now = Date.now();
    this.error = null;
    this.accuracy = c.accuracy;

    if (typeof c.speed === 'number' && !Number.isNaN(c.speed) && c.speed >= 0) {
      this.speedKmh = ema(this.speedKmh, c.speed * 3.6, 0.45);
      this.speedSource = 'gps';
    } else if (this._prev && c.accuracy < 35) {
      // อุปกรณ์บางรุ่นไม่ให้ speed มา จึงคำนวณจากระยะทางที่เคลื่อนไป
      const dt = (now - this._prev.t) / 1000;
      if (dt > 0.4 && dt < 8) {
        const d = haversine(this._prev.lat, this._prev.lon, c.latitude, c.longitude);
        this.speedKmh = ema(this.speedKmh, (d / dt) * 3.6, 0.35);
        this.speedSource = 'derived';
      }
    }

    if (c.heading != null && !Number.isNaN(c.heading) && this.speedKmh > 12) {
      // ทิศจาก GPS เชื่อถือได้กว่าเข็มทิศเมื่อรถกำลังวิ่ง
      this.heading = c.heading;
      this.headingAbsolute = true;
    }

    this._prev = { lat: c.latitude, lon: c.longitude, t: now };
    this.lat = c.latitude; this.lon = c.longitude;
    this.lastFix = now;
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}
