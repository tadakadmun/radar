/* sw.js — ทำให้แอปเปิดได้แม้ไม่มีสัญญาณ
 *
 * ถ้าปล่อยให้ไลบรารีและโมเดลพึ่ง HTTP cache ของเบราว์เซอร์เฉยๆ มันจะถูกล้าง
 * เมื่อไหร่ก็ได้ ผลคือขับเข้าที่ไม่มีสัญญาณแล้วแอปเปิดไม่ขึ้นตอนที่ต้องการมันที่สุด
 * จึงเก็บทั้งไลบรารีตรวจจับและไฟล์โมเดลไว้ในแคชของ Service Worker
 *
 * ไลบรารีและโมเดลใช้วิธี "เอาจากแคชก่อน" เพราะตรึงเวอร์ชันไว้แล้วไม่มีวันเปลี่ยน
 * ส่วนไฟล์ของแอปเองใช้ "เอาของใหม่ก่อน" เพื่อให้การแก้ไขถึงผู้ใช้ได้เร็ว
 */

const CACHE = 'navassist-v3';

const SHELL = [
  './', './index.html', './style.css', './manifest.json',
  './js/main.js', './js/ui.js', './js/camera.js', './js/detector.js',
  './js/tracker.js', './js/lane.js', './js/vision.js', './js/alerts.js',
  './js/geo.js', './js/osm.js', './js/store.js', './js/health.js',
  './js/calibrate.js', './js/util.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

// ไลบรารีตรวจจับ (MediaPipe Tasks Vision) และไฟล์โมเดล
// ตัวไลบรารีโหลดไฟล์ wasm หลายไฟล์ที่ชื่อเดาล่วงหน้าไม่ได้แน่นอน
// จึงเก็บแบบพบตอนไหนเก็บตอนนั้น แทนการระบุรายชื่อไว้ตายตัว
const LIB_PREFIX = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@';
const MODEL_PREFIX = 'https://storage.googleapis.com/mediapipe-models/';

const isLibOrModel = url =>
  url.startsWith(LIB_PREFIX) || url.startsWith(MODEL_PREFIX);

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // ไม่ใช้ addAll เพราะถ้าไฟล์เดียวหาย การติดตั้งจะล้มทั้งชุด
    // แล้วแอปจะใช้ออฟไลน์ไม่ได้เลยโดยไม่มีอะไรบอก
    const results = await Promise.allSettled(SHELL.map(u => c.add(u)));
    const missing = SHELL.filter((_, i) => results[i].status === 'rejected');
    if (missing.length) console.warn('แคชไฟล์เหล่านี้ไม่ได้:', missing);
    // ไม่ดึงไลบรารีกับโมเดลมาตอนติดตั้ง เพราะรวมกันหลายเมกะไบต์
    // และผู้ใช้อาจยังไม่กดเริ่มระบบเลยด้วยซ้ำ ปล่อยให้เก็บตอนใช้งานจริงครั้งแรก
  })());
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks =>
    Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ข้อมูลถนนต้องสดเสมอ ไม่แคช
  if (url.hostname.includes('overpass')) return;

  const isShell = url.origin === self.location.origin;
  const isCdn = isLibOrModel(req.url);
  if (!isShell && !isCdn) return;

  if (isCdn) {
    // ไลบรารีและโมเดลตรึงเวอร์ชันไว้แล้ว จึงใช้ของในแคชก่อนเพื่อความเร็วและความแน่นอน
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
    return;
  }

  // ไฟล์แอป: เอาของใหม่ก่อน เพื่อให้การแก้ไขถึงผู้ใช้เร็ว แล้วค่อยตกไปที่แคช
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then(hit => {
      if (hit) return hit;
      // ตกกลับไปที่หน้าแรกได้เฉพาะการเปิดหน้าเว็บเท่านั้น
      // ถ้าส่ง HTML ไปแทนไฟล์ .js เบราว์เซอร์จะปฏิเสธเพราะชนิดไฟล์ไม่ตรง
      // แล้วจะได้ข้อความผิดพลาดที่ชี้ไปผิดทางโดยสิ้นเชิง
      if (req.mode === 'navigate') return caches.match('./index.html');
      return new Response('ไม่มีไฟล์นี้ในแคชและออฟไลน์อยู่', { status: 504 });
    }))
  );
});
