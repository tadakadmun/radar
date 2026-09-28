/* Resolve writes only after commit. Failure is visible to callers. */
const DB_NAME='navassist',STORE='kv';let dbPromise=null;
function open(){
  if(dbPromise)return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB){reject(new Error('เครื่องนี้เก็บข้อมูลถนนไม่ได้'));return;}
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))req.result.createObjectStore(STORE);};
    req.onsuccess=()=>{const db=req.result;db.onversionchange=()=>{db.close();dbPromise=null;};resolve(db);};
    req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('ปิดหน้าแอปอื่นก่อนจัดเก็บข้อมูล'));
  }).catch(e=>{dbPromise=null;throw e;});return dbPromise;
}
async function tx(mode,fn){const db=await open();return new Promise((resolve,reject)=>{
  const t=db.transaction(STORE,mode);let result;const req=fn(t.objectStore(STORE));
  req.onsuccess=()=>{result=req.result;};req.onerror=()=>reject(req.error);
  t.oncomplete=()=>resolve(result);t.onabort=t.onerror=()=>reject(t.error||new Error('บันทึกไม่สำเร็จ'));
});}
export const get=key=>tx('readonly',s=>s.get(key));
export const set=(key,value)=>tx('readwrite',s=>s.put(value,key));
export const del=key=>tx('readwrite',s=>s.delete(key));
export const keys=()=>tx('readonly',s=>s.getAllKeys());
export async function prune(prefix,maxAgeMs){for(const k of await keys()){if(typeof k!=='string'||!k.startsWith(prefix))continue;const v=await get(k);if(!v||Date.now()-(v.t||0)>maxAgeMs)await del(k);}}
