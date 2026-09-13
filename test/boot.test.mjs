/* boot.test.mjs — โหลดหน้าเว็บจริงในสภาพแวดล้อมจำลอง แล้วกดปุ่มเหมือนผู้ใช้
 *
 * ชุดทดสอบคณิตศาสตร์พิสูจน์ได้แค่ว่าสูตรถูก ไม่ได้พิสูจน์ว่าเปิดหน้าเว็บแล้วทำงานหรือไม่
 * ไฟล์นี้จับอาการ "เปิดแล้วไม่ทำงาน" ซึ่งเป็นอาการที่หาสาเหตุยากที่สุดสำหรับผู้ใช้
 * โหลด js/main.js ตรงๆ ในรูปแบบ ES module เดียวกับที่ index.html ใช้จริง
 * ไม่ผ่านการรวมไฟล์หรือแปลงรูปแบบใดๆ ทั้งสิ้น
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const note = m => errors.push(m);

/* ---------- ของปลอมแทน API ที่ jsdom ไม่มี ---------- */

function fakeCtx() {
  const noop = () => { };
  return new Proxy({
    canvas: { width: 640, height: 480 },
    measureText: () => ({ width: 40 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(90), width: w, height: h }),
    setLineDash: noop,
  }, { get: (t, k) => (k in t ? t[k] : noop) });
}

let detectCount = 0;

/* ของปลอมแทน MediaPipe Tasks Vision
   detector.js ออกแบบให้มองหา globalThis.__mpTasksVision ก่อนเสมอ
   ชุดทดสอบจึงไม่ต้องต่อเน็ตไปโหลดไลบรารีจริง */
const mpStub = {
  FilesetResolver: { forVisionTasks: async () => ({}) },
  ObjectDetector: {
    createFromOptions: async () => ({
      close() { },
      detectForVideo: () => {
        // รถคันหนึ่งที่โตขึ้นเรื่อยๆ = กำลังเข้าใกล้ ใช้พิสูจน์ว่าลูปตรวจจับเดินจริง
        detectCount++;
        const w = 60 + detectCount * 6;
        return {
          detections: [{
            categories: [{ categoryName: 'car', score: 0.85 }],
            boundingBox: { originX: 320 - w / 2, originY: 300 - w * 0.8, width: w, height: w * 0.8 },
          }],
        };
      },
    }),
  },
};

const track = {
  kind: 'video',
  getSettings: () => ({ width: 640, height: 480 }),
  addEventListener: () => { },
  stop: () => { },
};

function installStubs(window) {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  window.HTMLCanvasElement.prototype.getContext = fakeCtx;

  Object.defineProperty(window.HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true });
  Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', { get: () => 640, configurable: true });
  Object.defineProperty(window.HTMLVideoElement.prototype, 'videoHeight', { get: () => 480, configurable: true });
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();

  window.navigator.mediaDevices = {
    getUserMedia: async () => ({ getVideoTracks: () => [track], getTracks: () => [track] }),
  };
  window.navigator.geolocation = {
    watchPosition: cb => {
      const tick = () => cb({
        coords: { latitude: 13.75, longitude: 100.5, accuracy: 8, speed: 25, heading: 90 },
      });
      for (let i = 1; i <= 6; i++) setTimeout(tick, i * 40);
      return 1;
    },
    clearWatch: () => { },
  };
  window.navigator.vibrate = () => true;
  window.navigator.wakeLock = { request: async () => ({ addEventListener: () => { }, release: () => { } }) };

  window.speechSynthesis = {
    getVoices: () => [{ lang: 'th-TH', name: 'Thai' }],
    speak: () => { }, cancel: () => { }, addEventListener: () => { },
  };
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { }
    createOscillator() {
      return { frequency: { setValueAtTime() { } }, connect: () => ({ connect() { } }), start() { }, stop() { } };
    }
    createGain() {
      return {
        gain: { setValueAtTime() { }, linearRampToValueAtTime() { }, exponentialRampToValueAtTime() { } },
        connect: () => ({ connect() { } }),
      };
    }
  };

  window.fetch = async () => { throw new Error('ไม่มีเน็ตในการทดสอบ'); };
  window.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 16);
  window.cancelAnimationFrame = id => clearTimeout(id);

  window.__mpTasksVision = mpStub;
  globalThis.__mpTasksVision = mpStub;
}

/* ---------- เปิดหน้าเว็บ ---------- */

const vc = new VirtualConsole();
vc.on('jsdomError', e => note(`jsdomError: ${e.message}`));

// ไลบรารีตรวจจับถูกโหลดแบบ dynamic import ภายใน detector.js อยู่แล้ว
// และถูกแทนที่ด้วยของปลอมผ่าน globalThis.__mpTasksVision จึงไม่ต้องแก้ HTML
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'https://example.com/app/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse: installStubs,
});

const { window } = dom;
const $ = id => window.document.getElementById(id);
const text = id => ($(id) ? $(id).textContent.trim() : '(ไม่มีอีลิเมนต์ ' + id + ')');

for (const k of ['window', 'document', 'navigator', 'localStorage', 'indexedDB',
  'speechSynthesis', 'SpeechSynthesisUtterance', 'AudioContext', 'fetch',
  'requestAnimationFrame', 'cancelAnimationFrame', 'MouseEvent', 'Event', 'CustomEvent']) {
  try { Object.defineProperty(globalThis, k, { value: window[k], writable: true, configurable: true }); }
  catch { /* บางตัวแก้ไม่ได้ */ }
}

const click = id => $(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n[1] โหลดโมดูลหลัก (js/main.js ตรงๆ แบบเดียวกับที่ index.html ใช้จริง)');
try {
  await import(pathToFileURL(join(ROOT, 'js/main.js')).href);
  console.log('  ok   นำเข้า main.js สำเร็จ');
} catch (e) {
  note(`นำเข้า main.js ล้มเหลว: ${e.message}\n${e.stack}`);
}

if (!window.__navAssistBooted) note('main.js ไม่ได้ตั้งค่า __navAssistBooted — ตัวตรวจในหน้าเว็บจะแจ้งเตือนผิด');

console.log('\n[2] สภาพหน้าจอตอนเปิด');
console.log('  แถบสถานะ:', text('bandText'));
console.log('  ระบบ    :', text('sysState'));
if (!$('bootError').hidden) note('กล่องแจ้งปัญหาการเปิดใช้งานไม่ควรแสดงเมื่อทุกอย่างปกติ');
if (text('startBtn') !== 'เริ่มระบบช่วยเตือน') note('ข้อความปุ่มเริ่มไม่ถูกต้อง');

console.log('\n[3] กดปุ่มเริ่มระบบ');
try {
  click('startBtn');
  await wait(1200);
  console.log('  ระบบ    :', text('sysState'), '—', text('sysDetail'));
  console.log('  ความเร็ว :', text('speed'), text('speedUnit'));
  console.log('  แถบสถานะ:', text('bandText'));
  console.log('  ปุ่ม     :', text('startBtn'));

  if (text('sysState') !== 'พร้อมทำงาน') {
    note(`หลังกดเริ่ม ระบบควรขึ้น "พร้อมทำงาน" แต่ได้ "${text('sysState')}" (${text('sysDetail')})`);
  }
  if (text('speed') === '––') note('ไม่ได้รับความเร็วจาก GPS');
  if (text('startBtn') !== 'หยุดระบบ') note('ปุ่มไม่เปลี่ยนเป็น "หยุดระบบ"');
  if (detectCount < 3) note(`ลูปตรวจจับไม่เดิน (เรียก detect ไปแค่ ${detectCount} ครั้ง)`);
} catch (e) {
  note(`กดปุ่มเริ่มแล้วพัง: ${e.message}\n${e.stack}`);
}

console.log('\n[4] ปุ่มถูกล็อกเมื่อรถวิ่ง');
if (!$('controls').hasAttribute('inert')) note('รถวิ่ง 90 กม./ชม. แล้วปุ่มยังไม่ถูกล็อก');
else console.log('  ok   ปุ่มถูกปิดการใช้งานตามความเร็ว');

console.log('\n[5] หน้าตั้งค่าและปุ่มเสียง');
try {
  click('calibBtn');
  await wait(150);
  if ($('calibPanel').hidden) note('เปิดหน้าตั้งค่าไม่ขึ้น');
  else console.log('  ok   หน้าตั้งค่าเปิดได้ —', text('osmUsage'));

  $('osmEnabled').checked = false;
  $('osmEnabled').dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(80);
  console.log('  ok   ปิดการใช้ข้อมูลถนนได้ —', text('sysDetail'));

  click('calibDone');
  await wait(80);
  if (!$('calibPanel').hidden) note('ปิดหน้าตั้งค่าไม่ได้');

  click('soundBtn');
  await wait(50);
  if (text('soundBtn') !== 'เสียงเตือน ปิด') note('ปุ่มเสียงไม่สลับสถานะ');
  else console.log('  ok   ปุ่มเสียงสลับได้');
} catch (e) {
  note(`หน้าตั้งค่าพัง: ${e.message}\n${e.stack}`);
}

console.log('\n[6] กดหยุดระบบ');
try {
  click('startBtn');
  await wait(200);
  if (text('startBtn') !== 'เริ่มระบบช่วยเตือน') note('กดหยุดแล้วปุ่มไม่กลับสถานะเดิม');
  else console.log('  ok   หยุดแล้วกลับสู่สถานะเริ่มต้น');
} catch (e) {
  note(`กดหยุดแล้วพัง: ${e.message}\n${e.stack}`);
}

await wait(200);
window.close();

console.log('\n' + '='.repeat(58));
if (errors.length) {
  console.log(`พบข้อผิดพลาด ${errors.length} รายการ\n`);
  errors.forEach((e, i) => console.log(`[${i + 1}] ${e}\n`));
} else {
  console.log('หน้าเว็บโหลดขึ้น ปุ่มทุกปุ่มทำงาน และลูปตรวจจับเดินปกติ');
}
process.exit(errors.length ? 1 : 0);
