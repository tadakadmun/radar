/* calibrate.js — ค่าติดตั้งกล้อง
 *
 * ทุกค่าเป็นสัดส่วน 0..1 ของเฟรม จึงไม่ผูกกับความละเอียดกล้อง
 * ค่าเริ่มต้นตั้งจากการติดโทรศัพท์แนวตั้งกลางกระจกหน้า สูงประมาณ 1.2 ม.
 * ต้องยืนยันภาพและแนวกล้องขณะจอดอย่างน้อยหนึ่งครั้ง ค่าที่ยืนยันแล้วจะจำไว้
 * และใช้ต่อได้ตราบใดที่สัดส่วนภาพกล้องยังเท่าเดิม (ถ้าหมุนจอ/เปลี่ยนกล้อง ต้องยืนยันใหม่)
 * ย้ายแท่นหรือเปลี่ยนมุมกล้องเมื่อไร ให้ตั้งกล้องใหม่
 */

const KEY = 'navassist.calib.v2';
const OLD_KEY = 'navassist.calib.v1';

export const DEFAULTS = {
  horizonY: 0.50,     // เส้นขอบฟ้าในเฟรม
  bottomLeft: 0.14,   // ขอบเลนซ้ายที่ขอบล่างของภาพ
  bottomRight: 0.86,  // ขอบเลนขวาที่ขอบล่างของภาพ
  nearHorizon: 0.09,  // แถวที่ใช้เป็นด้านบนของสี่เหลี่ยมคางหมู (ต่ำกว่าขอบฟ้าเท่านี้)
  topLeft: 0.415,     // ขอบเลนซ้ายที่แถวนั้น
  topRight: 0.585,    // ขอบเลนขวาที่แถวนั้น
  egoX: 0.50,         // แนวกลางรถในเฟรม (กล้องไม่ได้อยู่กลางรถเสมอ)
  laneWidthM: 3.4,    // ค่าความกว้างเลนเริ่มต้น ต้องปรับตามถนน (ม.)
  cameraHeightM: 1.20,
  corridorMarginM: 0.55,  // เผื่อรถที่ล้ำเข้ามาในเลนบางส่วน
  verified: false,    // ผู้ใช้ยืนยันด้วยตาแล้วหรือยัง
  frameAspect: null,
};

let cal = { ...DEFAULTS };

try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    // v2 profiles are only marked verified by the explicit confirm button.
    cal = sanitise({ ...DEFAULTS, ...JSON.parse(raw) });
  } else {
    // v1 profiles were marked verified by moving any slider. Keep values, require one confirmation.
    const old = localStorage.getItem(OLD_KEY);
    if (old) cal = sanitise({ ...DEFAULTS, ...JSON.parse(old), verified: false });
  }
} catch { /* localStorage ปิดอยู่ ใช้ค่าเริ่มต้นไป */ }

export const get = () => cal;

function sanitise(value) {
  const bounds = { horizonY: [.3,.7], bottomLeft: [0,.45], bottomRight: [.55,1],
    topLeft: [.25,.49], topRight: [.51,.75], egoX: [.2,.8], laneWidthM: [2.8,4],
    cameraHeightM: [.4,2.8], nearHorizon: [.04,.15], corridorMarginM: [0,.55] };
  const out = { ...DEFAULTS, ...value };
  for (const [k, [lo,hi]] of Object.entries(bounds)) {
    out[k] = Number.isFinite(out[k]) ? Math.min(hi, Math.max(lo, out[k])) : DEFAULTS[k];
  }
  out.verified = out.verified === true;
  out.frameAspect = Number.isFinite(out.frameAspect) ? out.frameAspect : null;
  return out;
}

export function isVerified(w, h) {
  return cal.verified && w > 0 && h > 0 && cal.frameAspect != null && Math.abs(w / h - cal.frameAspect) < .03;
}

export function confirm(w, h) {
  if (!(w > 0 && h > 0)) throw new Error('ต้องเห็นภาพกล้องก่อนยืนยัน');
  return set({ verified: true, frameAspect: w / h });
}

export function set(patch) {
  cal = sanitise({ ...cal, ...patch });
  try { localStorage.setItem(KEY, JSON.stringify(cal)); } catch { }
  return cal;
}

export function reset() {
  cal = { ...DEFAULTS };
  try { localStorage.removeItem(KEY); localStorage.removeItem(OLD_KEY); } catch { }
  return cal;
}

/**
 * สี่เหลี่ยมคางหมูของผิวถนนในหน่วยพิกเซลของภาพขนาด (w, h)
 * เรียงลำดับ: ซ้ายบน, ขวาบน, ขวาล่าง, ซ้ายล่าง
 */
export function roadQuad(w, h) {
  const topY = (cal.horizonY + cal.nearHorizon) * h;
  const botY = h - 1;
  return [
    [cal.topLeft * w, topY],
    [cal.topRight * w, topY],
    [cal.bottomRight * w, botY],
    [cal.bottomLeft * w, botY],
  ];
}

/**
 * ระยะโฟกัสเป็นพิกเซล ประมาณจากมุมรับภาพแนวนอน
 * ถ้าอ่าน FOV จากกล้องไม่ได้ ใช้ 62° ซึ่งเป็นค่ากลางของกล้องหลังมือถือ
 */
export function focalPx(imageWidth, fovDeg) {
  const fov = (fovDeg && fovDeg > 20 && fovDeg < 150) ? fovDeg : 62;
  return (imageWidth / 2) / Math.tan((fov * Math.PI / 180) / 2);
}

/**
 * ช่องทางเดินรถของเราเอง
 *
 * เดิมใช้สี่เหลี่ยมคางหมูชุดเดียวกับที่ใช้หาเลน ซึ่งผิด เพราะขอบบนของมัน
 * ตรงกับระยะคงที่เพียงระยะเดียว (ราว 15 เมตร) ทำให้รถที่อยู่ไกลกว่านั้น
 * ถูกตัดออกทั้งหมด — ซึ่งคือรถที่การเตือนชนท้ายต้องเห็นเป็นอันดับแรก
 *
 * ความจริงทางเรขาคณิต: จุดบนพื้นที่ระยะ Z ปรากฏที่แถว y = yₕ + f·hกล้อง/Z
 * และความกว้างครึ่งเลนที่ระยะนั้นเท่ากับ f·(W/2)/Z พิกเซล
 * แทน Z จากสมการแรกลงไป จะได้  ครึ่งความกว้าง = (W/2)/hกล้อง × (y − yₕ)
 * นั่นคือช่องทางเดินรถเป็นรูปสามเหลี่ยมที่มียอดอยู่ที่เส้นขอบฟ้าพอดี
 * และค่าคงที่ k ขึ้นกับความสูงกล้องเท่านั้น ไม่ขึ้นกับระยะโฟกัส
 */
export function egoCorridor(w, h) {
  const halfM = cal.laneWidthM / 2 + cal.corridorMarginM;
  const k = halfM / Math.max(0.4, cal.cameraHeightM);
  const yH = cal.horizonY * h;
  const topY = yH + Math.max(4, h * 0.012);
  const botY = h - 1;
  const cx = cal.egoX * w;
  return {
    yH, k, cx, topY, botY,
    topL: cx - k * (topY - yH), topR: cx + k * (topY - yH),
    botL: cx - k * (botY - yH), botR: cx + k * (botY - yH),
  };
}

/** จุด (x, y) อยู่ในช่องทางเดินรถของเราไหม — y คือขอบล่างของกรอบวัตถุ */
export function inCorridor(corr, x, y) {
  if (y <= corr.topY) return false;         // อยู่เหนือขอบฟ้า หรือไกลเกินกว่าจะสรุป
  return Math.abs(x - corr.cx) <= corr.k * (y - corr.yH);
}

/** ระยะโดยประมาณของจุดบนพื้นที่แถว y (เมตร) ใช้ตรวจสอบซ้ำกับระยะจากขนาดวัตถุ */
export function groundDistanceM(corr, y, focalPx) {
  const dy = y - corr.yH;
  if (dy <= 1) return null;
  return (focalPx * cal.cameraHeightM) / dy;
}
