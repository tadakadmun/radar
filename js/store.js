/* store.js — ที่เก็บข้อมูลถาวรในเครื่อง
 *
 * ใช้ IndexedDB แทน localStorage เพราะข้อมูลถนนที่สะสมไว้จะเกิน 5 MB
 * ซึ่งเป็นเพดานของ localStorage ในเบราว์เซอร์ส่วนใหญ่
 */

const DB_NAME = 'navassist';
const STORE = 'kv';
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return rej(new Error('ไม่รองรับ IndexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }).catch(e => { dbPromise = null; throw e; });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}

export const get = key => tx('readonly', s => s.get(key)).catch(() => null);
export const set = (key, val) => tx('readwrite', s => s.put(val, key)).catch(() => null);
export const del = key => tx('readwrite', s => s.delete(key)).catch(() => null);
export const keys = () => tx('readonly', s => s.getAllKeys()).catch(() => []);

/** ลบรายการที่เก่ากว่า maxAgeMs โดยดูจากฟิลด์ t ของแต่ละค่า */
export async function prune(prefix, maxAgeMs) {
  try {
    const all = await keys();
    const now = Date.now();
    for (const k of all) {
      if (typeof k !== 'string' || !k.startsWith(prefix)) continue;
      const v = await get(k);
      if (!v || now - (v.t || 0) > maxAgeMs) await del(k);
    }
  } catch { }
}
