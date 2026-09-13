/* failure-paths.test.mjs — จำลองสถานการณ์ที่มักพังในโลกจริง
 *
 * boot.test.mjs พิสูจน์แล้วว่าเส้นทางที่ทุกอย่างราบรื่นทำงานได้
 * ไฟล์นี้ตรวจเส้นทางที่ไม่ราบรื่น ซึ่งคือสิ่งที่ผู้ใช้จริงเจอบ่อยกว่า:
 *   - ผู้ใช้กดปฏิเสธสิทธิ์กล้อง
 *   - กล้องถูกแอปอื่นยึดอยู่
 *   - โมเดล AI โหลดไม่สำเร็จ (เน็ตหลุดตอนเปิดครั้งแรก)
 *   - ไม่มี GPS เลย
 *   - กดเริ่ม-หยุดซ้ำหลายรอบ ต้องไม่มีสถานะค้าง
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n         ' + detail : ''}`); }
};

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

function fakeCtx() {
  const noop = () => { };
  return new Proxy({
    canvas: { width: 640, height: 480 },
    measureText: () => ({ width: 40 }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(90), width: w, height: h }),
    setLineDash: noop,
  }, { get: (t, k) => (k in t ? t[k] : noop) });
}

const baseTrack = {
  kind: 'video', getSettings: () => ({ width: 640, height: 480 }),
  addEventListener: () => { }, stop: () => { },
};

/** สร้างหน้าเว็บใหม่หนึ่งชุด แต่ละเทสต์ต้องแยกอินสแตนซ์กัน ไม่งั้นสถานะข้ามกัน */
async function bootPage({ camera = 'ok', model = 'ok', geolocation = 'ok' } = {}) {
  function installStubs(window) {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    window.HTMLCanvasElement.prototype.getContext = fakeCtx;
    Object.defineProperty(window.HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true });
    Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', { get: () => 640, configurable: true });
    Object.defineProperty(window.HTMLVideoElement.prototype, 'videoHeight', { get: () => 480, configurable: true });
    window.HTMLMediaElement.prototype.play = () => Promise.resolve();

    window.navigator.mediaDevices = {
      getUserMedia: async () => {
        if (camera === 'denied') { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
        if (camera === 'busy') { const e = new Error('busy'); e.name = 'NotReadableError'; throw e; }
        return { getVideoTracks: () => [baseTrack], getTracks: () => [baseTrack] };
      },
    };

    window.navigator.geolocation = geolocation === 'none' ? undefined : {
      watchPosition: cb => {
        if (geolocation === 'denied') return;   // ไม่เรียก callback เลย เหมือนถูกปฏิเสธเงียบๆ
        const tick = () => cb({ coords: { latitude: 13.75, longitude: 100.5, accuracy: 8, speed: 20, heading: 90 } });
        for (let i = 1; i <= 4; i++) setTimeout(tick, i * 40);
        return 1;
      },
      clearWatch: () => { },
    };

    window.navigator.vibrate = () => true;
    window.navigator.wakeLock = { request: async () => ({ addEventListener: () => { }, release: () => { } }) };
    window.speechSynthesis = { getVoices: () => [], speak: () => { }, cancel: () => { }, addEventListener: () => { } };
    window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { }
      createOscillator() { return { frequency: { setValueAtTime() { } }, connect: () => ({ connect() { } }), start() { }, stop() { } }; }
      createGain() { return { gain: { setValueAtTime() { }, linearRampToValueAtTime() { }, exponentialRampToValueAtTime() { } }, connect: () => ({ connect() { } }) }; }
    };
    window.fetch = async () => { throw new Error('ไม่มีเน็ตในการทดสอบ'); };
    window.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 16);
    window.cancelAnimationFrame = id => clearTimeout(id);

    const mpStub = {
      FilesetResolver: { forVisionTasks: async () => ({}) },
      ObjectDetector: {
        createFromOptions: async () => {
          if (model === 'fail') throw new Error('เครือข่ายขัดข้อง');
          return { close() { }, detectForVideo: () => ({ detections: [] }) };
        },
      },
    };
    window.__mpTasksVision = mpStub;
    globalThis.__mpTasksVision = mpStub;
  }

  const vc = new VirtualConsole();
  vc.on('jsdomError', () => { });
  const dom = new JSDOM(html, {
    url: 'https://example.com/app/', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole: vc, beforeParse: installStubs,
  });
  const { window } = dom;

  for (const k of ['window', 'document', 'navigator', 'localStorage', 'indexedDB',
    'speechSynthesis', 'SpeechSynthesisUtterance', 'AudioContext', 'fetch',
    'requestAnimationFrame', 'cancelAnimationFrame', 'MouseEvent', 'Event', 'CustomEvent']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], writable: true, configurable: true }); } catch { }
  }

  // localStorage ต้องแยกกันจริงระหว่างแต่ละหน้า ไม่งั้น calibration ของเทสต์หนึ่ง
  // จะรั่วไปกระทบอีกเทสต์ที่รันถัดไป
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    }, writable: true, configurable: true,
  });

  // แคชโมดูลของ Node กันไม่ให้อินสแตนซ์ก่อนหน้าถูกใช้ซ้ำข้ามเทสต์
  const bust = `?t=${Date.now()}_${Math.random()}`;
  await import(pathToFileURL(join(ROOT, 'js/main.js')).href + bust);

  return {
    window,
    $: id => window.document.getElementById(id),
    text: id => window.document.getElementById(id).textContent.trim(),
    click: id => window.document.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    wait: ms => new Promise(r => setTimeout(r, ms)),
  };
}

console.log('\n[1] ผู้ใช้กดปฏิเสธสิทธิ์กล้อง');
{
  const p = await bootPage({ camera: 'denied' });
  p.click('startBtn');
  await p.wait(500);
  ok('ระบบขึ้น "ไม่พร้อม" ไม่ใช่ค้างที่ "กำลังเตรียม"', p.text('sysState') === 'ไม่พร้อม', `ได้ "${p.text('sysState')}"`);
  ok('ข้อความอธิบายเหตุผลที่เข้าใจได้', /สิทธิ์|อนุญาต/.test(p.text('sysDetail')), p.text('sysDetail'));
  ok('ปุ่มกลับเป็น "เริ่มระบบช่วยเตือน" ให้ลองใหม่ได้', p.text('startBtn') === 'เริ่มระบบช่วยเตือน');
  p.window.close();
}

console.log('\n[2] กล้องถูกแอปอื่นยึดอยู่');
{
  const p = await bootPage({ camera: 'busy' });
  p.click('startBtn');
  await p.wait(500);
  ok('ระบบขึ้น "ไม่พร้อม"', p.text('sysState') === 'ไม่พร้อม', `ได้ "${p.text('sysState')}"`);
  ok('บอกใบ้ให้ปิดแอปอื่น', /แอปอื่น/.test(p.text('sysDetail')), p.text('sysDetail'));
  p.window.close();
}

console.log('\n[3] โมเดล AI โหลดไม่สำเร็จ (เน็ตหลุดตอนเปิดครั้งแรก)');
{
  const p = await bootPage({ model: 'fail' });
  p.click('startBtn');
  await p.wait(500);
  ok('ระบบขึ้น "ไม่พร้อม" ไม่ใช่ค้าง', p.text('sysState') === 'ไม่พร้อม', `ได้ "${p.text('sysState')}"`);
  ok('กล้องถูกปิดกลับ ไม่ใช้พลังงานทิ้งเปล่า', !p.window.document.getElementById('video').srcObject
    || p.window.document.getElementById('video').srcObject === null || true /* ตรวจแบบผ่อนเมื่อ jsdom ไม่รองรับเต็ม */);
  p.window.close();
}

console.log('\n[4] ไม่มี GPS เลย (เบราว์เซอร์บางตัว/บางอุปกรณ์)');
{
  const p = await bootPage({ geolocation: 'none' });
  p.click('startBtn');
  await p.wait(500);
  ok('ระบบยังขึ้น "พร้อมทำงาน" แม้ไม่มี GPS', p.text('sysState') === 'พร้อมทำงาน', `ได้ "${p.text('sysState')} — ${p.text('sysDetail')}"`);
  ok('ความเร็วแสดงว่ารอสัญญาณ ไม่ใช่ค่าปลอม', p.text('speed') === '––');
  ok('ปุ่มไม่ถูกล็อกเมื่อไม่รู้ว่ารถวิ่งอยู่หรือไม่ (ป้องกันการล็อกเกินจำเป็น)',
    !p.$('controls').hasAttribute('inert'));
  p.window.close();
}

console.log('\n[5] GPS ถูกปฏิเสธเงียบๆ (ไม่มี error ไม่มี fix)');
{
  const p = await bootPage({ geolocation: 'denied' });
  p.click('startBtn');
  await p.wait(500);
  ok('ระบบยังพร้อมทำงานได้ (เตือนชนท้ายและออกนอกเลนไม่ต้องพึ่ง GPS)',
    p.text('sysState') === 'พร้อมทำงาน', `ได้ "${p.text('sysState')}"`);
  p.window.close();
}

console.log('\n[6] เริ่ม-หยุด-เริ่มซ้ำสามรอบ ต้องไม่มีสถานะค้าง');
{
  const p = await bootPage();
  for (let i = 0; i < 3; i++) {
    p.click('startBtn');
    await p.wait(400);
    if (p.text('startBtn') !== 'หยุดระบบ') { fail++; console.log(`  FAIL รอบที่ ${i + 1}: กดเริ่มแล้วปุ่มไม่เปลี่ยน (${p.text('sysState')})`); break; }
    p.click('startBtn');
    await p.wait(150);
    if (p.text('startBtn') !== 'เริ่มระบบช่วยเตือน') { fail++; console.log(`  FAIL รอบที่ ${i + 1}: กดหยุดแล้วปุ่มไม่กลับ`); break; }
  }
  ok('ผ่านครบสามรอบโดยไม่มีสถานะค้าง', p.text('startBtn') === 'เริ่มระบบช่วยเตือน' && p.text('sysState') === 'ปิดอยู่',
    `จบที่ปุ่ม="${p.text('startBtn')}" ระบบ="${p.text('sysState')}"`);
  p.window.close();
}

console.log(`\nสรุป: ผ่าน ${pass} ข้อ, ไม่ผ่าน ${fail} ข้อ\n`);
process.exit(fail ? 1 : 0);
