/* osm.js — ข้อมูลถนนจาก OpenStreetMap ผ่าน Overpass API
 *
 * บริการนี้ใช้ฟรี ไม่ต้องมีคีย์ ไม่ต้องมีบัญชี แต่ "ฟรี" ยังมีต้นทุนสองอย่าง
 * ที่ต้องออกแบบรองรับ:
 *
 *   1. ค่าเน็ตมือถือของผู้ใช้ — รุ่นแรกดึงใหม่ทุก 30 วินาทีแล้วทิ้งของเก่า
 *      ขับสองชั่วโมงอาจกินหลายสิบเมกะไบต์ ซึ่งก็คือเงิน
 *      จึงเปลี่ยนมาเก็บเป็นตารางพื้นที่ (ราว 2 กม.) ไว้ใน IndexedDB
 *      เส้นทางที่ขับซ้ำทุกวันจึงไม่ต้องโหลดอีกเลย
 *
 *   2. ภาระของเซิร์ฟเวอร์อาสาสมัคร — จำกัดหนึ่งคำขอต่อ 30 วินาที
 *      และดึงเฉพาะตารางที่ยังไม่มีในเครื่อง
 *
 * มีเพดานปริมาณข้อมูลต่อการใช้งานหนึ่งครั้ง และปิดการใช้อินเทอร์เน็ตได้ทั้งหมด
 * ถ้าปิด ระบบยังเตือนชนท้ายและออกนอกเลนได้ครบ เพียงแต่ไม่มีข้อมูลความเร็วจำกัดและโค้ง
 */

import { toLocalMeters, circleRadius, clamp } from './util.js';
import * as store from './store.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const TILE_DEG = 0.02;            // ราว 2.2 กม.
const TILE_MARGIN = 0.003;        // เผื่อขอบให้ถนนต่อเนื่องข้ามตาราง
const MIN_INTERVAL_MS = 30000;
const TILE_TTL_MS = 30 * 24 * 3600 * 1000;
const PREFIX = 'osm:';
const SETTINGS_KEY = 'navassist.osm.settings';

const HW = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link)$';

function parseMaxspeed(tag) {
  if (!tag) return null;
  const s = String(tag).trim().toLowerCase();
  if (s === 'none' || s === 'signals' || s === 'walk') return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(km\/h|kph|kmh)?$/);
  if (m) return Math.round(parseFloat(m[1]));
  const mph = s.match(/^(\d+(?:\.\d+)?)\s*mph$/);
  if (mph) return Math.round(parseFloat(mph[1]) * 1.609);
  return null;   // ค่าแบบ "TH:urban" เราไม่เดา เพราะเดาผิดแล้วเตือนผิด
}

function bearing(a, b) {
  const toRad = Math.PI / 180;
  const dLon = (b.lon - a.lon) * toRad;
  const y = Math.sin(dLon) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
    Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const tileId = (lat, lon) => `${PREFIX}${Math.floor(lat / TILE_DEG)}_${Math.floor(lon / TILE_DEG)}`;

export class RoadData {
  constructor() {
    this.loaded = new Map();       // tileId -> ways[]
    this.pending = new Set();
    this.lastFetch = 0;
    this.bytesThisSession = 0;
    this.status = 'ยังไม่มีข้อมูลถนน';

    // ค่าที่ผู้ใช้ตั้งได้: ปิดการใช้อินเทอร์เน็ต และเพดานข้อมูลต่อการใช้งานหนึ่งครั้ง
    this.settings = { enabled: true, budgetMB: 25 };
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (raw) this.settings = { ...this.settings, ...raw };
    } catch { }

    store.prune(PREFIX, TILE_TTL_MS);
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch { }
    if (!this.settings.enabled) this.status = 'ปิดการใช้ข้อมูลถนนอยู่';
  }

  get budgetExceeded() {
    return this.bytesThisSession > this.settings.budgetMB * 1024 * 1024;
  }

  get dataUsedMB() { return this.bytesThisSession / 1048576; }

  /** ตารางที่ควรมีไว้: ตารางปัจจุบัน และตารางถัดไปตามทิศทางที่วิ่ง */
  #wantedTiles(lat, lon, headingDeg, speedKmh) {
    const want = [tileId(lat, lon)];
    if (headingDeg != null && speedKmh > 30) {
      const rad = headingDeg * Math.PI / 180;
      const ahead = 1.5 * TILE_DEG;
      const nLat = lat + Math.cos(rad) * ahead;
      const nLon = lon + Math.sin(rad) * ahead / Math.max(0.2, Math.cos(lat * Math.PI / 180));
      const id = tileId(nLat, nLon);
      if (id !== want[0]) want.push(id);
    }
    return want;
  }

  /** เรียกได้บ่อยเท่าไหร่ก็ได้ ตัวมันเองรู้ว่าเมื่อไหร่ควรทำงานจริง */
  async update(lat, lon, headingDeg, speedKmh) {
    if (!this.settings.enabled) { this.status = 'ปิดการใช้ข้อมูลถนนอยู่'; return; }

    for (const id of this.#wantedTiles(lat, lon, headingDeg, speedKmh)) {
      if (this.loaded.has(id) || this.pending.has(id)) continue;
      this.pending.add(id);
      try {
        const cached = await store.get(id);
        if (cached && Date.now() - cached.t < TILE_TTL_MS) {
          this.loaded.set(id, cached.ways);
          this.#updateStatus();
          continue;
        }
        if (!navigator.onLine) { this.status = 'ออฟไลน์ ใช้เท่าที่เก็บไว้'; continue; }
        if (this.budgetExceeded) { this.status = 'ถึงเพดานข้อมูลที่ตั้งไว้แล้ว'; continue; }
        if (Date.now() - this.lastFetch < MIN_INTERVAL_MS) continue;

        this.lastFetch = Date.now();
        await this.#fetchTile(id);
      } finally {
        this.pending.delete(id);
      }
    }

    // ปล่อยตารางที่อยู่ไกลออกจากหน่วยความจำ (ข้อมูลยังอยู่ในเครื่อง)
    if (this.loaded.size > 6) {
      const here = tileId(lat, lon);
      for (const id of [...this.loaded.keys()]) {
        if (id !== here && this.loaded.size > 6) this.loaded.delete(id);
      }
    }
  }

  async #fetchTile(id) {
    const [ty, tx] = id.slice(PREFIX.length).split('_').map(Number);
    const s = ty * TILE_DEG - TILE_MARGIN, n = (ty + 1) * TILE_DEG + TILE_MARGIN;
    const w = tx * TILE_DEG - TILE_MARGIN, e = (tx + 1) * TILE_DEG + TILE_MARGIN;
    const q = `[out:json][timeout:25];way(${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)})["highway"~"${HW}"];out geom tags;`;

    for (const url of ENDPOINTS) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: ctrl.signal,
        });
        clearTimeout(to);
        if (!res.ok) continue;

        const text = await res.text();
        this.bytesThisSession += text.length;
        const json = JSON.parse(text);

        const ways = (json.elements || [])
          .filter(el => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 2)
          .map(el => ({
            name: el.tags?.name || null,
            maxspeed: parseMaxspeed(el.tags?.maxspeed),
            geom: el.geometry.map(g => ({ lat: g.lat, lon: g.lon })),
          }));

        this.loaded.set(id, ways);
        store.set(id, { t: Date.now(), ways });
        this.#updateStatus();
        return;
      } catch { /* ลองเซิร์ฟเวอร์ถัดไป */ }
    }
    this.status = 'ดึงข้อมูลถนนไม่ได้ (ระบบอื่นยังทำงานปกติ)';
  }

  #updateStatus() {
    const n = [...this.loaded.values()].reduce((sum, w) => sum + w.length, 0);
    const mb = this.dataUsedMB;
    this.status = `ถนน ${n} เส้น` + (mb > 0.05 ? ` • ใช้เน็ต ${mb.toFixed(1)} MB` : ' • จากที่เก็บไว้');
  }

  /** ล้างข้อมูลถนนที่เก็บไว้ทั้งหมด */
  async clearCache() {
    this.loaded.clear();
    const ks = await store.keys();
    for (const k of ks) if (typeof k === 'string' && k.startsWith(PREFIX)) await store.del(k);
    this.status = 'ล้างข้อมูลถนนแล้ว';
  }

  /** หาถนนที่รถอยู่ตอนนี้ พร้อมข้อมูลจำกัดความเร็วและโค้งข้างหน้า */
  match(lat, lon, headingDeg, speedKmh) {
    let best = null;
    for (const ways of this.loaded.values()) {
      for (const way of ways) {
        for (let i = 0; i < way.geom.length - 1; i++) {
          const a = way.geom[i], b = way.geom[i + 1];
          // ตัดถนนที่อยู่ไกลออกก่อนคำนวณจริง เพื่อไม่ให้ลูปนี้หนักเกินไป
          if (Math.abs(a.lat - lat) > 0.005 && Math.abs(b.lat - lat) > 0.005) continue;
          const d = pointToSegmentM(lat, lon, a, b);
          if (d > 28) continue;
          const brg = bearing(a, b);
          let align = 0;
          if (headingDeg != null) {
            align = Math.min(angleDiff(brg, headingDeg), angleDiff((brg + 180) % 360, headingDeg));
            if (align > 55) continue;
          }
          const cost = d + align * 0.25;
          if (!best || cost < best.cost) {
            best = {
              way, idx: i, dist: d, cost,
              forward: headingDeg == null || angleDiff(brg, headingDeg) <= 90,
            };
          }
        }
      }
    }
    if (!best) return null;
    return {
      way: best.way,
      maxspeed: best.way.maxspeed,
      distanceM: Math.round(best.dist),
      curve: this.#curveAhead(best, lat, lon, speedKmh),
    };
  }

  /** โค้งที่แหลมที่สุดในระยะที่จะถึงภายในไม่กี่วินาทีข้างหน้า */
  #curveAhead(m, lat, lon, speedKmh) {
    const geom = m.way.geom;
    const lookaheadM = clamp((speedKmh / 3.6) * 6, 80, 400);
    const order = m.forward
      ? Array.from({ length: geom.length - m.idx }, (_, k) => m.idx + k)
      : Array.from({ length: m.idx + 2 }, (_, k) => m.idx + 1 - k).filter(i => i >= 0);

    const pts = order.map(i => toLocalMeters(geom[i].lat, geom[i].lon, lat, lon));
    let acc = 0, minR = Infinity, atM = null;
    for (let i = 1; i < pts.length - 1; i++) {
      acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (acc > lookaheadM) break;
      if (acc < 15) continue;
      const R = circleRadius(pts[i - 1], pts[i], pts[i + 1]);
      if (R < minR) { minR = R; atM = Math.round(acc); }
    }
    if (!Number.isFinite(minR) || minR > 900) return null;

    // ความเร็วที่ยังสบายในโค้งรัศมี R โดยใช้แรงเข้าศูนย์กลางประมาณ 0.25 g
    const safeKmh = Math.round(Math.sqrt(0.25 * 9.81 * minR) * 3.6);
    return { radiusM: Math.round(minR), distanceM: atM, safeKmh };
  }
}

function pointToSegmentM(lat, lon, a, b) {
  const p = toLocalMeters(lat, lon, a.lat, a.lon);
  const q = toLocalMeters(b.lat, b.lon, a.lat, a.lon);
  const len2 = q.x * q.x + q.y * q.y;
  if (len2 < 1e-6) return Math.hypot(p.x, p.y);
  const t = clamp((p.x * q.x + p.y * q.y) / len2, 0, 1);
  return Math.hypot(p.x - q.x * t, p.y - q.y * t);
}

/* ---------- ตรรกะการเตือนความเร็วและโค้ง ---------- */

const SPEED = { tolerance: 1.08, minOver: 5, sustainMs: 4000, cooldownMs: 25000 };
const CURVE = { factor: 1.15, cooldownMs: 20000 };

const spState = { since: 0, last: 0 };
const cvState = { last: 0, lastRadius: 0 };

export function assessSpeed(match, speedKmh, now) {
  if (!match?.maxspeed || speedKmh < 25) { spState.since = 0; return null; }
  const limit = match.maxspeed;
  const over = speedKmh - limit;
  if (speedKmh <= limit * SPEED.tolerance || over < SPEED.minOver) { spState.since = 0; return null; }
  if (!spState.since) { spState.since = now; return null; }
  if (now - spState.since < SPEED.sustainMs) return null;
  if (now - spState.last < SPEED.cooldownMs) return null;
  spState.last = now;
  return { limit, over: Math.round(over) };
}

export function assessCurve(match, speedKmh, now) {
  const c = match?.curve;
  if (!c || speedKmh < 40) return null;
  if (speedKmh <= c.safeKmh * CURVE.factor) return null;
  if (now - cvState.last < CURVE.cooldownMs && Math.abs(c.radiusM - cvState.lastRadius) < 40) return null;
  cvState.last = now;
  cvState.lastRadius = c.radiusM;
  return c;
}
