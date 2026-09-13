/* lane.js — ตรวจจับเส้นแบ่งเลนและตำแหน่งรถในเลน
 *
 * ต่างจากรุ่นเดิมตรงที่แปลงภาพเป็นมุมมองจากด้านบน (bird's-eye) ก่อน
 * เพราะบนภาพเปอร์สเปคทีฟ เส้นเลนจะลู่เข้าหากันเสมอ ทำให้ค่า "รถเบี่ยงไปกี่เมตร"
 * เปลี่ยนไปตามมุมก้มของโทรศัพท์ พอ warp เป็นมุมบนแล้ว เส้นเลนกลายเป็นเส้นตั้งขนานกัน
 * ค่าที่วัดได้จึงเทียบเป็นเมตรได้จริง และการฟิตเส้นก็มีความหมาย
 *
 * หลักการที่ยึด: ระบบนี้ "เตือน" ได้ แต่ "อนุญาต" ไม่ได้
 * จึงไม่มีข้อความใดที่บอกว่าแซงได้ เพราะการอ่านเส้นประผิดเพียงครั้งเดียว
 * แล้วบอกให้แซง คือความเสียหายที่ย้อนคืนไม่ได้
 */

import { clamp, ema, median, homography, applyH, polyFit, classifyLineColor } from './util.js';
import * as calib from './calibrate.js';

const BW = 128, BH = 128;         // ขนาดภาพมุมบน
const SCAN_STEP = 2;
const BASE_WIN = 25;              // หน้าต่างหาระดับผิวถนนเฉพาะถิ่น
const MAX_RUN = 7;                // ความกว้างสูงสุดของแถบที่ยอมรับว่าเป็นเส้น
const SMOOTH = 0.28;

/* ภาพมุมบนต้องกว้างกว่าหนึ่งเลน มิฉะนั้นพอรถเริ่มเบี่ยง เส้นเลนฝั่งหนึ่ง
 * จะหลุดออกนอกพื้นที่วิเคราะห์ แล้วระบบจะตาบอดพอดีตอนที่ควรเตือนที่สุด
 * จึงขยายออกด้านข้างข้างละ 45% ของความกว้างเลน รวมเป็นราวสองเลน */
const MARGIN = 0.45;
const LANE_SPAN = 1 + 2 * MARGIN;
const EXPECT_W = BW / LANE_SPAN;  // ความกว้างเลนที่ควรวัดได้บนภาพมุมบน

export class LaneFinder {
  constructor() {
    this.map = null;              // ตารางแปลงพิกัด BEV -> พิกเซลต้นทาง
    this.mapKey = '';
    this.srcXY = null;            // พิกัดต้นทางของทุกจุด BEV (ไว้วาดทับภาพ)
    this.egoBev = BW / 2;
    this.pxPerM = BW / calib.get().laneWidthM;

    this.st = {
      offset: 0, curve: 0, conf: 0, doubleY: 0,
      covL: 0, covR: 0,
      voteL: { white: 0, yellow: 0, red: 0 },
      voteR: { white: 0, yellow: 0, red: 0 },
    };
    this.hits = [];
    this.bev = new Uint8ClampedArray(BW * BH * 4);
  }

  /** สร้างตารางแปลงพิกัดใหม่เมื่อขนาดเฟรมหรือค่าติดตั้งเปลี่ยน */
  #buildMap(fw, fh) {
    const c = calib.get();
    const key = `${fw}x${fh}|${c.horizonY}|${c.bottomLeft}|${c.bottomRight}|${c.topLeft}|${c.topRight}|${c.nearHorizon}|${c.egoX}|${c.laneWidthM}`;
    if (this.mapKey === key && this.map) return true;

    const q0 = calib.roadQuad(fw, fh);
    // ขยายสี่เหลี่ยมคางหมูออกด้านข้าง โดยขยายตามความกว้างของแต่ละแถว
    const widen = (a, b) => {
      const d = (b[0] - a[0]) * MARGIN;
      return [[a[0] - d, a[1]], [b[0] + d, b[1]]];
    };
    const [tl, tr] = widen(q0[0], q0[1]);
    const [bl, br] = widen(q0[3], q0[2]);
    const quad = [tl, tr, br, bl];
    const dst = [[0, 0], [BW - 1, 0], [BW - 1, BH - 1], [0, BH - 1]];
    const Hinv = homography(dst, quad);   // BEV -> ภาพต้นทาง
    const Hfwd = homography(quad, dst);   // ภาพต้นทาง -> BEV
    if (!Hinv || !Hfwd) return false;

    const map = new Int32Array(BW * BH);
    const srcXY = new Float32Array(BW * BH * 2);
    for (let v = 0; v < BH; v++) {
      for (let u = 0; u < BW; u++) {
        const [sx, sy] = applyH(Hinv, u, v);
        const xi = clamp(Math.round(sx), 0, fw - 1);
        const yi = clamp(Math.round(sy), 0, fh - 1);
        const idx = v * BW + u;
        map[idx] = (yi * fw + xi) * 4;
        srcXY[idx * 2] = sx / fw;         // เก็บเป็นสัดส่วน จะได้ใช้กับ canvas ขนาดใดก็ได้
        srcXY[idx * 2 + 1] = sy / fh;
      }
    }

    this.map = map;
    this.srcXY = srcXY;
    this.mapKey = key;
    const [ex] = applyH(Hfwd, c.egoX * fw, fh - 1);
    this.egoBev = clamp(ex, BW * 0.15, BW * 0.85);
    this.pxPerM = EXPECT_W / c.laneWidthM;
    return true;
  }

  /**
   * @param {{data: Uint8ClampedArray, w: number, h: number}} frame ภาพย่อของทั้งเฟรม
   * @param {number} speedKmh ใช้ปรับความไวและกันการเตือนตอนจอด
   */
  update(frame, speedKmh) {
    if (!this.#buildMap(frame.w, frame.h)) return this.#result(false);

    // warp เป็นมุมบน
    const src = frame.data, bev = this.bev, map = this.map;
    for (let i = 0, n = BW * BH; i < n; i++) {
      const s = map[i], d = i * 4;
      bev[d] = src[s]; bev[d + 1] = src[s + 1]; bev[d + 2] = src[s + 2];
    }

    const hits = [];
    const lum = new Float32Array(BW);
    const base = new Float32Array(BW);
    const pre = new Float32Array(BW + 1);
    const half = BASE_WIN >> 1;
    let rowsScanned = 0;

    for (let v = 0; v < BH; v += SCAN_STEP) {
      rowsScanned++;
      const row = v * BW * 4;
      let mean = 0;
      for (let u = 0; u < BW; u++) {
        const i = row + u * 4;
        lum[u] = 0.2126 * bev[i] + 0.7152 * bev[i + 1] + 0.0722 * bev[i + 2];
        mean += lum[u];
      }
      mean /= BW;
      let varSum = 0;
      for (let u = 0; u < BW; u++) varSum += (lum[u] - mean) ** 2;
      const sd = Math.sqrt(varSum / BW);

      // เกณฑ์ความต่างปรับตามความแปรปรวนของแถวนั้น
      // ถนนเรียบมืดจะได้เกณฑ์ต่ำ ถนนที่มีเงาไม้จะได้เกณฑ์สูงขึ้นเอง
      const minContrast = Math.max(7, sd * 0.85);

      pre[0] = 0;
      for (let u = 0; u < BW; u++) pre[u + 1] = pre[u] + lum[u];
      for (let u = 0; u < BW; u++) {
        const a = Math.max(0, u - half), b = Math.min(BW, u + half + 1);
        base[u] = (pre[b] - pre[a]) / (b - a);
      }

      let run = null;
      for (let u = 0; u <= BW; u++) {
        const isLine = u < BW && (lum[u] - base[u]) > minContrast;
        if (isLine) { run ? (run.x1 = u) : (run = { x0: u, x1: u }); continue; }
        if (!run) continue;
        const w = run.x1 - run.x0 + 1;
        if (w <= MAX_RUN) {
          let r = 0, g = 0, bl = 0, n = 0;
          for (let px = run.x0; px <= run.x1; px++) {
            const i = row + px * 4;
            r += bev[i]; g += bev[i + 1]; bl += bev[i + 2]; n++;
          }
          const color = classifyLineColor(r / n, g / n, bl / n);
          if (color) hits.push({ x: (run.x0 + run.x1) / 2, y: v, w, color });
        }
        run = null;
      }
    }
    this.hits = hits;

    // แยกซ้าย/ขวา
    //
    // การแบ่งด้วยเส้นตั้งที่กึ่งกลางรถใช้ไม่ได้ เพราะเมื่อรถเบี่ยงออกจากกลางเลน
    // ปลายไกลของเส้นฝั่งใกล้จะข้ามไปอยู่อีกฝั่งของกึ่งกลาง แล้วถูกจับผิดข้าง
    // ผลคือความกว้างเลนที่วัดได้หดลง และค่าการเบี่ยงถูกรายงานน้อยกว่าความจริง
    // ซึ่งแปลว่าระบบจะเตือนช้าไปพอดีตอนที่รถกำลังออกนอกเลนจริงๆ
    //
    // จึงใช้แถบใกล้รถ (ที่เส้นยังไม่ข้ามกัน) เป็นตัวตั้งต้น ฟิตเส้นหยาบก่อน
    // แล้วค่อยจัดทุกจุดเข้าเส้นที่ใกล้กว่า พร้อมทิ้งจุดที่ห่างเกินไปเป็นสัญญาณรบกวน
    const { L, R } = this.#splitSides(hits);
    const fL = polyFit(L, 2), fR = polyFit(R, 2);
    const rowsL = new Set(L.map(h => h.y)).size;
    const rowsR = new Set(R.map(h => h.y)).size;

    const st = this.st;
    st.covL = ema(st.covL, rowsL / rowsScanned, SMOOTH);
    st.covR = ema(st.covR, rowsR / rowsScanned, SMOOTH);

    for (const [side, srcHits] of [['voteL', L], ['voteR', R]]) {
      for (const k of ['white', 'yellow', 'red']) {
        const now = srcHits.filter(h => h.color === k).length / Math.max(1, rowsScanned);
        st[side][k] = ema(st[side][k], now, SMOOTH);
      }
    }

    // เส้นเหลืองคู่: แถบเหลืองสองแถบขนานชิดกันในแถวเดียว
    let dyNow = 0;
    const byRow = new Map();
    for (const h of hits) {
      if (h.color !== 'yellow') continue;
      if (!byRow.has(h.y)) byRow.set(h.y, []);
      byRow.get(h.y).push(h.x);
    }
    for (const xs of byRow.values()) {
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        const gap = xs[i] - xs[i - 1];
        if (gap > 1.2 && gap < BW * 0.10) { dyNow = 1; break; }
      }
      if (dyNow) break;
    }
    st.doubleY = ema(st.doubleY, dyNow, SMOOTH);

    // ตำแหน่งในเลนและความโค้ง
    let laneOk = false, offsetNow = st.offset, curveNow = st.curve, widthPx = 0;
    const MIN_ROWS = Math.max(4, Math.round(rowsScanned * 0.28));
    if (fL && fR && rowsL >= MIN_ROWS && rowsR >= MIN_ROWS) {
      const yb = BH - 1;
      const xL = fL.evalAt(yb), xR = fR.evalAt(yb);
      widthPx = xR - xL;
      // บนภาพมุมบน เลนที่ calibrate ถูกต้องควรกว้างใกล้ BW
      if (widthPx > EXPECT_W * 0.62 && widthPx < EXPECT_W * 1.7) {
        laneOk = true;
        offsetNow = (this.egoBev - (xL + xR) / 2) / (widthPx / 2);
        curveNow = (fL.c[2] + fR.c[2]) / 2;   // สัมประสิทธิ์กำลังสอง = ความโค้ง
      }
    }
    st.offset = ema(st.offset, clamp(offsetNow, -2, 2), SMOOTH);
    st.curve = ema(st.curve, curveNow, SMOOTH);

    const fitQ = ((fL?.r2 || 0) + (fR?.r2 || 0)) / 2;
    const covQ = clamp((st.covL + st.covR) / 1.3, 0, 1);
    const widthQ = laneOk ? clamp(1 - Math.abs(widthPx - EXPECT_W) / EXPECT_W, 0, 1) : 0;
    const confNow = laneOk ? (0.45 * fitQ + 0.35 * covQ + 0.20 * widthQ) : 0.25 * covQ;
    st.conf = ema(st.conf, clamp(confNow, 0, 1), SMOOTH);

    return this.#result(laneOk, widthPx, speedKmh);
  }

  #splitSides(hits) {
    const nearY = BH * 0.55;
    const near = hits.filter(h => h.y >= nearY);
    const nl = near.filter(h => h.x < this.egoBev);
    const nr = near.filter(h => h.x >= this.egoBev);

    // ข้อมูลแถบใกล้ไม่พอ ก็ตกกลับไปใช้การแบ่งแบบเดิม
    if (nl.length < 3 || nr.length < 3) {
      return { L: hits.filter(h => h.x < this.egoBev), R: hits.filter(h => h.x >= this.egoBev) };
    }

    const f0L = polyFit(nl, 1) || { evalAt: () => median(nl.map(h => h.x)) };
    const f0R = polyFit(nr, 1) || { evalAt: () => median(nr.map(h => h.x)) };
    const maxDev = EXPECT_W * 0.32;

    const L = [], R = [];
    for (const h of hits) {
      const dl = Math.abs(h.x - f0L.evalAt(h.y));
      const dr = Math.abs(h.x - f0R.evalAt(h.y));
      const d = Math.min(dl, dr);
      if (d > maxDev) continue;          // ห่างจากทั้งสองเส้นมาก = ไม่ใช่เส้นเลน
      (dl <= dr ? L : R).push(h);
    }
    return { L, R };
  }

  #pick(vote) {
    let best = null, bv = 0.14;
    for (const k of ['white', 'yellow', 'red']) if (vote[k] > bv) { bv = vote[k]; best = k; }
    return best;
  }

  #result(laneOk, widthPx = 0, speedKmh = 0) {
    const st = this.st;
    const ok = laneOk && st.conf >= 0.45;

    // เส้นทึบต้องเห็นเกือบทุกแถวจึงจะสรุป — เกณฑ์เข้มโดยตั้งใจ
    // ส่วนเส้นประเราไม่สรุปอะไรเลย เพราะไม่มีเหตุผลด้านความปลอดภัยที่ต้องบอก
    const solid = cov => cov >= 0.82;
    const left = { color: this.#pick(st.voteL), solid: solid(st.covL), coverage: +st.covL.toFixed(2) };
    const right = { color: this.#pick(st.voteR), solid: solid(st.covR), coverage: +st.covR.toFixed(2) };
    const doubleYellow = st.doubleY > 0.5;

    const notices = [];
    if (ok) {
      if (doubleYellow) notices.push('เส้นเหลืองคู่ ห้ามแซง');
      else {
        if (left.color === 'yellow' && left.solid) notices.push('เส้นเหลืองทึบซ้าย ห้ามแซงล้ำเส้น');
        else if (left.color === 'white' && left.solid) notices.push('เส้นขาวทึบซ้าย ไม่ควรเปลี่ยนเลน');
        if (right.color === 'yellow' && right.solid) notices.push('เส้นเหลืองทึบขวา ห้ามแซงล้ำเส้น');
        else if (right.color === 'white' && right.solid) notices.push('เส้นขาวทึบขวา ไม่ควรเปลี่ยนเลน');
      }
    }

    const offsetM = ok ? st.offset * (calib.get().laneWidthM / 2) : null;
    const curveDir = !ok || Math.abs(st.curve) < 0.0009 ? 'straight'
      : st.curve > 0 ? 'right' : 'left';

    return {
      ok,
      confidence: +st.conf.toFixed(2),
      offset: ok ? +st.offset.toFixed(2) : null,   // -1 = ทับเส้นซ้าย, +1 = ทับเส้นขวา
      offsetM: offsetM == null ? null : +offsetM.toFixed(2),
      widthPx: +widthPx.toFixed(1),
      curve: curveDir,
      left, right, doubleYellow, notices,
      hitCount: this.hits.length,
    };
  }

  /** วาดจุดที่ตรวจเจอกลับลงบนภาพจริง เพื่อให้ผู้ใช้ตรวจสอบได้ว่าระบบเห็นอะไร */
  drawOverlay(ctx, cw, ch) {
    if (!this.srcXY) return;
    const paint = { white: 'rgba(255,255,255,.85)', yellow: 'rgba(240,190,60,.9)', red: 'rgba(226,90,80,.9)' };
    const r = Math.max(2, cw / 260);
    for (const h of this.hits) {
      const idx = (h.y * BW + Math.round(h.x)) * 2;
      const x = this.srcXY[idx] * cw, y = this.srcXY[idx + 1] * ch;
      ctx.fillStyle = paint[h.color] || 'rgba(150,150,150,.6)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 6.2832);
      ctx.fill();
    }
  }

  reset() {
    this.st.offset = 0; this.st.curve = 0; this.st.conf = 0;
    this.hits = [];
  }
}

/* ---------- การเตือนออกนอกเลน ---------- */

const LDW = {
  threshold: 0.72,       // สัดส่วนของครึ่งเลน
  minConf: 0.58,
  minSpeedKmh: 45,       // ในเมืองรถเบี่ยงในเลนเป็นเรื่องปกติ เตือนเฉพาะทางเร็ว
  sustainMs: 550,        // ต้องเบี่ยงค้างนานเท่านี้ ไม่ใช่แค่แวบเดียว
  cooldownMs: 8000,
};

const ldwState = { side: null, since: 0, lastFired: 0 };

/**
 * @returns {{fire: boolean, side: 'left'|'right'|null}}
 */
export function assessDeparture(lane, speedKmh, now) {
  if (!lane.ok || lane.confidence < LDW.minConf || speedKmh < LDW.minSpeedKmh) {
    ldwState.side = null;
    return { fire: false, side: null };
  }
  const off = lane.offset;
  const side = off > LDW.threshold ? 'right' : off < -LDW.threshold ? 'left' : null;

  if (!side) { ldwState.side = null; return { fire: false, side: null }; }
  if (ldwState.side !== side) { ldwState.side = side; ldwState.since = now; return { fire: false, side }; }
  if (now - ldwState.since < LDW.sustainMs) return { fire: false, side };
  if (now - ldwState.lastFired < LDW.cooldownMs) return { fire: false, side };

  ldwState.lastFired = now;
  return { fire: true, side };
}
