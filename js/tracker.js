/* tracker.js — ติดตามวัตถุ และคำนวณเวลาก่อนชน (TTC)
 *
 * แนวคิดหลักของการเตือนชนท้าย:
 *   ไม่ต้องรู้ระยะจริง ไม่ต้องรู้ขนาดจริงของวัตถุ
 *   ความกว้างของวัตถุในภาพ w แปรผกผันกับระยะ Z  (w ∝ 1/Z)
 *   ถ้าเข้าใกล้ด้วยความเร็วคงที่ Z = Z₀ − v·t  ดังนั้น 1/w เป็นเส้นตรงในเวลา
 *   ฟิตเส้นตรงกับ (t, 1/w) ได้ความชัน m และค่าปัจจุบัน q  →  TTC = −q / m
 *
 * วิธีนี้คือหลักการเดียวกับระบบเตือนชนท้ายในรถจริง และทนต่อการไม่ได้ calibrate
 */

import { clamp, ema, median, linRegress } from './util.js';
import { CLASS_HEIGHT_M } from './detector.js';
import { inCorridor } from './calibrate.js';

const IOU_MATCH = 0.22;
const MAX_MISSES = 2;         // ยอมให้หายได้กี่เฟรม (สั้นมาก เพื่อไม่ให้เกิดกรอบผี)
const CONFIRM_HITS = 3;       // ต้องเจอกี่เฟรมติดจึงจะเชื่อ
const HIST = 8;               // จำนวนตัวอย่างในหน้าต่างคำนวณ TTC
const MIN_TTC_SPAN_MS = 380;  // ช่วงเวลาต่ำสุดที่ยอมคำนวณ TTC
const MIN_TTC_R2 = 0.62;      // ความเป็นเส้นตรงขั้นต่ำของ 1/w

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

let nextId = 1;

class Track {
  constructor(det, t) {
    this.id = nextId++;
    this.cls = det.class;
    this.bbox = [...det.bbox];
    this.score = det.score;
    this.hits = 1;
    this.misses = 0;
    this.born = t;
    this.lastSeen = t;
    this.ts = [t];
    this.invW = [1 / Math.max(1, det.bbox[2])];
    this.ttc = null;
    this.ttcQuality = 0;
    this.distanceM = null;
    this.inPath = false;
  }

  update(det, t) {
    // ปรับ bbox แบบถ่วงน้ำหนัก ลดการกระตุกของกรอบระหว่างเฟรม
    const a = 0.55;
    for (let i = 0; i < 4; i++) this.bbox[i] = ema(this.bbox[i], det.bbox[i], a);
    this.score = ema(this.score, det.score, 0.4);
    this.hits++;
    this.misses = 0;
    this.lastSeen = t;
    this.ts.push(t);
    this.invW.push(1 / Math.max(1, this.bbox[2]));
    if (this.ts.length > HIST) { this.ts.shift(); this.invW.shift(); }
  }

  get confirmed() { return this.hits >= CONFIRM_HITS; }

  /** คำนวณ TTC จากอัตราการขยายของกรอบ คืนวินาที หรือ null ถ้าข้อมูลไม่พอ */
  computeTTC(now) {
    this.ttc = null;
    this.ttcQuality = 0;
    if (this.ts.length < 4) return;
    const span = this.ts[this.ts.length - 1] - this.ts[0];
    if (span < MIN_TTC_SPAN_MS) return;

    const t0 = this.ts[0];
    const fit = linRegress(this.ts.map(t => (t - t0) / 1000), this.invW);
    if (!fit || fit.r2 < MIN_TTC_R2) return;
    if (fit.m >= 0) return;   // ความชันบวก = วัตถุกำลังเล็กลง = ถอยห่าง

    const qNow = fit.m * ((now - t0) / 1000) + fit.q;
    if (qNow <= 0) return;
    const ttc = -qNow / fit.m;
    if (!Number.isFinite(ttc) || ttc <= 0 || ttc > 20) return;

    this.ttc = ttc;
    this.ttcQuality = fit.r2;
  }
}

export class Tracker {
  constructor() {
    this.tracks = [];
    this.egoDx = 0;           // การเลื่อนภาพรวมจากการที่รถเราเลี้ยว/สั่น
  }

  /**
   * @param {Array} dets ผลจาก Detector
   * @param {number} t เวลา (ms)
   * @param {object} geom { width, height, corridor, focalPx }
   */
  update(dets, t, geom) {
    const used = new Set();
    const shifts = [];

    // จับคู่แบบละโมบ เรียงจากคู่ที่ IoU สูงสุดก่อน
    const pairs = [];
    for (let i = 0; i < this.tracks.length; i++) {
      for (let j = 0; j < dets.length; j++) {
        if (this.tracks[i].cls !== dets[j].class) continue;
        const v = iou(this.tracks[i].bbox, dets[j].bbox);
        if (v >= IOU_MATCH) pairs.push({ i, j, v });
      }
    }
    pairs.sort((a, b) => b.v - a.v);

    const takenT = new Set();
    for (const p of pairs) {
      if (takenT.has(p.i) || used.has(p.j)) continue;
      const tr = this.tracks[p.i], d = dets[p.j];
      shifts.push((d.bbox[0] + d.bbox[2] / 2) - (tr.bbox[0] + tr.bbox[2] / 2));
      tr.update(d, t);
      takenT.add(p.i);
      used.add(p.j);
    }

    // การเลื่อนที่ทุกวัตถุมีร่วมกัน = การเคลื่อนของกล้องเราเอง ไม่ใช่ของวัตถุ
    this.egoDx = shifts.length >= 2 ? ema(this.egoDx, median(shifts), 0.3) : this.egoDx * 0.8;

    // track เดิมที่ไม่ถูกจับคู่ในรอบนี้ นับว่าหายไปหนึ่งเฟรม
    // ต้องนับก่อนเพิ่ม track ใหม่ ไม่งั้นของใหม่จะถูกนับว่าหายทันที
    this.tracks.forEach((tr, i) => { if (!takenT.has(i)) tr.misses++; });

    // วัตถุที่จับคู่ไม่ได้ = track ใหม่
    for (let j = 0; j < dets.length; j++) {
      if (!used.has(j)) this.tracks.push(new Track(dets[j], t));
    }

    // ตัด track ที่หายเกินกำหนดทิ้งทันที ไม่เก็บไว้วาดเป็นกรอบผี
    this.tracks = this.tracks.filter(tr => tr.misses <= MAX_MISSES);

    // คำนวณ TTC ระยะ และตำแหน่งในช่องทางเดินรถ
    for (const tr of this.tracks) {
      tr.computeTTC(t);
      const [x, y, w, h] = tr.bbox;
      const H = CLASS_HEIGHT_M[tr.cls];
      tr.distanceM = (H && geom.focalPx && h > 2) ? (H * geom.focalPx) / h : null;
      tr.inPath = inCorridor(geom.corridor, x + w / 2, y + h);
    }

    return this.tracks.filter(tr => tr.confirmed && tr.misses === 0);
  }

  reset() { this.tracks = []; }
}

/* ---------- ตรรกะการเตือนชนท้าย ---------- */

const FCW = {
  criticalTTC: 1.7,
  warningTTC: 2.8,
  minSpeedKmh: 18,       // ต่ำกว่านี้ถือว่ารถติด/จอด ไม่เตือนเพื่อลดการรบกวน
  minSpeedNoGps: null,   // ถ้าไม่มี GPS ยังเตือนได้ แต่ต้องเข้มกว่า
  noGpsTTC: 1.4,
  minHeightPx: 22,       // วัตถุเล็กเกินไป TTC ไม่น่าเชื่อถือ
  sustain: 2,            // ต้องเข้าเงื่อนไขติดกันกี่รอบ
};

const sustainCount = new Map();

/**
 * ประเมินความเสี่ยงชนท้ายจาก track ทั้งหมด
 * คืน { level: 0|1|2, track, ttc, reason } — 2 = วิกฤต, 1 = เตือน, 0 = ปกติ
 */
export function assessCollision(tracks, speedKmh, hasGps) {
  let best = null;

  for (const tr of tracks) {
    if (!tr.inPath || tr.ttc == null) { sustainCount.delete(tr.id); continue; }
    if (tr.bbox[3] < FCW.minHeightPx) { sustainCount.delete(tr.id); continue; }
    if (tr.ttcQuality < MIN_TTC_R2) { sustainCount.delete(tr.id); continue; }

    let level = 0;
    if (hasGps) {
      if (speedKmh < FCW.minSpeedKmh) { sustainCount.delete(tr.id); continue; }
      if (tr.ttc < FCW.criticalTTC) level = 2;
      else if (tr.ttc < FCW.warningTTC) level = 1;
    } else {
      // ไม่มี GPS ยืนยันว่ากำลังวิ่ง จึงเตือนเฉพาะกรณีที่ชัดเจนมาก
      if (tr.ttc < FCW.noGpsTTC) level = 2;
      else if (tr.ttc < FCW.criticalTTC) level = 1;
    }

    if (!level) { sustainCount.delete(tr.id); continue; }

    const n = (sustainCount.get(tr.id) || 0) + 1;
    sustainCount.set(tr.id, n);
    if (n < FCW.sustain) continue;

    if (!best || tr.ttc < best.ttc) best = { level, track: tr, ttc: tr.ttc };
  }

  // ล้าง id ที่หายไปแล้ว กัน map โตไม่หยุด
  const alive = new Set(tracks.map(t => t.id));
  for (const id of sustainCount.keys()) if (!alive.has(id)) sustainCount.delete(id);

  return best || { level: 0, track: null, ttc: null };
}
