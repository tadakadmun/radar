/* selftest.mjs — ตรวจว่าคณิตศาสตร์และตัวตรวจเลนทำงานจริง ไม่ใช่แค่คอมไพล์ผ่าน */
import { homography, applyH, polyFit, linRegress, circleRadius, classifyLineColor } from '../js/util.js';
import { LaneFinder } from '../js/lane.js';
import { VisionMeter } from '../js/vision.js';
import * as calib from '../js/calibrate.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('\n[1] homography');
{
  const src = [[10, 5], [90, 8], [95, 70], [5, 66]];
  const dst = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const H = homography(src, dst);
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const [x, y] = applyH(H, src[i][0], src[i][1]);
    worst = Math.max(worst, Math.hypot(x - dst[i][0], y - dst[i][1]));
  }
  ok('map 4 จุดได้ตรงตำแหน่ง', worst < 1e-6, `คลาดเคลื่อน ${worst}`);

  const Hinv = homography(dst, src);
  const [bx, by] = applyH(Hinv, ...applyH(H, 40, 30));
  ok('ไป-กลับแล้วได้จุดเดิม', near(bx, 40, 1e-6) && near(by, 30, 1e-6), `${bx},${by}`);
}

console.log('\n[2] polyFit ดีกรี 2');
{
  const pts = [];
  for (let y = 0; y < 40; y++) pts.push({ y, x: 3 + 0.5 * y + 0.02 * y * y });
  const f = polyFit(pts, 2);
  ok('ได้สัมประสิทธิ์ถูก', near(f.c[0], 3, 1e-6) && near(f.c[1], 0.5, 1e-6) && near(f.c[2], 0.02, 1e-8));
  ok('r² = 1 เมื่อไม่มีสัญญาณรบกวน', near(f.r2, 1, 1e-9), f.r2);
}

console.log('\n[3] TTC จากการขยายของกรอบ');
{
  // จำลองรถข้างหน้า: ระยะ Z ลดลงด้วยความเร็วสัมพัทธ์คงที่
  // ความกว้างในภาพ w = f·W/Z  →  1/w เป็นเส้นตรงในเวลา
  const f = 500, W = 1.8, v = 12;           // 12 m/s ≈ ชนกันในไม่กี่วินาที
  for (const Z0 of [40, 25, 15]) {
    const ts = [], inv = [];
    for (let k = 0; k < 8; k++) {
      const t = k * 0.25;
      const w = f * W / (Z0 - v * t);
      ts.push(t); inv.push(1 / w);
    }
    const fit = linRegress(ts, inv);
    const tNow = ts[ts.length - 1];
    const qNow = fit.m * tNow + fit.q;
    const ttc = -qNow / fit.m;
    const expected = (Z0 - v * tNow) / v;
    ok(`Z₀=${Z0} ม. → TTC ${ttc.toFixed(2)} วิ (ควรได้ ${expected.toFixed(2)})`,
      near(ttc, expected, 0.02), `r²=${fit.r2.toFixed(4)}`);
  }

  // วัตถุที่ถอยห่างต้องได้ความชันบวก = ไม่เตือน
  const ts = [], inv = [];
  for (let k = 0; k < 8; k++) { const t = k * 0.25; inv.push((20 + 8 * t) / (500 * 1.8)); ts.push(t); }
  ok('วัตถุถอยห่างไม่ถูกตีความว่ากำลังชน', linRegress(ts, inv).m > 0);
}

console.log('\n[4] รัศมีความโค้ง');
{
  const R = 300, pts = [0, 0.1, 0.2].map(a => ({ x: R * Math.cos(a), y: R * Math.sin(a) }));
  const r = circleRadius(pts[0], pts[1], pts[2]);
  ok(`วงกลมรัศมี 300 ม. คำนวณได้ ${r.toFixed(1)}`, near(r, 300, 1));
  ok('จุดเรียงตรงได้รัศมีอนันต์',
    circleRadius({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }) > 1e6);
}

console.log('\n[5] แยกสีเส้นจราจร');
{
  ok('ขาว', classifyLineColor(238, 240, 236) === 'white');
  ok('เหลือง', classifyLineColor(226, 176, 42) === 'yellow');
  ok('แดงเข้ม', classifyLineColor(198, 44, 40) === 'red');
  // ผิวถนนสีเทาถูกจัดเป็น 'white' ได้ตามนิยาม HSV (ไร้สี) — และนั่นถูกแล้ว
  // เพราะด่านที่กันผิวถนนออกคือเกณฑ์ contrast ตอนสแกน ไม่ใช่ตัวแยกสี
  ok('ผิวถนนเทาไม่ถูกจัดเป็นเหลืองหรือแดง',
    !['yellow', 'red'].includes(classifyLineColor(74, 72, 70)));
  ok('ดินลูกรังจางไม่ถูกนับเป็นแดง', classifyLineColor(150, 105, 82) !== 'red');
  ok('มืดสนิทไม่สรุปสี', classifyLineColor(18, 16, 15) === null);
}

console.log('\n[6] ตัวตรวจเลนบนภาพถนนสังเคราะห์');
{
  const W = 256, H = 192;
  const c = calib.get();

  /** วาดถนนเปอร์สเปคทีฟพร้อมเส้นเลนสองข้าง เลื่อนได้ด้วย shift (สัดส่วนของเฟรม) */
  function makeFrame(shift, dashLeft = false) {
    const data = new Uint8ClampedArray(W * H * 4).fill(255);
    const horizon = c.horizonY * H;
    const topY = (c.horizonY + c.nearHorizon) * H;
    const put = (x, y, r, g, b) => {
      if (x < 0 || x >= W || y < 0 || y >= H) return;
      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (y < horizon) put(x, y, 96, 104, 112);            // ท้องฟ้า
        else put(x, y, 62 + ((x * 7 + y * 13) % 9), 60, 58);  // ผิวถนนพร้อมสัญญาณรบกวนเล็กน้อย
      }
    }
    for (let y = Math.ceil(topY); y < H; y++) {
      const t = (y - topY) / (H - 1 - topY);
      const lx = (c.topLeft + (c.bottomLeft - c.topLeft) * t + shift) * W;
      const rx = (c.topRight + (c.bottomRight - c.topRight) * t + shift) * W;
      const halfW = 0.7 + 2.0 * t;
      const drawLine = (cx, dashed) => {
        if (dashed && Math.floor(y / 9) % 2 === 0) return;
        for (let x = Math.round(cx - halfW); x <= Math.round(cx + halfW); x++) put(x, y, 236, 238, 234);
      };
      drawLine(lx, dashLeft);
      drawLine(rx, false);
    }
    return { data, w: W, h: H };
  }

  const lf = new LaneFinder();
  const settle = (frame, n = 14) => { let r; for (let i = 0; i < n; i++) r = lf.update(frame, 90); return r; };

  const centered = settle(makeFrame(0));
  ok('เจอเลนบนภาพที่อยู่กลางเลนพอดี', centered.ok, JSON.stringify(centered));
  ok(`offset ใกล้ศูนย์ (ได้ ${centered.offset})`, Math.abs(centered.offset) < 0.18);
  ok(`ความเชื่อมั่น ${centered.confidence} ≥ 0.45`, centered.confidence >= 0.45);
  ok('เส้นขาวทึบสองข้างถูกรายงาน', centered.notices.length >= 1, JSON.stringify(centered.notices));
  ok('ไม่มีข้อความอนุญาตให้แซง',
    !centered.notices.some(s => s.includes('แซงได้') || s.includes('เปลี่ยนเลนได้')));

  // เลื่อนภาพไปทางขวา = เส้นเลนขยับขวา = ตัวรถอยู่ค่อนไปทางซ้ายของเลน
  const drift = settle(makeFrame(0.10));
  ok(`รถเบี่ยงซ้ายให้ offset ติดลบ (ได้ ${drift.offset})`, drift.offset < -0.2, JSON.stringify(drift));

  const lf2 = new LaneFinder();
  let dashed;
  for (let i = 0; i < 14; i++) dashed = lf2.update(makeFrame(0, true), 90);
  ok('เส้นประซ้ายไม่ถูกสรุปว่าเป็นเส้นทึบ',
    !dashed.notices.some(s => s.includes('ซ้าย')), JSON.stringify(dashed.notices));

  // ภาพว่างเปล่าต้องไม่กล้าสรุป
  const lf3 = new LaneFinder();
  const blank = { data: new Uint8ClampedArray(W * H * 4).fill(70), w: W, h: H };
  let r3; for (let i = 0; i < 14; i++) r3 = lf3.update(blank, 90);
  ok('ภาพที่ไม่มีเส้นเลย ระบบไม่สรุป', !r3.ok && r3.notices.length === 0);
}

console.log('\n[7] ตัววัดทัศนวิสัย');
{
  const W = 256, H = 192;
  const mk = fn => {
    const d = new Uint8ClampedArray(W * H * 4).fill(255);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * W + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    return { data: d, w: W, h: H };
  };
  const settle = (vm, f) => { let r; for (let i = 0; i < 12; i++) r = vm.update(f, {}); return r; };

  const clear = settle(new VisionMeter(),
    mk((x, y) => { const v = ((x >> 2) + (y >> 2)) % 2 ? 180 : 40; return [v, v, v]; }));
  const fog = settle(new VisionMeter(),
    mk(() => [206, 208, 210]));   // ฝ้าขาวสม่ำเสมอ = dark channel สูง
  const dark = settle(new VisionMeter(), mk(() => [7, 7, 8]));

  ok(`ภาพคมชัดได้คะแนนสูง (${clear.score})`, clear.score > 60);
  ok(`ภาพมีฝ้าถูกจับได้ (haze=${fog.haze}, level=${fog.level})`, fog.level === 2 && fog.haze > 0.6);
  ok(`ภาพมืดสนิทถูกเตือน (${dark.score}, level=${dark.level})`, dark.level === 2);
  ok('ภาพมืดถูกจัดว่าเป็นกลางคืน', dark.night === true);
  ok('ภาพคมชัดไม่ถูกเตือนผิด', clear.level === 0, JSON.stringify(clear));
}

console.log(`\nสรุป: ผ่าน ${pass} ข้อ, ไม่ผ่าน ${fail} ข้อ\n`);
process.exit(fail ? 1 : 0);
