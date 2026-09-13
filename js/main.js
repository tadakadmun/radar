/* main.js — ตัวประสานงานทั้งระบบ
 *
 * ลำดับความสำคัญของสิ่งที่แสดงบนแถบกลางจอ (บนสุดชนะเสมอ):
 *   1. ระบบไม่พร้อม            — ต้องรู้ก่อนอย่างอื่น ไม่งั้นจะเชื่อจอที่ไม่มีข้อมูล
 *   2. เสี่ยงชนท้าย            — เหลือเวลาเป็นวินาที
 *   3. ออกนอกเลน
 *   4. กล้องมองไม่เห็น         — บอกว่าอย่าเพิ่งเชื่อสองข้อบน
 *   5. โค้งข้างหน้าเร็วเกินไป
 *   6. เกินความเร็วจำกัด
 *   7. สถานะปกติ
 */

import { Camera } from './camera.js';
import { Detector } from './detector.js';
import { Tracker, assessCollision } from './tracker.js';
import { LaneFinder, assessDeparture } from './lane.js';
import { VisionMeter } from './vision.js';
import { Alerts, LEVEL } from './alerts.js';
import { Geo } from './geo.js';
import { RoadData, assessSpeed, assessCurve } from './osm.js';
import { Health, STATE } from './health.js';
import { UI } from './ui.js';
import * as calib from './calibrate.js';
import { CLASS_TH } from './detector.js';

const SAMPLE_W = 256;                       // ความกว้างของภาพย่อที่ใช้วิเคราะห์
const INFER_MS = [180, 260, 400];           // คาบการตรวจจับตามระดับการลดคุณภาพ
const ANALYSIS_MS = [110, 160, 240];        // คาบการวิเคราะห์เลน/ทัศนวิสัย

const ui = new UI();
const camera = new Camera(ui.video);
const detector = new Detector();
const tracker = new Tracker();
const laneFinder = new LaneFinder();
const vision = new VisionMeter();
const alerts = new Alerts();
const geo = new Geo();
const roads = new RoadData();
const health = new Health();

// canvas เดียวสำหรับอ่านพิกเซล ทั้งเลนและทัศนวิสัยใช้ผลอ่านครั้งเดียวกัน
// การอ่านพิกเซลคือการดึงข้อมูลจาก GPU กลับมา CPU ซึ่งแพงที่สุดในลูปนี้
const sample = document.createElement('canvas');
const sctx = sample.getContext('2d', { willReadFrequently: true });

let running = false;
let soundOn = true;
let lastInfer = 0, lastAnalysis = 0, lastFrame = 0;
let tracks = [];
let lane = { ok: false, notices: [], confidence: 0, offset: null, curve: 'straight' };
let visionState = { score: 100, level: 0, night: false, reason: null };
let threat = { level: 0, track: null, ttc: null };
let roadMatch = null;
let calibMode = false;

/* ---------- อ่านพิกเซลครั้งเดียวต่อรอบ ---------- */

function grabFrame() {
  const vw = ui.video.videoWidth, vh = ui.video.videoHeight;
  if (!vw || !vh) return null;
  const w = SAMPLE_W, h = Math.max(72, Math.round(SAMPLE_W * vh / vw));
  if (sample.width !== w || sample.height !== h) { sample.width = w; sample.height = h; }
  sctx.drawImage(ui.video, 0, 0, w, h);
  return { data: sctx.getImageData(0, 0, w, h).data, w, h };
}

/* ---------- ลูปหลัก ---------- */

async function loop() {
  if (!running) return;
  const t = performance.now();
  const frameMs = lastFrame ? t - lastFrame : 0;
  lastFrame = t;

  if (!camera.ready) {
    health.tick(t, false);
    render();
    requestAnimationFrame(loop);
    return;
  }

  const lvl = health.degradeLevel;

  // วิเคราะห์ภาพ (เลน + ทัศนวิสัย) — ราคาถูกกว่าการตรวจจับวัตถุมาก
  if (t - lastAnalysis >= ANALYSIS_MS[lvl]) {
    lastAnalysis = t;
    try {
      const frame = grabFrame();
      if (frame) {
        visionState = vision.update(frame, camera.settings());
        lane = laneFinder.update(frame, geo.speedKmh);
      }
    } catch (e) { console.warn('analysis', e); }
  }

  // ตรวจจับวัตถุ
  if (t - lastInfer >= INFER_MS[lvl] && !detector.busy) {
    lastInfer = t;
    try {
      const dets = await detector.detect(ui.video, 0.45);
      if (dets) {
        const w = ui.video.videoWidth, h = ui.video.videoHeight;
        tracks = tracker.update(dets, performance.now(), {
          width: w, height: h,
          corridor: calib.egoCorridor(w, h),
          focalPx: calib.focalPx(w, camera.fovDeg()),
        });
        threat = assessCollision(tracks, geo.speedKmh, geo.hasFix);
        health.markInference(performance.now(), detector.lastLatency, frameMs);
      }
    } catch (e) {
      console.error('detect', e);
      health.fail('ระบบตรวจจับวัตถุขัดข้อง');
    }
  }

  health.tick(t, camera.ready);
  updateRoadData();
  decide(Date.now());
  render();
  requestAnimationFrame(loop);
}

/* ---------- ข้อมูลถนนจาก OSM ---------- */

function updateRoadData() {
  if (!geo.hasFix) { roadMatch = null; return; }
  // ตัวมันเองรู้ว่าตารางไหนมีอยู่แล้ว จึงเรียกได้ทุกเฟรมโดยไม่กินเน็ตเพิ่ม
  roads.update(geo.lat, geo.lon, geo.heading, geo.speedKmh).catch(() => { });
  roadMatch = roads.match(geo.lat, geo.lon, geo.heading, geo.speedKmh);
}

/* ---------- การตัดสินใจว่าจะเตือนอะไร ---------- */

function decide(now) {
  if (!health.trustworthy) return;

  // 1. เสี่ยงชนท้าย
  if (threat.level === 2) {
    const what = CLASS_TH[threat.track.cls] || 'สิ่งกีดขวาง';
    alerts.fire('fcw', LEVEL.CRITICAL, `เบรก — ${what}ข้างหน้า`, 'เบรก');
    return;
  }
  if (threat.level === 1) {
    const what = CLASS_TH[threat.track.cls] || 'สิ่งกีดขวาง';
    alerts.fire('fcw', LEVEL.WARN, `เข้าใกล้${what}เร็วเกินไป`, 'ระวังข้างหน้า');
    return;
  }

  // 2. ออกนอกเลน
  const dep = assessDeparture(lane, geo.speedKmh, now);
  if (dep.fire) {
    const side = dep.side === 'left' ? 'ซ้าย' : 'ขวา';
    alerts.fire('ldw', LEVEL.WARN, `รถเบี่ยงออกนอกเลนทาง${side}`, `ออกนอกเลนทาง${side}`);
    return;
  }

  // 3. กล้องมองไม่เห็น — สำคัญเพราะมันบอกว่าสองข้อบนกำลังเชื่อไม่ได้
  if (visionState.level === 2) {
    alerts.fire('vision', LEVEL.WARN,
      visionState.reason || 'กล้องมองถนนไม่ชัด',
      'กล้องมองไม่ชัด ระบบหยุดช่วยเตือนภาพ');
    return;
  }

  // 4. โค้งข้างหน้า
  const cv = assessCurve(roadMatch, geo.speedKmh, now);
  if (cv) {
    alerts.fire('curve', LEVEL.WARN,
      `โค้งข้างหน้า ${cv.distanceM} ม. — ชะลอเหลือราว ${cv.safeKmh}`,
      'โค้งข้างหน้า ชะลอความเร็ว');
    return;
  }

  // 5. เกินความเร็วจำกัด
  const sp = assessSpeed(roadMatch, geo.speedKmh, now);
  if (sp) {
    alerts.fire('speed', LEVEL.INFO,
      `เกินความเร็วจำกัด ${sp.limit} อยู่ ${sp.over}`,
      `เกินความเร็วจำกัด ${sp.limit}`);
  }
}

/* ---------- แสดงผล ---------- */

function baselineBand() {
  if (!running) {
    return { tone: 'idle', text: 'ระบบยังไม่เริ่มทำงาน', sub: 'ติดตั้งโทรศัพท์ให้มั่นคงก่อนออกรถ' };
  }
  if (health.state === STATE.FAILED) {
    return { tone: 'critical', text: 'ระบบไม่พร้อม', sub: health.reason || 'อย่าใช้จอนี้ประกอบการตัดสินใจ' };
  }
  if (health.state === STATE.STARTING) {
    return { tone: 'idle', text: 'กำลังเตรียมระบบ', sub: health.reason || '' };
  }
  if (health.state === STATE.DEGRADED) {
    return { tone: 'warn', text: 'ทำงานแบบจำกัด', sub: health.reason || '' };
  }
  if (visionState.level === 1) {
    return { tone: 'warn', text: 'ทัศนวิสัยลดลง', sub: visionState.reason || '' };
  }
  if (!geo.hasFix) {
    return { tone: 'idle', text: 'กำลังเฝ้าระวัง', sub: 'ยังไม่มีสัญญาณ GPS การเตือนบางอย่างจะไม่ทำงาน' };
  }
  const sub = lane.ok
    ? (lane.notices[0] || 'เห็นเส้นเลนชัด')
    : 'ยังไม่เห็นเส้นเลน';
  return { tone: 'ok', text: 'กำลังเฝ้าระวัง', sub };
}

function render() {
  const active = alerts.active();
  ui.showBand(active, baselineBand());
  ui.showSpeed(geo);
  ui.showLimit(roadMatch);
  ui.showLane(lane);
  ui.setNight(visionState.night);
  ui.setLocked(running && geo.moving && !calibMode);
  ui.showSystem(health.state, health.reason, roads.status);

  if (calibMode) ui.drawCalibGuides();
  else ui.draw(tracks, laneFinder, threat, health.trustworthy);
}

/* ---------- วงจรชีวิต ---------- */

async function start() {
  if (running) return;
  health.start();
  ui.setStartLabel(true);
  render();

  try {
    await camera.open();
    camera.onLost = reason => health.fail(reason);

    await detector.load(msg => { health.reason = msg; ui.showSystem(STATE.STARTING, msg); });

    geo.start();
    health.requestWakeLock();

    running = true;
    lastFrame = 0;
    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    running = false;
    ui.setStartLabel(false);
    health.fail(e.message || 'เริ่มระบบไม่สำเร็จ');
    render();
  }
}

function stop() {
  running = false;
  tracker.reset();
  laneFinder.reset();
  vision.reset();
  alerts.clear();
  tracks = [];
  threat = { level: 0, track: null, ttc: null };
  camera.close();
  geo.stop();
  health.stop();
  ui.setStartLabel(false);
  ui.setLocked(false);
  render();
}

/* ---------- การผูกปุ่ม ---------- */

document.getElementById('startBtn').addEventListener('click', () => {
  if (running) { stop(); return; }
  // ทั้งสองอย่างนี้ต้องเรียกในจังหวะแตะจริง ห้ามมี await คั่นก่อนหน้า
  // ไม่งั้น iOS จะถือว่าหมดสิทธิ์จากการกระทำของผู้ใช้ แล้วเสียงกับเข็มทิศจะเงียบไปเฉยๆ
  alerts.primeFromUserGesture();
  geo.requestOrientationPermission();
  start();
});

document.getElementById('soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  alerts.setEnabled(soundOn);
  ui.setSoundLabel(soundOn, alerts.hasThaiVoice);
});

document.getElementById('calibBtn').addEventListener('click', () => {
  calibMode = true;
  ui.openCalib();
  syncOsmUi();
  render();
});

document.getElementById('calibDone').addEventListener('click', () => {
  calibMode = false;
  ui.closeCalib();
  laneFinder.reset();
  render();
});

document.getElementById('calibReset').addEventListener('click', () => {
  calib.reset();
  laneFinder.reset();
  ui.openCalib();
  render();
});

ui.bindCalib(() => { laneFinder.reset(); render(); });

/* ---------- การตั้งค่าเรื่องข้อมูลถนนและค่าเน็ต ---------- */

const osmToggle = document.getElementById('osmEnabled');
const osmBudget = document.getElementById('osmBudget');

function syncOsmUi() {
  osmToggle.checked = roads.settings.enabled;
  osmBudget.value = roads.settings.budgetMB;
  document.getElementById('osmBudgetVal').textContent = roads.settings.budgetMB;
  document.getElementById('osmUsage').textContent =
    `ใช้ไปแล้วรอบนี้ ${roads.dataUsedMB.toFixed(2)} MB`;
}

osmToggle.addEventListener('change', () => {
  roads.setSettings({ enabled: osmToggle.checked });
  syncOsmUi(); render();
});

osmBudget.addEventListener('input', () => {
  roads.setSettings({ budgetMB: parseInt(osmBudget.value, 10) });
  syncOsmUi();
});

document.getElementById('osmClear').addEventListener('click', async () => {
  await roads.clearCache();
  syncOsmUi(); render();
});

syncOsmUi();

/* ---------- เหตุการณ์ของระบบ ---------- */

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (!running) return;
  health.requestWakeLock();
  // กล้องมักถูกหยุดตอนสลับแอป ตรวจแล้วเปิดใหม่แทนที่จะแสดงภาพค้าง
  if (!camera.ready) {
    try { await camera.reopen(); health.reason = null; }
    catch (e) { health.fail('เปิดกล้องใหม่ไม่สำเร็จหลังสลับแอป'); }
  }
});

window.addEventListener('pagehide', () => { if (running) stop(); });

health.onChange = () => render();
alerts.onShow = () => render();

ui.setStartLabel(false);
ui.setSoundLabel(true, true);
render();

// บอกตัวตรวจการเปิดใช้งานใน index.html ว่าโมดูลหลักทำงานแล้ว
window.__navAssistBooted = true;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { });
}
