/* vision.js — ประเมินว่ากล้อง "มองเห็นถนนได้แค่ไหน"
 *
 * ปัญหาของการวัดด้วยความสว่างเฉลี่ย: กล้องมือถือมี auto-exposure ที่ชดเชยตลอดเวลา
 * หมอกหนา กล้องก็ดันภาพให้สว่างจนค่าเฉลี่ยดูปกติ ส่วนกลางคืนที่มองเห็นดี
 * ค่าเฉลี่ยกลับต่ำจนระบบเตือนไม่หยุด แล้วผู้ใช้ก็ปิดเสียงทิ้ง
 *
 * จึงใช้ตัวชี้วัดที่ auto-exposure รบกวนไม่ได้แทน:
 *   dark channel  — ในภาพกลางแจ้งปกติ ทุกบริเวณจะมีอย่างน้อยหนึ่งช่องสีที่มืด
 *                   ถ้าค่าต่ำสุดของ R,G,B สูงไปหมด แปลว่ามีฝ้าขาวคลุม = หมอก/ฝน
 *   Laplacian var — พลังงานความถี่สูง ต่ำ = ภาพเบลอ มักเกิดจากน้ำเกาะเลนส์
 *   ความต่างของความคมชัดระหว่างโซน — บางโซนเบลอถาวร = เลนส์สกปรกหรือมีคราบ
 */

import { clamp, ema } from './util.js';
import * as calib from './calibrate.js';

export class VisionMeter {
  constructor() {
    this.haze = 0;        // 0..1 ยิ่งสูงยิ่งมีฝ้า
    this.sharp = 0;       // ค่าดิบของ Laplacian variance
    this.mean = 0;
    this.zoneSpread = 0;
    this.detail = 0;      // มีรายละเอียดในภาพให้วิเคราะห์แค่ไหน
    this.night = false;
    this.score = 100;
    this.first = true;
  }

  /**
   * @param {{data: Uint8ClampedArray, w: number, h: number}} frame
   * @param {object} camSettings ผลจาก track.getSettings()
   */
  update(frame, camSettings = {}) {
    const { data, w, h } = frame;
    const y0 = Math.floor(h * clamp(calib.get().horizonY, 0.2, 0.8));
    const rows = h - y0;
    if (rows < 8) return this.#result();

    let darkSum = 0, darkN = 0, lumSum = 0, lumN = 0;
    const zones = [0, 0, 0], zoneN = [0, 0, 0];
    let lap = 0, lapN = 0;

    const lum = new Float32Array(w);
    const lumPrev = new Float32Array(w);
    const lumPrev2 = new Float32Array(w);

    for (let y = y0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        lum[x] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumSum += lum[x]; lumN++;
        // dark channel เอาแบบหยาบทุก 2 พิกเซล เพียงพอและถูกกว่า
        if ((x & 1) === 0) { darkSum += Math.min(r, g, b); darkN++; }
      }

      if (y >= y0 + 2) {
        for (let x = 1; x < w - 1; x++) {
          // Laplacian 4 ทิศ
          const v = lumPrev[x - 1] + lumPrev[x + 1] + lumPrev2[x] + lum[x] - 4 * lumPrev[x];
          const v2 = v * v;
          lap += v2; lapN++;
          const z = x < w / 3 ? 0 : x < 2 * w / 3 ? 1 : 2;
          zones[z] += v2; zoneN[z]++;
        }
      }
      lumPrev2.set(lumPrev);
      lumPrev.set(lum);
    }

    const meanLum = lumSum / Math.max(1, lumN);
    const darkCh = darkSum / Math.max(1, darkN);
    const lapVar = lap / Math.max(1, lapN);

    const zAvg = zones.map((s, i) => s / Math.max(1, zoneN[i]));
    const zMax = Math.max(...zAvg), zMin = Math.min(...zAvg);
    const spread = zMax > 1 ? clamp(1 - zMin / zMax, 0, 1) : 0;

    // กลางคืน: ใช้ทั้งความสว่างและค่า exposure ที่กล้องรายงาน (ถ้ามี)
    const exposureHint = camSettings.exposureTime && camSettings.exposureTime > 20000;
    const isoHint = camSettings.iso && camSettings.iso > 800;
    const night = meanLum < 62 || !!exposureHint || !!isoHint;

    const a = this.first ? 1 : 0.2;
    this.mean = ema(this.mean, meanLum, a);
    this.haze = ema(this.haze, clamp((darkCh - 45) / 120, 0, 1), a);
    this.sharp = ema(this.sharp, lapVar, a);
    this.zoneSpread = ema(this.zoneSpread, spread, a);
    this.night = night;
    this.first = false;

    // เกณฑ์คนละชุดระหว่างกลางวันกับกลางคืน กลางคืนภาพหยาบเป็นปกติ
    const sharpRef = night ? 55 : 190;
    const sharpScore = clamp(Math.sqrt(this.sharp / sharpRef) * 100, 0, 100);
    const hazeScore = (1 - this.haze) * 100;
    const darkScore = night
      ? clamp((this.mean - 8) * 6, 0, 100)      // กลางคืนแค่ต้องไม่มืดสนิท
      : clamp((this.mean - 18) * 3.2, 0, 100);

    this.detail = ema(this.detail, sharpScore, a);

    // ภาพที่ไม่มีรายละเอียดเลย (มืดสนิท หรือขาวโพลน) จะได้คะแนน haze สูงหลอกๆ
    // เพราะ dark channel ต่ำ ทั้งที่มองอะไรไม่เห็นเลย จึงกดเพดานคะแนนไว้
    let raw = 0.45 * sharpScore + 0.35 * hazeScore + 0.20 * darkScore;
    if (this.detail < 12) raw = Math.min(raw, 20);
    this.score = Math.round(ema(this.score, clamp(raw, 0, 100), 0.15));

    return this.#result();
  }

  #result() {
    let reason = null, level = 0;   // 0 ปกติ, 1 ควรระวัง, 2 ไม่ควรพึ่งกล้อง
    if (this.haze > 0.62) { reason = 'มีฝ้าหรือหมอกหนาบังกล้อง'; level = 2; }
    else if (this.detail < 12) {
      reason = this.night ? 'มืดเกินกว่ากล้องจะแยกถนนได้' : 'ภาพแทบไม่มีรายละเอียดให้วิเคราะห์';
      level = 2;
    }
    else if (this.zoneSpread > 0.72) { reason = 'บางส่วนของภาพเบลอ อาจมีน้ำหรือคราบบนเลนส์'; level = 1; }
    else if (this.score < 26) { reason = this.night ? 'มืดเกินกว่ากล้องจะแยกถนนได้' : 'ภาพไม่ชัดพอ'; level = 2; }
    else if (this.score < 46) { reason = 'ทัศนวิสัยลดลง'; level = 1; }

    return {
      score: this.score,
      night: this.night,
      haze: +this.haze.toFixed(2),
      detail: Math.round(this.detail),
      level,
      reason,
    };
  }

  reset() { this.first = true; this.score = 100; this.detail = 0; }
}
