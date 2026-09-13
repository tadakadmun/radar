/* camera.js — เปิดกล้องหลัง จัดการการหลุด และรายงานสถานะ
 *
 * ขอความละเอียดต่ำโดยตั้งใจ: โมเดลตรวจจับย่อภาพเหลือ 300×300 อยู่แล้ว
 * การขอ 1280×720 มีแต่ทำให้เครื่องร้อนและเฟรมตก โดยไม่ได้ความแม่นเพิ่ม
 */

const PROFILES = [
  { width: { ideal: 640 }, height: { ideal: 480 } },
  { width: { ideal: 480 }, height: { ideal: 360 } },
  {},
];

export class Camera {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.track = null;
    this.onLost = null;        // callback เมื่อกล้องถูกยึดหรือหลุด
    this.lost = false;
  }

  get ready() {
    return !!this.stream && this.video.readyState >= 2 &&
      this.video.videoWidth > 0 && !this.lost;
  }

  async open() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('เบราว์เซอร์นี้เปิดกล้องไม่ได้ หรือหน้าเว็บไม่ได้เปิดผ่าน HTTPS');
    }
    let lastErr = null;
    for (const p of PROFILES) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, frameRate: { ideal: 30 }, ...p },
          audio: false,
        });
        break;
      } catch (e) { lastErr = e; }
    }
    if (!this.stream) {
      throw new Error(lastErr?.name === 'NotAllowedError'
        ? 'ยังไม่ได้อนุญาตให้ใช้กล้อง เปิดสิทธิ์กล้องในเบราว์เซอร์แล้วลองอีกครั้ง'
        : 'เปิดกล้องไม่สำเร็จ ตรวจว่าไม่มีแอปอื่นใช้กล้องอยู่');
    }

    this.track = this.stream.getVideoTracks()[0];
    this.lost = false;
    this.track.addEventListener('ended', () => this.#markLost('กล้องถูกปิดหรือถูกแอปอื่นยึดไป'));
    this.track.addEventListener('mute', () => this.#markLost('สัญญาณภาพจากกล้องหยุด'));
    this.track.addEventListener('unmute', () => { this.lost = false; });

    this.video.srcObject = this.stream;

    // เดิมรอเหตุการณ์ loadedmetadata เพียงอย่างเดียว ซึ่งเป็นการแข่งกันเวลา:
    // ถ้าวิดีโอมีข้อมูลพร้อมอยู่แล้วก่อนเราผูกตัวรับเหตุการณ์ (เกิดบ่อยบนเครื่องเร็ว
    // และเวลาเปิดกล้องใหม่หลังสลับแอป) เหตุการณ์นั้นจะไม่เกิดขึ้นอีกเลย
    // แล้วระบบจะค้างอยู่ที่ "กำลังเตรียม" จนหมดเวลา
    // จึงต้องเช็คสถานะปัจจุบันก่อน แล้วค่อยรอ พร้อมมีการวนตรวจเป็นตาข่ายรองรับ
    await this.#waitForFrames();
    await this.video.play();
    return this.settings();
  }

  #waitForFrames(timeoutMs = 8000) {
    const ready = () => this.video.readyState >= 1 && this.video.videoWidth > 0;
    if (ready()) return Promise.resolve();

    return new Promise((res, rej) => {
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        this.video.removeEventListener('loadedmetadata', onMeta);
        this.video.removeEventListener('canplay', onMeta);
        ok ? res() : rej(new Error('กล้องไม่ส่งภาพภายในเวลาที่กำหนด ลองปิดแอปอื่นที่ใช้กล้องอยู่'));
      };
      const onMeta = () => { if (ready()) finish(true); };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const poll = setInterval(onMeta, 100);
      this.video.addEventListener('loadedmetadata', onMeta);
      this.video.addEventListener('canplay', onMeta);
      onMeta();
    });
  }

  #markLost(reason) {
    this.lost = true;
    this.onLost?.(reason);
  }

  settings() {
    try { return this.track?.getSettings?.() || {}; } catch { return {}; }
  }

  /** มุมรับภาพแนวนอนถ้าอุปกรณ์บอกมา ไม่งั้นคืน null แล้วให้ calibrate เดาเอง */
  fovDeg() {
    const s = this.settings();
    if (s.aspectRatio && s.focalLength && s.width) {
      const f = s.focalLength;
      return 2 * Math.atan((s.width / 2) / f) * 180 / Math.PI;
    }
    return null;
  }

  /** ปิดไฟฉาย/รีสตาร์ทกล้องหลังหลุด */
  async reopen() {
    this.close();
    return this.open();
  }

  close() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }
}
