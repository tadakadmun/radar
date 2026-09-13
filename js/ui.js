/* ui.js — ทุกอย่างที่คนขับมองเห็น
 *
 * หลักที่ยึดในการออกแบบหน้าจอนี้:
 *  - เหลือบตาครั้งเดียวต้องได้คำตอบ จึงมีข้อความสำคัญได้ครั้งละหนึ่งเรื่องเท่านั้น
 *  - สีใช้บอกระดับอันตราย ไม่ใช้ตกแต่ง และไม่ใช้สีเป็นตัวบอกความหมายเพียงลำพัง
 *  - พอรถวิ่ง ปุ่มทุกปุ่มถูกปิด เพราะข้อความ "ห้ามแตะขณะขับ" ไม่ใช่มาตรการควบคุม
 */

import { CLASS_TH } from './detector.js';
import { STATE } from './health.js';
import * as calib from './calibrate.js';

const $ = id => document.getElementById(id);

export class UI {
  constructor() {
    this.video = $('video');
    this.canvas = $('overlay');
    this.ctx = this.canvas.getContext('2d');
    this.band = $('band');
    this.bandText = $('bandText');
    this.bandSub = $('bandSub');
    this.speedEl = $('speed');
    this.speedUnit = $('speedUnit');
    this.limitEl = $('limit');
    this.laneEl = $('laneMark');
    this.laneNote = $('laneNote');
    this.sysEl = $('sysState');
    this.sysDetail = $('sysDetail');
    this.startBtn = $('startBtn');
    this.soundBtn = $('soundBtn');
    this.calibBtn = $('calibBtn');
    this.controls = $('controls');
    this.calibPanel = $('calibPanel');
    this.lockNote = $('lockNote');
    this.canvasSize = { w: 0, h: 0 };
    this.locked = false;
    this.night = null;
  }

  setNight(on) {
    if (this.night === on) return;
    this.night = on;
    document.body.classList.toggle('night', !!on);
  }

  /** ปิดการโต้ตอบทั้งหมดเมื่อรถกำลังวิ่ง */
  setLocked(locked) {
    if (this.locked === locked) return;
    this.locked = locked;
    this.controls.toggleAttribute('inert', locked);
    this.controls.classList.toggle('locked', locked);
    this.lockNote.hidden = !locked;
  }

  setStartLabel(running) {
    this.startBtn.textContent = running ? 'หยุดระบบ' : 'เริ่มระบบช่วยเตือน';
    this.startBtn.classList.toggle('stop', running);
  }

  setSoundLabel(on, hasThaiVoice) {
    this.soundBtn.textContent = on ? 'เสียงเตือน เปิด' : 'เสียงเตือน ปิด';
    this.soundBtn.classList.toggle('off', !on);
    this.soundBtn.title = hasThaiVoice ? '' : 'เครื่องนี้ไม่มีเสียงพูดภาษาไทย จะใช้เสียงสัญญาณแทน';
  }

  /* ---------- แถบสถานะกลางจอ ---------- */

  showBand(alert, fallback) {
    if (alert) {
      const tone = alert.level === 3 ? 'critical' : alert.level === 2 ? 'warn' : 'info';
      this.band.dataset.tone = tone;
      this.bandText.textContent = alert.text;
      this.bandSub.textContent = alert.sub || '';
      this.band.classList.add('live');
      return;
    }
    this.band.classList.remove('live');
    this.band.dataset.tone = fallback.tone;
    this.bandText.textContent = fallback.text;
    this.bandSub.textContent = fallback.sub || '';
  }

  showSpeed(geo) {
    if (!geo.hasFix) {
      this.speedEl.textContent = '––';
      this.speedUnit.textContent = geo.error || 'รอสัญญาณ';
      return;
    }
    this.speedEl.textContent = String(Math.round(geo.speedKmh));
    this.speedUnit.textContent = geo.speedSource === 'derived' ? 'กม./ชม. (ประมาณ)' : 'กม./ชม.';
  }

  showLimit(match) {
    if (match?.maxspeed) {
      this.limitEl.textContent = String(match.maxspeed);
      this.limitEl.classList.remove('none');
    } else {
      this.limitEl.textContent = '–';
      this.limitEl.classList.add('none');
    }
  }

  showLane(lane) {
    if (!lane.ok) {
      this.laneEl.dataset.state = 'none';
      this.laneEl.style.setProperty('--pos', '50%');
      this.laneNote.textContent = 'ยังไม่เห็นเส้นเลนชัดพอ';
      return;
    }
    const pos = 50 + (lane.offset * 42);
    this.laneEl.style.setProperty('--pos', `${Math.max(4, Math.min(96, pos))}%`);
    this.laneEl.dataset.state = Math.abs(lane.offset) > 0.72 ? 'edge' : 'center';
    this.laneNote.textContent = lane.notices.length
      ? lane.notices[0]
      : lane.curve === 'left' ? 'ทางโค้งซ้าย'
        : lane.curve === 'right' ? 'ทางโค้งขวา' : 'อยู่กลางเลน';
  }

  showSystem(state, reason, extra) {
    const label = {
      [STATE.OFF]: 'ปิดอยู่',
      [STATE.STARTING]: 'กำลังเตรียม',
      [STATE.READY]: 'พร้อมทำงาน',
      [STATE.DEGRADED]: 'คุณภาพลดลง',
      [STATE.FAILED]: 'ไม่พร้อม',
    }[state] || state;
    this.sysEl.textContent = label;
    this.sysEl.dataset.state = state;
    this.sysDetail.textContent = reason || extra || '';
  }

  /* ---------- ภาพซ้อนบนวิดีโอ ---------- */

  #resize() {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (!w || !h) return false;
    if (this.canvasSize.w !== w || this.canvasSize.h !== h) {
      // เปลี่ยนขนาด canvas เฉพาะตอนจำเป็น เพราะการเซ็ต width รีเซ็ตบัฟเฟอร์ทั้งหมด
      this.canvas.width = w; this.canvas.height = h;
      this.canvasSize = { w, h };
    }
    return true;
  }

  draw(tracks, laneFinder, threat, trustworthy) {
    if (!this.#resize()) return;
    const { w, h } = this.canvasSize;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    if (!trustworthy) {
      ctx.fillStyle = 'rgba(8,10,12,.55)';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    // ช่องทางเดินรถของเรา วาดจางๆ ให้ผู้ใช้รู้ว่าระบบกำลังเฝ้าตรงไหน
    // เป็นรูปสามเหลี่ยมที่ยอดชนเส้นขอบฟ้า ตามเรขาคณิตของการฉายภาพ
    const c = calib.egoCorridor(w, h);
    ctx.beginPath();
    ctx.moveTo(c.topL, c.topY); ctx.lineTo(c.topR, c.topY);
    ctx.lineTo(c.botR, c.botY); ctx.lineTo(c.botL, c.botY);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(160,180,195,.30)';
    ctx.lineWidth = Math.max(1, w / 480);
    ctx.stroke();

    laneFinder?.drawOverlay(ctx, w, h);

    const fs = Math.max(13, w / 34);
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
    ctx.textBaseline = 'alphabetic';

    for (const tr of tracks) {
      // วาดเฉพาะสิ่งที่เกี่ยวกับความปลอดภัย ไม่วาดทุกอย่างที่กล้องเห็น
      const relevant = tr.inPath || (tr.ttc != null && tr.ttc < 5);
      if (!relevant) continue;

      const isThreat = threat.track && tr.id === threat.track.id;
      const color = isThreat && threat.level === 2 ? '#e5484d'
        : isThreat ? '#e8b33a'
          : 'rgba(150,170,185,.75)';
      const [x, y, bw, bh] = tr.bbox;

      ctx.strokeStyle = color;
      ctx.lineWidth = isThreat ? Math.max(3, w / 160) : Math.max(1.5, w / 400);
      ctx.strokeRect(x, y, bw, bh);

      if (!isThreat) continue;
      const bits = [CLASS_TH[tr.cls] || tr.cls];
      if (tr.ttc != null) bits.push(`${tr.ttc.toFixed(1)} วิ`);
      else if (tr.distanceM) bits.push(`${Math.round(tr.distanceM)} ม.`);
      const label = bits.join('  ');
      const tw = ctx.measureText(label).width + 14;
      const ly = Math.max(fs + 6, y - 6);
      ctx.fillStyle = color;
      ctx.fillRect(x, ly - fs - 5, tw, fs + 10);
      ctx.fillStyle = '#0b0e11';
      ctx.fillText(label, x + 7, ly);
    }
  }

  /* ---------- หน้าปรับตั้งกล้อง ---------- */

  openCalib() { this.calibPanel.hidden = false; this.#syncCalib(); }
  closeCalib() { this.calibPanel.hidden = true; }

  #syncCalib() {
    const c = calib.get();
    for (const k of ['horizonY', 'bottomLeft', 'bottomRight', 'topLeft', 'topRight', 'egoX', 'laneWidthM']) {
      const el = $('cal_' + k);
      if (el) { el.value = c[k]; const o = $('calv_' + k); if (o) o.textContent = (+c[k]).toFixed(3); }
    }
  }

  bindCalib(onChange) {
    this.calibPanel.addEventListener('input', e => {
      const id = e.target.id;
      if (!id?.startsWith('cal_')) return;
      const key = id.slice(4);
      const val = parseFloat(e.target.value);
      calib.set({ [key]: val, verified: true });
      const o = $('calv_' + key);
      if (o) o.textContent = val.toFixed(3);
      onChange?.();
    });
  }

  /** เส้นบอกแนวสำหรับหน้าปรับตั้ง วาดทับวิดีโอเพื่อให้เล็งกับถนนจริง */
  drawCalibGuides() {
    if (!this.#resize()) return;
    const { w, h } = this.canvasSize;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const c = calib.get();
    const q = calib.roadQuad(w, h);

    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(230,235,240,.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, c.horizonY * h); ctx.lineTo(w, c.horizonY * h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#7fc4e8';
    ctx.lineWidth = Math.max(2, w / 300);
    ctx.beginPath();
    ctx.moveTo(q[3][0], q[3][1]); ctx.lineTo(q[0][0], q[0][1]);
    ctx.moveTo(q[2][0], q[2][1]); ctx.lineTo(q[1][0], q[1][1]);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(232,179,58,.9)';
    ctx.beginPath();
    ctx.moveTo(c.egoX * w, h * 0.72); ctx.lineTo(c.egoX * w, h);
    ctx.stroke();
  }
}
