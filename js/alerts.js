/* alerts.js — ระบบแจ้งเตือน
 *
 * กติกาที่ระบบนี้ยึด:
 *  1. คำเตือนวิกฤตแทรกได้เสมอ ไม่มีวันถูกคิวข้อความทั่วไปบัง
 *  2. เสียงไม่ใช่ช่องทางเดียว เพราะในรถมีเสียงเครื่อง เสียงฝน เสียงเพลง
 *     และมือถือหลายเครื่องไม่มีเสียงพูดภาษาไทยติดมา — เตือนพร้อมกันทั้ง
 *     เสียง การสั่น และสีเต็มขอบจอ
 *  3. คำเตือนซ้ำถี่เกินไปทำให้ผู้ใช้ปิดระบบทิ้ง ซึ่งอันตรายกว่าไม่เตือนเลย
 *     จึงมีระยะพักของแต่ละประเภทคำเตือนแยกกัน
 */

export const LEVEL = { INFO: 1, WARN: 2, CRITICAL: 3 };

const COOLDOWN = { [LEVEL.INFO]: 12000, [LEVEL.WARN]: 5000, [LEVEL.CRITICAL]: 1600 };

export class Alerts {
  constructor() {
    this.enabled = true;
    this.voice = null;
    this.voiceReady = false;
    this.audio = null;
    this.lastByKey = new Map();
    this.current = null;         // { key, level, text, until }
    this.onShow = null;          // callback ให้ UI แสดงผล
    this.speaking = false;
  }

  /**
   * ต้องเรียกจากการแตะของผู้ใช้โดยตรง ห้ามมี await คั่นก่อนหน้า
   * ไม่งั้น iOS จะถือว่าหมด user gesture แล้วปิดทั้งเสียงพูดและเสียงสังเคราะห์
   */
  primeFromUserGesture() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !this.audio) this.audio = new AC();
      this.audio?.resume?.();
    } catch { }

    try {
      if ('speechSynthesis' in window) {
        // ปลุกเครื่องสังเคราะห์เสียงด้วยข้อความว่าง
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
        this.#pickVoice();
        speechSynthesis.addEventListener?.('voiceschanged', () => this.#pickVoice());
      }
    } catch { }
  }

  #pickVoice() {
    try {
      const vs = speechSynthesis.getVoices() || [];
      this.voice = vs.find(v => /^th(-|_|$)/i.test(v.lang)) || null;
      this.voiceReady = !!this.voice;
    } catch { this.voiceReady = false; }
  }

  /** มีเสียงพูดไทยให้ใช้ไหม — UI ควรบอกผู้ใช้ถ้าไม่มี */
  get hasThaiVoice() { return this.voiceReady; }

  /**
   * ส่งคำเตือนเข้าระบบ
   * @param {string} key   ตัวระบุประเภท เช่น 'fcw' 'ldw' 'speed'
   * @param {number} level LEVEL.*
   * @param {string} text  ข้อความสำหรับจอ
   * @param {string} [spoken] ข้อความสำหรับเสียงพูด (สั้นกว่า)
   */
  fire(key, level, text, spoken) {
    const now = Date.now();

    // คำเตือนที่ระดับต่ำกว่าของที่กำลังแสดงอยู่ ต้องรอ
    if (this.current && this.current.level > level && now < this.current.until) return false;

    const last = this.lastByKey.get(key) || 0;
    if (now - last < COOLDOWN[level]) {
      // ยังพักอยู่ แต่ถ้าเป็นวิกฤตให้ต่ออายุการแสดงผลไว้
      if (level === LEVEL.CRITICAL && this.current?.key === key) {
        this.current.until = now + 1800;
      }
      return false;
    }
    this.lastByKey.set(key, now);

    const dur = level === LEVEL.CRITICAL ? 2600 : level === LEVEL.WARN ? 2600 : 3600;
    this.current = { key, level, text, until: now + dur };
    this.onShow?.(this.current);

    if (!this.enabled) return true;
    this.#haptic(level);
    this.#sound(level, spoken || text);
    return true;
  }

  #haptic(level) {
    try {
      if (!navigator.vibrate) return;
      if (level === LEVEL.CRITICAL) navigator.vibrate([120, 60, 120, 60, 200]);
      else if (level === LEVEL.WARN) navigator.vibrate([90, 70, 90]);
      else navigator.vibrate(45);
    } catch { }
  }

  #sound(level, text) {
    // เสียงโทนมาก่อนเสมอ เพราะดังทันทีและไม่ขึ้นกับว่ามีเสียงไทยหรือไม่
    this.#tone(level);
    if (!this.voiceReady || !('speechSynthesis' in window)) return;

    try {
      if (level === LEVEL.CRITICAL) speechSynthesis.cancel();
      else if (this.speaking) return;   // ไม่ตัดคำเตือนที่กำลังพูดอยู่

      const u = new SpeechSynthesisUtterance(text);
      u.voice = this.voice;
      u.lang = this.voice?.lang || 'th-TH';
      u.rate = level === LEVEL.CRITICAL ? 1.12 : 1.0;
      u.volume = 1;
      u.onstart = () => { this.speaking = true; };
      u.onend = u.onerror = () => { this.speaking = false; };
      // หน่วงเล็กน้อยให้เสียงโทนดังจบก่อน
      setTimeout(() => speechSynthesis.speak(u), level === LEVEL.CRITICAL ? 260 : 180);
    } catch { }
  }

  /** เสียงสังเคราะห์ ใช้เป็นช่องทางหลักเมื่อไม่มีเสียงพูดไทย */
  #tone(level) {
    const ac = this.audio;
    if (!ac) return;
    try {
      if (ac.state === 'suspended') ac.resume();
      const beeps = level === LEVEL.CRITICAL ? [0, 0.13, 0.26]
        : level === LEVEL.WARN ? [0, 0.16] : [0];
      const freq = level === LEVEL.CRITICAL ? 1180 : level === LEVEL.WARN ? 820 : 620;
      const vol = level === LEVEL.CRITICAL ? 0.5 : 0.32;

      for (const at of beeps) {
        const t0 = ac.currentTime + at;
        const osc = ac.createOscillator(), gain = ac.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(vol, t0 + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
        osc.connect(gain).connect(ac.destination);
        osc.start(t0);
        osc.stop(t0 + 0.13);
      }
    } catch { }
  }

  /** คำเตือนที่ยังควรแสดงอยู่ตอนนี้ หรือ null */
  active() {
    if (this.current && Date.now() < this.current.until) return this.current;
    if (this.current) { this.current = null; this.onShow?.(null); }
    return null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) { try { speechSynthesis.cancel(); } catch { } }
  }

  clear() {
    this.current = null;
    this.lastByKey.clear();
    try { speechSynthesis.cancel(); } catch { }
  }
}
