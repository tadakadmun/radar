/* จำลองการขับเข้าหารถคันหน้า แล้วดูว่าระบบเตือนตอนไหน */
import { Tracker, assessCollision } from '../js/tracker.js';
import * as calib from '../js/calibrate.js';

const W = 640, H = 480, FPS = 4, DT = 1000 / FPS;
const focal = calib.focalPx(W, 62);
const geom = { width: W, height: H, corridor: calib.egoCorridor(W, H), focalPx: focal };

/** สร้างกล่องของวัตถุกว้าง realW สูง realH ที่ระยะ Z เมตร ตรงกลางเลน */
function box(Z, realW = 1.8, realH = 1.5, lateralM = 0) {
  const w = focal * realW / Z, h = focal * realH / Z;
  const cx = W / 2 + (focal * lateralM / Z);
  // การฉายภาพจริง: จุดบนพื้นที่ระยะ Z ปรากฏต่ำกว่าเส้นขอบฟ้า f·h/Z พิกเซล
  const groundY = calib.get().horizonY * H + focal * calib.get().cameraHeightM / Z;
  return [cx - w / 2, groundY - h, w, h];
}

function run(label, zAt, opts = {}) {
  const tr = new Tracker();
  let t = 0, fired = { 1: null, 2: null };
  for (let k = 0; k < 40; k++) {
    t += DT;
    const Z = zAt(k * DT / 1000);
    if (Z <= 1) break;
    const dets = [{ class: 'car', score: 0.8, bbox: box(Z, 1.8, 1.5, opts.lateralM || 0) }];
    const tracks = tr.update(dets, t, geom);
    const th = assessCollision(tracks, opts.speed ?? 80, opts.gps ?? true);
    if (th.level && !fired[th.level]) fired[th.level] = { Z: Z.toFixed(1), ttc: th.ttc.toFixed(2) };
  }
  const fmt = f => f ? `Z=${f.Z} ม. (TTC ${f.ttc} วิ)` : 'ไม่เตือน';
  console.log(`${label}\n   เตือน: ${fmt(fired[1])}\n   วิกฤต: ${fmt(fired[2])}`);
  return fired;
}

console.log('\nระยะโฟกัสที่ประมาณได้:', focal.toFixed(0), 'พิกเซล\n');

// 1) ขับ 80 เข้าหารถที่วิ่ง 50 → ความเร็วสัมพัทธ์ 30 กม./ชม. ≈ 8.3 m/s
const a = run('[1] เข้าใกล้ช้าๆ (ต่างกัน 30 กม./ชม.) จาก 60 ม.', s => 60 - 8.3 * s);

// 2) รถหน้าเบรกกะทันหัน ความเร็วสัมพัทธ์ 22 m/s
const b = run('[2] รถหน้าเบรกกะทันหัน (ต่างกัน 79 กม./ชม.) จาก 60 ม.', s => 60 - 22 * s);

// 3) รถคันหน้าวิ่งเร็วกว่าเรา ถอยห่างออกไป
const c = run('[3] รถคันหน้าถอยห่าง', s => 25 + 6 * s);

// 4) รถจอดนิ่งข้างทาง นอกช่องทางเดินรถของเรา
const d = run('[4] รถจอดข้างทาง เยื้องออกไป 4 เมตร', s => 45 - 8.3 * s, { lateralM: 4 });

// 5) รถติด คลานเข้าหากันช้าๆ
const e = run('[5] รถติด คลาน 8 กม./ชม.', s => 12 - 1.5 * s, { speed: 8 });

const bad = [];
if (!a[1]) bad.push('ข้อ 1 ควรเตือนระดับปกติ');
if (!b[2]) bad.push('ข้อ 2 ควรเตือนระดับวิกฤต');
if (c[1] || c[2]) bad.push('ข้อ 3 ไม่ควรเตือนเลย');
if (d[1] || d[2]) bad.push('ข้อ 4 ไม่ควรเตือน (อยู่นอกช่องทาง)');
if (e[1] || e[2]) bad.push('ข้อ 5 ไม่ควรเตือนตอนรถติด');

console.log(bad.length ? '\nมีปัญหา:\n - ' + bad.join('\n - ') : '\nพฤติกรรมการเตือนถูกต้องทุกกรณี');
process.exit(bad.length ? 1 : 0);
