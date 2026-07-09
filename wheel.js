/* =====================================================================
 * 판교 술상 돌림판 — 물리 시뮬레이션 + 렌더러
 *
 * 물리 모델
 *  - 휠: 1자유도 회전체. 쿨롱 마찰 + 점성 감쇠 + 2차 공기저항.
 *  - 핀(flapper): 위쪽에 힌지로 매달린 스프링-댐퍼 진자.
 *    조각 경계마다 박힌 peg가 핀을 밀어 올렸다가 놓아주며 "다다다닥" 소리를 낸다.
 *  - peg와 핀이 접촉하는 동안 핀의 스프링 토크가 휠에 반작용으로 걸린다.
 *    → 회전이 느려지면 peg를 넘지 못하고 되밀려(back-drive) 조각 중앙에 안착한다.
 * ===================================================================== */

const TAU = Math.PI * 2;
const TOP = -Math.PI / 2; // 핀이 물고 있는 각도(12시)

/** 각도를 (-π, π] 로 정규화 */
function wrap(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ */
/* 물리 상수                                                            */
/* ------------------------------------------------------------------ */
const PHYS = {
  wheelInertia: 1.0,
  coulomb: 0.24, // 축 마찰 (속도 무관, 정지 마찰도 겸함)
  viscous: 0.42, // 점성 감쇠 (속도 비례)
  drag: 0.022, // 공기저항 (속도 제곱 비례)

  pinInertia: 0.0016,
  pinSpring: 0.42, // 핀을 아래로 되돌리는 스프링
  pinDamping: 0.0075,
  pinMaxDeflect: 0.62, // 핀이 peg를 타 넘을 때 최대 젖힘각 (rad)
  pinBackStop: 0.07, // 반대쪽으로 넘어가지 못하게 막는 스토퍼
  pinRestitution: 0.38, // 스토퍼 반발계수
  contactDamp: 0.5, // peg-핀 접촉면에서 갉아먹는 에너지
  // 핀 스프링 토크가 휠에 전달될 때의 모멘트암.
  // 픽셀 기하(pegR/pinLen)로 계산하면 창 크기가 물리를 바꾸므로 상수로 고정한다.
  pinArm: 3.0,

  stopOmega: 0.02, // 이 아래면 정지로 판정
  maxSubsteps: 240,
};

/* ------------------------------------------------------------------ */
/* 사운드 (WebAudio 합성 — 외부 파일 없음)                              */
/* ------------------------------------------------------------------ */
class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.lastTick = 0;
  }

  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.bus = this.ctx.createGain();
      this.bus.gain.value = 0.5;
      this.bus.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** peg가 핀을 튕기고 지나갈 때 나는 딱 소리. speed에 따라 음색이 변한다. */
  tick(speed) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (t - this.lastTick < 0.012) return; // 너무 촘촘하면 뭉개짐
    this.lastTick = t;

    const dur = 0.045;
    const buf = this.ctx.createBuffer(1, Math.ceil(this.ctx.sampleRate * dur), this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
      const env = Math.pow(1 - i / ch.length, 7);
      ch[i] = (Math.random() * 2 - 1) * env;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500 + clamp(speed, 0, 26) * 90;
    bp.Q.value = 2.2;

    const g = this.ctx.createGain();
    g.gain.value = clamp(0.18 + speed * 0.012, 0.12, 0.5);

    src.connect(bp).connect(g).connect(this.bus);
    src.start(t);
  }

  /** 핀이 스토퍼를 때리는 낮은 소리 */
  thud(v) {
    if (!this.enabled || !this.ctx || v < 0.6) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(320, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.05);
    g.gain.setValueAtTime(clamp(v * 0.05, 0.01, 0.12), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.07);
  }

  /** 당첨 팡파레 */
  fanfare() {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const t = t0 + i * 0.11;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      o.connect(g).connect(this.bus);
      o.start(t);
      o.stop(t + 0.36);
    });
  }

  /** 탈락 부저 — 낮게 깔리는 두 음 */
  buzz() {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime;
    [0, 0.16].forEach((off) => {
      const t = t0 + off;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(150, t);
      o.frequency.linearRampToValueAtTime(96, t + 0.13);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(this.bus);
      o.start(t);
      o.stop(t + 0.16);
    });
  }

  /** 파워 충전 중 상승음 */
  charge(level) {
    if (!this.enabled || !this.ctx) return;
    if (!this._chargeOsc) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      g.gain.value = 0.025;
      o.connect(g).connect(this.bus);
      o.start();
      this._chargeOsc = o;
      this._chargeGain = g;
    }
    this._chargeOsc.frequency.setTargetAtTime(160 + level * 520, this.ctx.currentTime, 0.03);
  }

  chargeStop() {
    if (this._chargeOsc) {
      this._chargeGain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.02);
      const o = this._chargeOsc;
      setTimeout(() => o.stop(), 120);
      this._chargeOsc = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 돌림판                                                               */
/* ------------------------------------------------------------------ */
const SLICE_COLORS = [
  '#e8262d', // 빨강
  '#ffd400', // 노랑
  '#1f8fdb', // 파랑
  '#2ea84f', // 초록
  '#f2761b', // 주황
  '#8e3fc0', // 보라
];

class Wheel {
  constructor(canvas, sfx) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sfx = sfx;

    this.items = [];
    this.theta = 0;
    this.omega = 0;
    this.spinning = false;
    this.lastDir = 1;

    this.phi = 0; // 핀 젖힘각
    this.phiVel = 0;
    this.prevD = -1; // 직전 프레임의 peg-핀 각차

    this.images = new Map();
    this.face = document.createElement('canvas'); // 오프스크린 휠 면
    this.faceDirty = true;

    this.onResult = null;
    this.onTick = null;

    this._raf = null;
    this._lastT = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /* ---------------- 데이터 ---------------- */

  setItems(items) {
    this.items = items;
    this.faceDirty = true;
    items.forEach((it) => this._loadImage(it.img));
    this.render();
  }

  _loadImage(url) {
    if (!url || this.images.has(url)) return;
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      this.faceDirty = true;
      if (!this.spinning) this.render();
    };
    img.onerror = () => this.images.set(url, null);
    img.src = url;
    this.images.set(url, img);
  }

  /* ---------------- 기하 ---------------- */

  get sliceAngle() {
    return TAU / Math.max(this.items.length, 1);
  }

  /**
   * 접촉 반각 — peg 하나가 핀을 밀고 있는 각도 폭.
   * 조각 반각보다 반드시 작아야 핀이 peg 사이 빈 골에 안착할 수 있다.
   */
  get contactHalf() {
    return Math.min(this.sliceAngle * 0.3, 0.11);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const box = this.canvas.parentElement.getBoundingClientRect();
    const size = Math.max(320, Math.min(box.width, box.height || box.width));
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = size + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.size = size;
    this.cx = size / 2;
    this.cy = size / 2;
    this.R = size / 2 - 34; // 휠 반지름 (전구 링 안쪽)
    this.pegR = this.R - 11; // peg가 박힌 반지름
    this.pivotY = this.cy - this.R - 22; // 핀 힌지 y
    this.pinLen = this.cy - this.pegR - this.pivotY; // 힌지 → 팁 길이

    this.faceDirty = true;
    this.render();
  }

  /* ---------------- 물리 ---------------- */

  /**
   * 현재 각도에서 핀에 가장 가까운 peg 까지의 각차.
   * 음수 = peg가 아직 핀에 도달하기 전 (시계방향 기준), 양수 = 이미 지나감.
   */
  _pegDelta(theta) {
    const d = this.sliceAngle;
    const t = wrap(TOP - theta);
    const j = Math.round(t / d);
    return j * d - t;
  }

  spin(omega0) {
    if (this.spinning) return;
    this.sfx.resume();
    this.omega = omega0;
    this.lastDir = Math.sign(omega0) || 1;
    this.spinning = true;
    this.result = null;
    this._lastT = performance.now();
    if (!this._raf) this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  nudge(dOmega) {
    this.omega += dOmega;
    if (Math.abs(this.omega) > 0.05) {
      this.lastDir = Math.sign(this.omega);
      this.spinning = true;
      if (!this._raf) {
        this._lastT = performance.now();
        this._raf = requestAnimationFrame((t) => this._frame(t));
      }
    }
  }

  _step(dt) {
    const eps = this.contactHalf;
    const I = PHYS.wheelInertia;
    const dir = Math.abs(this.omega) > 1e-4 ? Math.sign(this.omega) : this.lastDir;
    if (Math.abs(this.omega) > 1e-4) this.lastDir = dir;

    // --- 현재 위치에서 휠에 걸리는 토크 ---
    const d0 = this._pegDelta(this.theta);
    const touching = Math.abs(d0) < eps;

    let tau = 0;
    if (touching) {
      // 핀이 peg 옆면을 타고 있다. |d|가 0일 때(peg 정점) 가장 많이 젖혀진다.
      const phi = dir * PHYS.pinMaxDeflect * (1 - Math.abs(d0) / eps);

      // 스프링은 핀을 수직으로 되돌리려 하고, 그러려면 peg가 정점에서 멀어져야 한다.
      // → 휠은 항상 |d|가 커지는 쪽(가까운 골 쪽)으로 떠밀린다.
      // peg를 밀어 올리는 동안(d<0)은 감속, 정점을 넘어가면(d>0) 가속.
      // 이 되밀어주는 힘이 있어야 핀이 peg 사이 골에 안착한다.
      tau += Math.sign(d0) * PHYS.pinSpring * Math.abs(phi) * PHYS.pinArm;

      // 접촉면 마찰 — "따다닥" 한 번마다 갉아먹는 에너지
      tau -= PHYS.contactDamp * this.omega;
    }

    tau -= PHYS.viscous * this.omega + PHYS.drag * this.omega * Math.abs(this.omega);

    // --- 정지 마찰: 남은 토크가 축 마찰을 못 이기면 그 자리에 굳는다 ---
    // 핀이 peg 옆면 끄트머리에 얹히면 스프링 토크가 약해 여기서 걸릴 수 있다.
    let seized = false;
    if (Math.abs(this.omega) < 1e-3 && Math.abs(tau) < PHYS.coulomb) {
      this.omega = 0;
      tau = 0;
      seized = true;
    } else {
      tau -= PHYS.coulomb * Math.sign(this.omega || dir);
    }

    this.omega += (tau / I) * dt;
    this.theta += this.omega * dt;

    // --- 핀 상태 갱신 ---
    const d1 = this._pegDelta(this.theta);
    const contact = Math.abs(d1) < eps;

    if (contact) {
      const target = dir * PHYS.pinMaxDeflect * (1 - Math.abs(d1) / eps);
      this.phiVel = clamp((target - this.phi) / dt, -80, 80);
      this.phi = target;
    } else {
      this._relaxPin(dt);
    }

    // --- peg 정점 통과 = 딱 소리 ---
    // _pegDelta는 "가장 가까운 peg"를 기준으로 하므로, 골 한복판에서 기준 peg가
    // 바뀌며 d가 +Δ/2 → -Δ/2 로 점프한다. 그 점프도 부호가 뒤집히니
    // 접촉 범위 안에서 일어난 교차만 진짜 정점 통과로 센다.
    const apexCross = d0 * d1 < 0 && Math.abs(d0) < eps && Math.abs(d1) < eps;
    if (apexCross && Math.abs(this.omega) > 0.04) {
      const spd = Math.abs(this.omega);
      this.sfx.tick(spd);
      if (this.onTick) this.onTick(spd);
    }
    this.prevD = d1;

    // --- 완전 정지 판정 ---
    // 마찰로 굳었거나, 핀이 peg 사이 골에 앉은 채 거의 멈췄으면 회전은 끝이다.
    // 핀의 잔진동은 회전과 무관하게 _relaxPin이 마저 잦아들게 한다.
    if (seized || (Math.abs(this.omega) < PHYS.stopOmega && !contact)) {
      this.omega = 0;
      return false;
    }
    return true;
  }

  /** 접촉이 없을 때의 핀 자유 진동 — 튕겨서 스토퍼를 때린다 */
  _relaxPin(dt) {
    const acc = (-PHYS.pinSpring * this.phi - PHYS.pinDamping * this.phiVel) / PHYS.pinInertia;
    this.phiVel = clamp(this.phiVel + acc * dt, -80, 80);
    this.phi += this.phiVel * dt;

    const lim = PHYS.pinBackStop;
    if (this.phi < -lim) {
      this.phi = -lim;
      this.sfx.thud(Math.abs(this.phiVel));
      this.phiVel = -this.phiVel * PHYS.pinRestitution;
    } else if (this.phi > lim) {
      this.phi = lim;
      this.sfx.thud(Math.abs(this.phiVel));
      this.phiVel = -this.phiVel * PHYS.pinRestitution;
    }

    if (Math.abs(this.phi) < 1e-3 && Math.abs(this.phiVel) < 1e-2) {
      this.phi = 0;
      this.phiVel = 0;
    }
  }

  _frame(now) {
    const dtFrame = Math.min((now - this._lastT) / 1000, 1 / 30);
    this._lastT = now;

    if (this.spinning) {
      // peg 하나를 절대 건너뛰지 않도록 서브스텝 분할
      const eps = this.contactHalf;
      const travel = Math.abs(this.omega) * dtFrame;
      const n = clamp(Math.ceil(travel / (eps * 0.35)) || 1, 1, PHYS.maxSubsteps);
      const dt = dtFrame / n;

      let alive = true;
      for (let i = 0; i < n && alive; i++) alive = this._step(dt);

      if (!alive) {
        this.spinning = false;
        this._settle();
      }
    } else if (this.phi !== 0 || this.phiVel !== 0) {
      // 휠은 멈췄지만 핀은 아직 떨고 있다
      this._relaxPin(Math.min(dtFrame, 1 / 120));
    }

    this.render();

    if (this.spinning || this.phi !== 0 || this.phiVel !== 0) {
      this._raf = requestAnimationFrame((t) => this._frame(t));
    } else {
      this._raf = null;
    }
  }

  _settle() {
    this.theta = wrap(this.theta);
    const idx = this.winningIndex();
    this.result = this.items[idx];
    this.sfx.fanfare();
    if (this.onResult) this.onResult(this.result, idx);
  }

  winningIndex() {
    const n = this.items.length;
    if (!n) return 0;
    const rel = ((TOP - this.theta) % TAU + TAU) % TAU;
    return Math.floor(rel / this.sliceAngle) % n;
  }

  /* ---------------- 렌더 ---------------- */

  /** 휠 면은 잘 안 바뀌므로 오프스크린에 한 번만 그린다 */
  _renderFace() {
    const n = this.items.length;
    if (!n) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const R = this.R;
    const s = R * 2;
    this.face.width = s * dpr;
    this.face.height = s * dpr;
    const g = this.face.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, s, s);
    g.translate(R, R);

    const slice = this.sliceAngle;
    const showImg = n <= 26;
    const showText = n <= 40;

    // 가게 이름이 앉는 바깥쪽 띠. 조각 색·사진과 무관하게 흰 글씨가 읽히도록 위에 덮는다.
    const bandIn = R * 0.42;

    for (let i = 0; i < n; i++) {
      const a0 = i * slice;
      const a1 = a0 + slice;
      const mid = a0 + slice / 2;

      // 조각
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, R, a0, a1);
      g.closePath();
      let color = SLICE_COLORS[i % SLICE_COLORS.length];
      if (n % SLICE_COLORS.length !== 0 && i === n - 1) {
        color = SLICE_COLORS[(i + 1) % SLICE_COLORS.length]; // 이음매 같은 색 방지
      }
      g.fillStyle = color;
      g.fill();

      // 안쪽 광택
      const grd = g.createRadialGradient(0, 0, R * 0.1, 0, 0, R);
      grd.addColorStop(0, 'rgba(255,255,255,0.22)');
      grd.addColorStop(0.55, 'rgba(255,255,255,0.02)');
      grd.addColorStop(1, 'rgba(0,0,0,0.25)');
      g.fillStyle = grd;
      g.fill();

      g.strokeStyle = 'rgba(255,255,255,0.55)';
      g.lineWidth = 1.5;
      g.stroke();

      const it = this.items[i];

      // 사진 — 글씨 띠 아래에 깔리는 배경
      if (showImg && it.img) {
        const img = this.images.get(it.img);
        if (img && img.complete && img.naturalWidth) {
          const rad = Math.min(slice * (R * 0.62) * 0.42, R * 0.13);
          const px = Math.cos(mid) * R * 0.63;
          const py = Math.sin(mid) * R * 0.63;
          g.save();
          g.beginPath();
          g.arc(px, py, rad, 0, TAU);
          g.closePath();
          g.clip();
          const side = rad * 2;
          g.drawImage(img, px - rad, py - rad, side, side);
          g.restore();
          g.beginPath();
          g.arc(px, py, rad, 0, TAU);
          g.strokeStyle = 'rgba(255,255,255,0.9)';
          g.lineWidth = 2;
          g.stroke();
        }
      }

      // 글씨 띠 — 안쪽으로 투명하게 풀어서 조각 색과 사진이 비쳐 보이게
      if (showText) {
        g.beginPath();
        g.arc(0, 0, R, a0, a1);
        g.arc(0, 0, bandIn, a1, a0, true);
        g.closePath();
        const band = g.createRadialGradient(0, 0, bandIn, 0, 0, R);
        band.addColorStop(0, 'rgba(10,5,0,0)');
        band.addColorStop(0.35, 'rgba(10,5,0,0.52)');
        band.addColorStop(1, 'rgba(10,5,0,0.72)');
        g.fillStyle = band;
        g.fill();

        // 띠가 덮어버린 조각 경계를 다시 긋는다
        g.beginPath();
        g.moveTo(0, 0);
        g.arc(0, 0, R, a0, a1);
        g.closePath();
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = 1.5;
        g.stroke();
      }

      // 이름 + 대표메뉴 (반경 방향으로 눕혀서)
      if (showText) {
        g.save();
        g.rotate(mid);
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        const baseSize = clamp(slice * R * 0.44, 12, 26);
        const menuSize = baseSize * 0.62;
        const edge = R - 14;
        const maxW = R - bandIn - 10;
        g.lineJoin = 'round';
        g.miterLimit = 2;

        // 🍶는 이름 줄이 아니라 메뉴 줄에 붙인다 — 이름 자리를 한 글자도 뺏지 않게
        const nameY = -menuSize * 0.62;
        const short = this._shortName(it.name);

        // 이름이 넘치면 자르기 전에 글자부터 줄인다. 창이 좁을 때 세 글자만 남는 걸 막는다.
        g.font = `900 ${baseSize}px "Gothic A1", "Malgun Gothic", sans-serif`;
        const full = g.measureText(short).width;
        const nameSize = full > maxW ? Math.max(baseSize * 0.6, (baseSize * maxW) / full) : baseSize;

        g.font = `900 ${nameSize}px "Gothic A1", "Malgun Gothic", sans-serif`;
        const name = this._ellipsis(g, short, maxW);
        g.strokeStyle = 'rgba(0,0,0,0.92)';
        g.lineWidth = Math.max(3, nameSize * 0.24);
        g.strokeText(name, edge, nameY);
        g.fillStyle = '#ffffff';
        g.fillText(name, edge, nameY);

        if (n <= 30) {
          const menuY = menuSize * 0.72;
          g.font = `700 ${menuSize}px "Gothic A1", "Malgun Gothic", sans-serif`;
          const menu = this._ellipsis(g, it.menu, maxW - (it.soju ? menuSize * 1.3 : 0));
          g.strokeStyle = 'rgba(0,0,0,0.85)';
          g.lineWidth = Math.max(2.4, menuSize * 0.24);
          g.strokeText(menu, edge, menuY);
          g.fillStyle = '#ffe9a8';
          g.fillText(menu, edge, menuY);

          if (it.soju) {
            const w = g.measureText(menu).width;
            g.font = `${menuSize}px "Gothic A1", sans-serif`;
            g.fillText('🍶', edge - w - menuSize * 0.2, menuY);
          }
        }
        g.restore();
      }
    }

    // peg — 조각 경계마다 박힌 못
    for (let i = 0; i < n; i++) {
      const a = i * slice;
      const px = Math.cos(a) * this.pegR;
      const py = Math.sin(a) * this.pegR;
      g.beginPath();
      g.arc(px, py, 4.2, 0, TAU);
      const pg = g.createRadialGradient(px - 1.4, py - 1.4, 0.4, px, py, 4.2);
      pg.addColorStop(0, '#fffbe6');
      pg.addColorStop(0.5, '#e9c94a');
      pg.addColorStop(1, '#8a6a12');
      g.fillStyle = pg;
      g.fill();
      g.strokeStyle = 'rgba(60,40,0,0.7)';
      g.lineWidth = 0.8;
      g.stroke();
    }

    this.faceDirty = false;
  }

  /**
   * 조각에 들어갈 짧은 상호.
   * "정돈 현대백화점 판교점" 처럼 뒤에 붙는 지점명을 떼야 정작 상호가 안 잘린다.
   * 목록·결과 카드에는 원래 이름을 그대로 쓴다.
   */
  _shortName(name) {
    let n = String(name).replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim();
    for (let i = 0; i < 3; i++) {
      const m = n.match(/^(.+?)\s+\S*(?:본점|직영점|호점|지점|점)$/);
      if (!m || m[1].trim().length < 2) break;
      n = m[1].trim();
    }
    return n;
  }

  _ellipsis(g, text, maxW) {
    if (g.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  render() {
    const g = this.ctx;
    const { cx, cy, R, size } = this;
    if (!size) return;
    g.clearRect(0, 0, size, size);

    if (this.faceDirty) this._renderFace();

    // 바깥 전구 링
    this._drawBulbs(g);

    // 금속 테두리
    g.beginPath();
    g.arc(cx, cy, R + 9, 0, TAU);
    const rim = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    rim.addColorStop(0, '#fff3b0');
    rim.addColorStop(0.28, '#c9962b');
    rim.addColorStop(0.5, '#8a5f10');
    rim.addColorStop(0.72, '#e8c25c');
    rim.addColorStop(1, '#6d4708');
    g.strokeStyle = rim;
    g.lineWidth = 14;
    g.stroke();

    // 휠 면
    if (this.items.length) {
      g.save();
      g.translate(cx, cy);
      g.rotate(this.theta);
      g.drawImage(this.face, -R, -R, R * 2, R * 2);
      g.restore();
    }

    // 그림자
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    g.stroke();

    this._drawHub(g);
    this._drawPin(g);
  }

  _drawBulbs(g) {
    const { cx, cy, R } = this;
    const count = 28;
    const t = performance.now() / 1000;
    const phase = this.spinning ? t * 6 : t * 1.6;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU - Math.PI / 2;
      const x = cx + Math.cos(a) * (R + 22);
      const y = cy + Math.sin(a) * (R + 22);
      const on = (Math.sin(phase + i * 0.7) + 1) / 2;
      g.beginPath();
      g.arc(x, y, 5.2, 0, TAU);
      g.fillStyle = `rgba(255,${200 + on * 55},${90 + on * 90},${0.35 + on * 0.65})`;
      g.shadowColor = `rgba(255,220,120,${0.7 * on})`;
      g.shadowBlur = 14 * on;
      g.fill();
      g.shadowBlur = 0;
    }
  }

  _drawHub(g) {
    const { cx, cy, R } = this;
    const r = Math.max(34, R * 0.15);
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    const hg = g.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
    hg.addColorStop(0, '#fff6c9');
    hg.addColorStop(0.5, '#d8a72e');
    hg.addColorStop(1, '#7a5209');
    g.fillStyle = hg;
    g.fill();
    g.strokeStyle = '#4a3005';
    g.lineWidth = 2;
    g.stroke();

    g.fillStyle = '#3a2400';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `900 ${Math.max(12, r * 0.34)}px "Black Han Sans", "Gothic A1", sans-serif`;
    g.fillText('판교', cx, cy - r * 0.19);
    g.fillText('술상', cx, cy + r * 0.25);
  }

  _drawPin(g) {
    const { cx, pivotY, pinLen } = this;
    g.save();
    g.translate(cx, pivotY);
    g.rotate(this.phi);

    // 팁까지 이어지는 금속 날
    const w = 8;
    g.beginPath();
    g.moveTo(-w, 0);
    g.lineTo(w, 0);
    g.lineTo(2.6, pinLen);
    g.lineTo(-2.6, pinLen);
    g.closePath();
    const pg = g.createLinearGradient(-w, 0, w, 0);
    pg.addColorStop(0, '#fff8d8');
    pg.addColorStop(0.42, '#e0b53f');
    pg.addColorStop(1, '#7d5710');
    g.fillStyle = pg;
    g.fill();
    g.strokeStyle = 'rgba(40,25,0,0.75)';
    g.lineWidth = 1.4;
    g.stroke();

    // 팁 구슬
    g.beginPath();
    g.arc(0, pinLen, 3.6, 0, TAU);
    g.fillStyle = '#fff2b8';
    g.fill();
    g.strokeStyle = '#6b4708';
    g.stroke();
    g.restore();

    // 힌지 볼트
    g.beginPath();
    g.arc(cx, pivotY, 9, 0, TAU);
    const bg = g.createRadialGradient(cx - 3, pivotY - 3, 1, cx, pivotY, 9);
    bg.addColorStop(0, '#ffffff');
    bg.addColorStop(0.5, '#d0d4dd');
    bg.addColorStop(1, '#5b6070');
    g.fillStyle = bg;
    g.fill();
    g.strokeStyle = '#2b2f3a';
    g.lineWidth = 1.6;
    g.stroke();
  }
}

window.Wheel = Wheel;
window.Sfx = Sfx;
