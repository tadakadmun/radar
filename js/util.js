/* util.js — คณิตศาสตร์พื้นฐานที่โมดูลอื่นใช้ร่วมกัน */

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
export const lerp = (a, b, t) => a + (b - a) * t;

/** Exponential moving average ที่ทนค่า null/NaN */
export function ema(prev, next, alpha) {
  if (!Number.isFinite(next)) return prev;
  if (!Number.isFinite(prev)) return next;
  return prev + (next - prev) * alpha;
}

/** ตัวกรองมัธยฐานแบบง่าย ใช้กันค่าโดดเดี่ยว */
export function median(arr) {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * แก้ระบบสมการเชิงเส้น n×n ด้วย Gaussian elimination + partial pivoting
 * A คือ array ของแถว (แต่ละแถวยาว n) และ b ยาว n
 */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * หา homography 3×3 ที่ map จุด src 4 จุด -> dst 4 จุด
 * คืน array ยาว 9 (แถวต่อแถว) โดย h[8] = 1
 */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

/** ใช้ homography กับจุดเดียว */
export function applyH(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/**
 * ฟิตพหุนามดีกรี deg แบบ least squares: x = f(y)
 * pts = [{x, y}]  คืน { c: [c0, c1, ...], r2, n }
 */
export function polyFit(pts, deg) {
  const n = pts.length;
  if (n < deg + 1) return null;
  const m = deg + 1;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);
  for (const p of pts) {
    const pow = [1];
    for (let k = 1; k < 2 * m; k++) pow.push(pow[k - 1] * p.y);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) A[i][j] += pow[i + j];
      b[i] += pow[i] * p.x;
    }
  }
  const c = solve(A, b);
  if (!c) return null;
  const evalAt = y => c.reduce((s, ci, i) => s + ci * Math.pow(y, i), 0);
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  let ssRes = 0, ssTot = 0;
  for (const p of pts) { ssRes += (p.x - evalAt(p.y)) ** 2; ssTot += (p.x - mx) ** 2; }
  return { c, r2: ssTot < 1e-6 ? 0 : clamp(1 - ssRes / ssTot, 0, 1), n, evalAt };
}

/** ฟิตเส้นตรง y = m·t + q แล้วคืนความชันพร้อม r² (ใช้กับอนุกรมเวลา) */
export function linRegress(ts, ys) {
  const n = ts.length;
  if (n < 2) return null;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = 0; i < n; i++) { st += ts[i]; sy += ys[i]; stt += ts[i] * ts[i]; sty += ts[i] * ys[i]; }
  const den = n * stt - st * st;
  if (Math.abs(den) < 1e-12) return null;
  const m = (n * sty - st * sy) / den;
  const q = (sy - m * st) / n;
  const my = sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) { ssRes += (ys[i] - (m * ts[i] + q)) ** 2; ssTot += (ys[i] - my) ** 2; }
  return { m, q, r2: ssTot < 1e-12 ? 0 : clamp(1 - ssRes / ssTot, 0, 1) };
}

/** RGB -> ชื่อสีเส้นจราจร ('white' | 'yellow' | 'red' | null) ใช้ HSV เพราะทนแสง */
export function classifyLineColor(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const v = max / 255, s = max === 0 ? 0 : d / max;
  if (v < 0.16) return null;
  if (s < 0.18) return 'white';
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * ((((g - b) / d) % 6 + 6) % 6);
    else if (max === g) h = 60 * (((b - r) / d) + 2);
    else h = 60 * (((r - g) / d) + 4);
  }
  if (h >= 34 && h <= 74 && s >= 0.26) return 'yellow';
  // เกณฑ์แดงเข้มกว่าเดิม เพื่อลดการติดไฟเบรก รถสีแดง และดินลูกรังข้างทาง
  if ((h <= 12 || h >= 344) && s >= 0.45 && v >= 0.30) return 'red';
  return null;
}

/** ระยะทางระหว่างพิกัด (เมตร) */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** รัศมีวงกลมที่ลากผ่านสามจุด (เมตร) — ใช้ประมาณความโค้งถนน */
export function circleRadius(p1, p2, p3) {
  const a = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const b = Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const c = Math.hypot(p3.x - p1.x, p3.y - p1.y);
  const s = (a + b + c) / 2;
  const areaSq = s * (s - a) * (s - b) * (s - c);
  if (areaSq <= 1e-6) return Infinity;
  return (a * b * c) / (4 * Math.sqrt(areaSq));
}

/** แปลง lat/lon เป็นระนาบเมตรแบบเฉพาะถิ่น (พอสำหรับระยะไม่กี่กิโลเมตร) */
export function toLocalMeters(lat, lon, refLat, refLon) {
  const R = 6371000, toRad = Math.PI / 180;
  return {
    x: (lon - refLon) * toRad * R * Math.cos(refLat * toRad),
    y: (lat - refLat) * toRad * R,
  };
}

export const nowMs = () => performance.now();
