/* health.js — ตัวเฝ้าระวังตัวระบบเอง
 *
 * ระบบความปลอดภัยที่ล้มเหลวเงียบๆ อันตรายกว่าไม่ติดตั้งเลย
 * เพราะคนขับยังเห็นหน้าจอสีเขียวเขียนว่าปกติ ทั้งที่ภาพค้างไปแล้วสามสิบวินาที
 * โมดูลนี้จึงมีหน้าที่เดียว: ประกาศว่า "ไม่พร้อม" ให้เร็วและดังพอ
 */

import { ema } from './util.js';

export const STATE = {
  OFF: 'off',
  STARTING: 'starting',
  READY: 'ready',
  DEGRADED: 'degraded',   // ทำงานได้แต่คุณภาพลด
  FAILED: 'failed',       // เชื่อไม่ได้แล้ว
};

const STALE_MS = 1500;
const HOT_FRAME_MS = 700;    // เฟรมช้ากว่านี้ต่อเนื่อง = เครื่องเริ่มร้อน/แรงไม่พอ

export class Health {
  constructor() {
    this.state = STATE.OFF;
    this.reason = null;
    this.lastInference = 0;
    this.frameMs = 0;
    this.inferMs = 0;
    this.slowStreak = 0;
    this.degradeLevel = 0;   // 0 = เต็มคุณภาพ, 2 = ประหยัดสุด
    this.onChange = null;
    this.wakeLock = null;
  }

  #set(state, reason = null) {
    if (this.state === state && this.reason === reason) return;
    this.state = state;
    this.reason = reason;
    this.onChange?.(state, reason);
  }

  start() { this.#set(STATE.STARTING, 'กำลังเตรียมระบบ'); }
  stop() { this.#set(STATE.OFF); this.releaseWakeLock(); }

  fail(reason) { this.#set(STATE.FAILED, reason); }

  markInference(t, inferMs, frameMs) {
    this.lastInference = t;
    this.inferMs = ema(this.inferMs, inferMs, 0.2);
    this.frameMs = ema(this.frameMs, frameMs, 0.2);

    if (this.frameMs > HOT_FRAME_MS) this.slowStreak++;
    else this.slowStreak = Math.max(0, this.slowStreak - 1);

    if (this.slowStreak > 12 && this.degradeLevel < 2) {
      this.degradeLevel++;
      this.slowStreak = 0;
    } else if (this.slowStreak === 0 && this.frameMs < HOT_FRAME_MS * 0.5 && this.degradeLevel > 0) {
      this.degradeLevel--;
    }
  }

  /** เรียกทุกเฟรม เพื่อจับกรณีระบบค้างโดยไม่มี exception */
  tick(t, cameraReady) {
    if (this.state === STATE.OFF || this.state === STATE.FAILED) return this.state;
    if (!cameraReady) { this.#set(STATE.FAILED, 'ไม่ได้รับภาพจากกล้อง'); return this.state; }
    if (!this.lastInference) return this.state;

    const age = t - this.lastInference;
    if (age > STALE_MS * 4) this.#set(STATE.FAILED, 'ระบบตรวจจับหยุดตอบสนอง');
    else if (age > STALE_MS) this.#set(STATE.DEGRADED, 'ประมวลผลช้ากว่าปกติ');
    else if (this.degradeLevel >= 2) this.#set(STATE.DEGRADED, 'เครื่องร้อน ระบบลดคุณภาพลงเพื่อทำงานต่อ');
    else this.#set(STATE.READY);
    return this.state;
  }

  get trustworthy() { return this.state === STATE.READY; }

  async requestWakeLock() {
    try {
      if (!('wakeLock' in navigator)) return;
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch { }
  }

  releaseWakeLock() {
    try { this.wakeLock?.release(); } catch { }
    this.wakeLock = null;
  }
}
