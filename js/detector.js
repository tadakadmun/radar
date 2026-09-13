/* detector.js — ตรวจจับวัตถุบนถนน
 *
 * ใช้ MediaPipe Tasks Vision ของ Google พร้อมโมเดล EfficientDet-Lite
 * ทั้งไลบรารีและตัวโมเดลเป็นสัญญาอนุญาต Apache 2.0 ซึ่งฟรีสมบูรณ์
 * ไม่มีเงื่อนไขบังคับเปิดซอร์ส ไม่มีค่าใช้จ่าย ไม่ต้องมีคีย์หรือบัญชี
 *
 * (จงใจเลี่ยงโมเดลตระกูล YOLO ของ Ultralytics ทุกเวอร์ชัน เพราะเป็น AGPL-3.0
 *  ซึ่งบังคับให้เปิดซอร์สทั้งโปรเจกต์ หรือไม่ก็ต้องซื้อใบอนุญาตเชิงพาณิชย์)
 *
 * ทำไมถึงเปลี่ยนจาก COCO-SSD เดิม:
 *   - เร็วขึ้นหลายเท่า เพราะรันบน WebAssembly + GPU delegate
 *   - กรอบวัตถุนิ่งและแม่นกว่า ซึ่งสำคัญมากเพราะการเตือนชนท้าย
 *     คำนวณจากอัตราการขยายของความกว้างกรอบโดยตรง กรอบสั่น = TTC เพี้ยน
 *   - ตรวจวัตถุเล็กที่อยู่ไกลได้ดีขึ้น เช่น มอเตอร์ไซค์ที่กำลังเข้ามา
 */

const LIB_VERSION = '1.0.1';
const LIB_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${LIB_VERSION}`;

// โมเดล int8 เล็กและเร็วที่สุดในตระกูล เหมาะกับมือถือที่ต้องรันต่อเนื่องนานๆ
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';

// เฉพาะคลาสที่เกี่ยวกับความปลอดภัยบนถนน คลาสอื่นถูกทิ้งตั้งแต่ต้นทาง
export const ROAD_CLASSES = new Set([
  'person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'train',
]);

export const CLASS_TH = {
  person: 'คนเดินถนน', bicycle: 'จักรยาน', car: 'รถยนต์',
  motorcycle: 'รถจักรยานยนต์', bus: 'รถโดยสาร', truck: 'รถบรรทุก', train: 'รถไฟ',
};

/** ความสูงจริงโดยประมาณ (เมตร) ใช้ประมาณระยะแบบ pinhole */
export const CLASS_HEIGHT_M = {
  person: 1.70, bicycle: 1.10, motorcycle: 1.30,
  car: 1.50, bus: 3.20, truck: 3.20, train: 3.80,
};

/**
 * โหลดไลบรารีแบบ dynamic import
 * เขียนเป็น dynamic เพื่อสองเหตุผล: ไม่ดึงไลบรารีมาตั้งแต่เปิดหน้าเว็บ
 * (ผู้ใช้ยังไม่กดเริ่มก็ยังไม่ต้องโหลด) และเปิดช่องให้ชุดทดสอบใส่ของปลอมเข้ามาแทนได้
 */
async function loadLibrary() {
  if (globalThis.__mpTasksVision) return globalThis.__mpTasksVision;
  return import(/* webpackIgnore: true */ `${LIB_BASE}/vision_bundle.mjs`);
}

export class Detector {
  constructor() {
    this.model = null;
    this.delegate = null;      // 'GPU' | 'CPU'
    this.lastLatency = 0;
    this.busy = false;
    this._lastStamp = 0;
  }

  async load(onProgress) {
    if (this.model) return this.model;

    onProgress?.('กำลังโหลดไลบรารีตรวจจับ');
    let lib;
    try {
      lib = await loadLibrary();
    } catch {
      throw new Error('โหลดไลบรารีตรวจจับไม่สำเร็จ ครั้งแรกที่ใช้ต้องต่ออินเทอร์เน็ต');
    }

    const { FilesetResolver, ObjectDetector } = lib;
    if (!FilesetResolver || !ObjectDetector) {
      throw new Error('ไลบรารีตรวจจับไม่สมบูรณ์ ลองล้างแคชแล้วเปิดใหม่');
    }

    onProgress?.('กำลังเตรียมตัวประมวลผล');
    const fileset = await FilesetResolver.forVisionTasks(`${LIB_BASE}/wasm`);

    // ลอง GPU ก่อนเพราะเร็วกว่ามาก ถ้าเครื่องไม่รองรับค่อยตกไป CPU
    // เครื่องเก่าบางรุ่นสร้าง GPU delegate ไม่ผ่าน ซึ่งไม่ควรทำให้ระบบใช้ไม่ได้เลย
    for (const delegate of ['GPU', 'CPU']) {
      try {
        onProgress?.(delegate === 'GPU'
          ? 'กำลังโหลดโมเดล (ครั้งแรกครั้งเดียว)'
          : 'เครื่องไม่รองรับ GPU กำลังลองแบบ CPU');
        this.model = await ObjectDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          scoreThreshold: 0.42,
          maxResults: 12,
        });
        this.delegate = delegate;
        return this.model;
      } catch (e) {
        if (delegate === 'CPU') {
          throw new Error('โหลดโมเดลไม่สำเร็จ ' + (e?.message || ''));
        }
      }
    }
  }

  /**
   * ตรวจจับหนึ่งเฟรม คืนเฉพาะวัตถุบนถนนที่ผ่านเกณฑ์ความเชื่อมั่น
   * bbox = [x, y, w, h] ในพิกัดพิกเซลของวิดีโอ (รูปแบบเดิม โมดูลอื่นไม่ต้องแก้)
   */
  async detect(video, minScore = 0.45) {
    if (!this.model || this.busy) return null;
    this.busy = true;
    const t0 = performance.now();
    try {
      // detectForVideo ต้องได้เวลาที่เพิ่มขึ้นเสมอ ไม่งั้นจะโยนข้อผิดพลาด
      let stamp = Math.round(t0);
      if (stamp <= this._lastStamp) stamp = this._lastStamp + 1;
      this._lastStamp = stamp;

      const res = this.model.detectForVideo(video, stamp);
      this.lastLatency = performance.now() - t0;

      const out = [];
      for (const d of res?.detections || []) {
        const cat = d.categories?.[0];
        if (!cat || cat.score < minScore) continue;
        const name = cat.categoryName;
        if (!ROAD_CLASSES.has(name)) continue;
        const b = d.boundingBox;
        if (!b || b.width <= 0 || b.height <= 0) continue;
        out.push({
          class: name,
          score: cat.score,
          bbox: [b.originX, b.originY, b.width, b.height],
        });
      }
      return out.sort((a, b) => b.score - a.score);
    } finally {
      this.busy = false;
    }
  }

  close() {
    try { this.model?.close?.(); } catch { }
    this.model = null;
  }
}
