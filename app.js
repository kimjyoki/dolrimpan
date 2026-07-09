/* 판교 술상 돌림판 — UI 제어 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const CATEGORIES = [
  { key: 'all', label: '전체', test: () => true },
  { key: 'soju', label: '🍶 소주 확인됨', test: (c, s) => s.soju },
  { key: 'meat', label: '고기·구이', test: (c) => /고기|고깃|삼겹|냉삼|오겹|목살|갈비|한우|흑돼지|돼지|곱창|막창|대창|껍데기|양꼬치|양갈비|족발|보쌈|바베큐|스테이크|야끼니꾸|이베리코/.test(c) },
  { key: 'chicken', label: '치킨·닭', test: (c) => /치킨|치맥|닭|호프/.test(c) },
  { key: 'izakaya', label: '이자카야·일식', test: (c) => /이자카야|야키토리|사케|일식|스시|초밥|사시미|오마카세|라멘|야끼|덮밥/.test(c) },
  { key: 'sea', label: '회·해산물', test: (c) => /횟집|회$|연어|광어|장어|생선|매운탕|해산물|조개|꼬막|골뱅이|낙지|문어|대게|전복|새우|굴/.test(c) },
  { key: 'korean', label: '한식·국밥·포차', test: (c) => /한식|포차|국밥|순대|해장국|곰탕|설렁탕|갈비탕|육개장|찌개|전골|된장|보리굴비|냉면|칼국수|백반|집밥|정식/.test(c) },
  { key: 'beer', label: '맥주·펍', test: (c) => /맥주|펍|생맥|흑맥주|피맥|브루|탭하우스/.test(c) },
  { key: 'makgeolli', label: '막걸리·주점', test: (c) => /막걸리|주점|양조장|술집/.test(c) },
  { key: 'world', label: '중식·양식·아시안', test: (c) => /중식|중국|마라|짬뽕|북경오리|파스타|피자|이탈리안|양식|프렌치|스페인|감바스|버거|태국|베트남|쌀국수|멕시칸|타코|다이닝|비스트로|퓨전/.test(c) },
];

const DISTANCES = [
  { key: 500, label: '500m' },
  { key: 1000, label: '1km' },
  { key: 2000, label: '2km' },
];

const state = {
  cat: 'all',
  sort: 'score',
  count: 0,
  dist: 2000,
  pool: [],
  slots: [],
  exiled: new Set(), // 탈락시킨 가게 id
  banSigs: [], // 탈락한 가게의 업종·태그 지문. 여기 걸리면 다시 안 올라온다
};

const sfx = new Sfx();
const wheel = new Wheel($('#wheel'), sfx);

/* ------------------------------------------------------------------ */
/* 업종·태그 유사도                                                      */
/* ------------------------------------------------------------------ */

// 'soju'는 업종이 아니라 속성이고, 'all'은 전부 걸리니 유사도 판정에서 뺀다
const GENRES = CATEGORIES.filter((c) => c.key !== 'all' && c.key !== 'soju');

function genresOf(s) {
  return GENRES.filter((g) => g.test(s.cat, s)).map((g) => g.key);
}

/** 세부 업종 낱말. 큰 업종이 같아도 순대국과 해장국은 다른 집으로 친다 */
function detailKeys(s) {
  return tokensOf(s).slice(0, 1);
}

function tokensOf(s) {
  return String(s.cat)
    .split(/[,·/&]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function sigOf(s) {
  return {
    genres: new Set(genresOf(s)),
    toks: new Set(tokensOf(s)),
    tags: new Set(s.tags || []),
  };
}

/** 큰 업종이 겹치거나, 세부 업종 문구가 겹치거나, 태그가 둘 이상 겹치면 "비슷한 집" */
function matchesSig(s, sig) {
  if (genresOf(s).some((g) => sig.genres.has(g))) return true;
  if (tokensOf(s).some((t) => sig.toks.has(t))) return true;
  return (s.tags || []).filter((t) => sig.tags.has(t)).length >= 2;
}

/** 지문을 몇 개나 포기하고 칸을 채웠는지. 0이면 탈락 의사를 완전히 지켰다는 뜻 */
let relaxed = 0;

/* ------------------------------------------------------------------ */
/* 후보 뽑기                                                            */
/* ------------------------------------------------------------------ */

function buildPool() {
  const cat = CATEGORIES.find((c) => c.key === state.cat);
  state.pool = window.STORES.filter((s) => s.dist <= state.dist && cat.test(s.cat, s));
}

function sortList(list) {
  if (state.sort === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  } else if (state.sort === 'dist') {
    list.sort((a, b) => a.dist - b.dist);
  } else if (state.sort === 'rating') {
    list.sort((a, b) => (b.rating || 0) - (a.rating || 0) || b.score - a.score);
  } else {
    list.sort((a, b) => b.score - a.score);
  }
  return list;
}

/**
 * 탈락 지문을 피한 후보.
 * 칸을 못 채우면 오래된 지문부터 하나씩 놓아준다 — 방금 탈락시킨 업종이 되살아나는 건 마지막 수단.
 * 탈락시킨 가게 자신은 어떤 경우에도 다시 오르지 않는다.
 */
function eligible(need) {
  const alive = state.pool.filter((s) => !state.exiled.has(s.id));
  let list = alive;
  for (let drop = 0; drop <= state.banSigs.length; drop++) {
    const sigs = state.banSigs.slice(drop);
    list = alive.filter((s) => !sigs.some((sig) => matchesSig(s, sig)));
    relaxed = drop;
    if (list.length >= need) break;
  }
  return sortList(list);
}

function pickSlots() {
  buildPool();
  const need = state.count || 0; // '전부 다'(0)는 채울 최소 개수가 없다
  const list = eligible(need);

  const n = state.count === 0 ? list.length : Math.min(state.count, list.length);
  state.slots = list.slice(0, n);

  // 인접한 조각에 같은 사진이 몰리지 않게 살짝 섞는다
  if (state.sort !== 'random') {
    const half = Math.ceil(state.slots.length / 2);
    const a = state.slots.slice(0, half);
    const b = state.slots.slice(half);
    state.slots = a.flatMap((x, i) => (b[i] ? [x, b[i]] : [x]));
  }

  wheel.setItems(state.slots);
  renderPool();
  updateStatus();
}

/* ------------------------------------------------------------------ */
/* 탈락 — 비슷한 집을 통째로 빼고 새 업종으로 채운다                      */
/* ------------------------------------------------------------------ */

function eliminate(store) {
  if (wheel.spinning) return;

  const sig = sigOf(store);
  const doomed = state.slots.filter((s) => s.id === store.id || matchesSig(s, sig));
  if (!doomed.length) return;

  state.banSigs.push(sig);
  doomed.forEach((s) => state.exiled.add(s.id));

  sfx.resume();
  sfx.buzz();

  const doomedIds = new Set(doomed.map((s) => s.id));
  state.slots.forEach((s, i) => {
    if (!doomedIds.has(s.id)) return;
    const li = $(`#pool-list li[data-idx="${i}"]`);
    if (li) li.classList.add('doomed');
  });

  $('#result').classList.add('hidden');
  setTimeout(() => refill(doomedIds), 520);
}

/**
 * 빠진 자리마다 새 가게를 꽂는다.
 * 아직 안 나온 큰 업종을 먼저, 그다음 안 나온 세부 업종을, 그래도 모자라면 아무나.
 */
function refill(doomedIds) {
  const keptIds = new Set(state.slots.filter((s) => !doomedIds.has(s.id)).map((s) => s.id));
  const need = state.slots.length - keptIds.size;

  const kept = state.slots.filter((s) => keptIds.has(s.id));
  const seenGenre = new Set(kept.flatMap(genresOf));
  const seenDetail = new Set(kept.flatMap(detailKeys));
  const cands = eligible(need + keptIds.size).filter((s) => !keptIds.has(s.id));

  const fresh = [];
  const taken = new Set();
  const sweep = (keysOf, seen, skipKeyless) => {
    for (const c of cands) {
      if (fresh.length >= need) return;
      if (taken.has(c.id)) continue;
      const ks = keysOf(c);
      if (!ks.length && skipKeyless) continue; // 업종 미분류는 1차에서 건너뛴다
      if (ks.length && ks.every((k) => seen.has(k))) continue;
      ks.forEach((k) => seen.add(k));
      fresh.push(c);
      taken.add(c.id);
    }
  };
  sweep(genresOf, seenGenre, true);
  sweep(detailKeys, seenDetail, false);
  for (const c of cands) {
    if (fresh.length >= need) break;
    if (!taken.has(c.id)) fresh.push(c);
  }

  const incoming = new Set(fresh.map((s) => s.id));
  state.slots = state.slots.map((s) => (keptIds.has(s.id) ? s : fresh.shift())).filter(Boolean);

  wheel.setItems(state.slots);
  renderPool();
  updateStatus();
  $$('#pool-list li').forEach((li) => {
    if (incoming.has(li.dataset.id)) li.classList.add('fresh');
  });
}

function revive() {
  if (wheel.spinning) return;
  state.exiled.clear();
  state.banSigs = [];
  pickSlots();
}

/* ------------------------------------------------------------------ */
/* 화면 갱신                                                            */
/* ------------------------------------------------------------------ */

function updateStatus() {
  const label = DISTANCES.find((d) => d.key === state.dist).label;
  const soju = state.slots.filter((s) => s.soju).length;
  const out = state.exiled.size;
  $('#status').innerHTML =
    `판교역 반경 ${label} · 후보 <b>${state.pool.length}</b>곳 중 <b>${state.slots.length}</b>칸 배치` +
    (soju ? ` · 🍶 소주 확인 <b>${soju}</b>곳` : '') +
    (out ? ` · ❌ 탈락 <b>${out}</b>곳 <button id="revive" class="link">되살리기</button>` : '') +
    (relaxed ? `<br><span class="warn">남은 가게가 모자라 오래된 탈락 업종 ${relaxed}개를 다시 올렸습니다</span>` : '');
  const rv = $('#revive');
  if (rv) rv.onclick = revive;
}

function renderPool() {
  const ul = $('#pool-list');
  ul.innerHTML = '';
  state.slots.forEach((s, i) => {
    const li = document.createElement('li');
    li.dataset.idx = i;
    li.dataset.id = s.id;
    li.innerHTML = `
      <span class="no">${String(i + 1).padStart(2, '0')}</span>
      <img src="${s.img}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span class="txt">
        <b>${s.soju ? '<i class="soju" title="메뉴/리뷰에서 소주 판매 확인">🍶</i>' : ''}${escapeHtml(s.name)}</b>
        <em>${escapeHtml(s.menu)}</em>
      </span>
      <span class="meta">${fmtDist(s.dist)}</span>`;
    ul.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDist(m) {
  return m >= 1000 ? (m / 1000).toFixed(1) + 'km' : m + 'm';
}

function showResult(store, idx) {
  const box = $('#result');
  box.classList.remove('hidden');
  box.classList.remove('pop');
  void box.offsetWidth; // 애니메이션 리셋
  box.classList.add('pop');

  const naver = `https://map.naver.com/p/search/${encodeURIComponent('판교역 ' + store.name)}`;
  const sig = sigOf(store);
  const hit = state.slots.filter((s) => s.id === store.id || matchesSig(s, sig)).length;

  box.innerHTML = `
    <div class="caption-bar">오늘의 술상 당첨!</div>
    <div class="result-body">
      <img class="shot" src="${store.img}" alt="${escapeHtml(store.name)}" referrerpolicy="no-referrer">
      <div class="info">
        <h2>${escapeHtml(store.name)}${store.soju ? ' <span class="soju-badge">🍶 소주 확인</span>' : ''}</h2>
        <p class="menu">🍺 대표메뉴 · <b>${escapeHtml(store.menu)}</b></p>
        <p class="sub">${escapeHtml(store.cat)} · 판교역에서 ${fmtDist(store.dist)}${store.rating ? ` · ★ ${store.rating}` : ''}</p>
        <div class="tags">${store.tags.map((t) => `<span>#${escapeHtml(t)}</span>`).join('')}</div>
        <div class="result-btns">
          <a class="naver" href="${naver}" target="_blank" rel="noopener">네이버 지도에서 열기 →</a>
          <button id="drop" class="btn drop">❌ 탈락! <small>비슷한 ${hit}곳 빼고 새 업종으로</small></button>
        </div>
      </div>
    </div>`;
  $('#drop').onclick = () => eliminate(store);

  $$('#pool-list li').forEach((li) => li.classList.toggle('win', +li.dataset.idx === idx));
  const win = $(`#pool-list li[data-idx="${idx}"]`);
  if (win) win.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  confetti();
}

wheel.onResult = showResult;
wheel.onTick = () => {
  const b = $('.stage');
  b.classList.add('shake');
  setTimeout(() => b.classList.remove('shake'), 40);
};

/* ------------------------------------------------------------------ */
/* 스핀 입력 — 누르면 충전, 놓으면 발사                                  */
/* ------------------------------------------------------------------ */

let charging = false;
let chargeStart = 0;
let chargeRaf = null;

const CHARGE_MS = 900; // 최대 충전까지 걸리는 시간
const OMEGA_MIN = 8;
const OMEGA_MAX = 22;

function chargeLevel() {
  return Math.min((performance.now() - chargeStart) / CHARGE_MS, 1);
}

function startCharge() {
  if (wheel.spinning || charging) return;
  sfx.resume();
  charging = true;
  chargeStart = performance.now();
  $('#spin').classList.add('charging');
  const loop = () => {
    if (!charging) return;
    const lv = chargeLevel();
    $('#power-fill').style.width = (lv * 100).toFixed(1) + '%';
    $('#power').classList.toggle('max', lv >= 1);
    sfx.charge(lv);
    chargeRaf = requestAnimationFrame(loop);
  };
  loop();
}

function releaseCharge() {
  if (!charging) return;
  const lv = chargeLevel();
  charging = false;
  cancelAnimationFrame(chargeRaf);
  sfx.chargeStop();
  $('#spin').classList.remove('charging');
  $('#power').classList.remove('max');
  $('#power-fill').style.width = '0%';

  $('#result').classList.add('hidden');
  $$('#pool-list li').forEach((li) => li.classList.remove('win'));

  // 최소 충전에도 몇 바퀴는 돌도록, 약간의 난수를 섞는다
  const omega = OMEGA_MIN + lv * (OMEGA_MAX - OMEGA_MIN) + (Math.random() - 0.5) * 2.4;
  wheel.spin(omega);
}

const spinBtn = $('#spin');
spinBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  spinBtn.setPointerCapture(e.pointerId);
  startCharge();
});
spinBtn.addEventListener('pointerup', releaseCharge);
spinBtn.addEventListener('pointercancel', releaseCharge);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && e.target === document.body) {
    e.preventDefault();
    startCharge();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    releaseCharge();
  }
});

/* --- 휠 직접 드래그해서 던지기 --- */
(() => {
  const cv = $('#wheel');
  let dragging = false;
  let lastAngle = 0;
  let lastTime = 0;
  let vel = 0;

  const angleAt = (e) => {
    const r = cv.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };

  cv.addEventListener('pointerdown', (e) => {
    if (wheel.spinning) return;
    dragging = true;
    cv.setPointerCapture(e.pointerId);
    lastAngle = angleAt(e);
    lastTime = performance.now();
    vel = 0;
    sfx.resume();
  });

  cv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const a = angleAt(e);
    const now = performance.now();
    let da = a - lastAngle;
    if (da > Math.PI) da -= Math.PI * 2;
    if (da < -Math.PI) da += Math.PI * 2;
    const dt = Math.max((now - lastTime) / 1000, 1 / 240);

    wheel.theta += da;
    vel = vel * 0.6 + (da / dt) * 0.4; // 속도 평활화
    lastAngle = a;
    lastTime = now;
    wheel.render();
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (Math.abs(vel) > 1.2) {
      $('#result').classList.add('hidden');
      $$('#pool-list li').forEach((li) => li.classList.remove('win'));
      wheel.spin(Math.sign(vel) * Math.min(Math.abs(vel), 26));
    }
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
})();

/* ------------------------------------------------------------------ */
/* 컨트롤                                                               */
/* ------------------------------------------------------------------ */

const chipBox = $('#cats');
CATEGORIES.forEach((c) => {
  const b = document.createElement('button');
  b.className = 'chip' + (c.key === 'all' ? ' on' : '');
  b.textContent = c.label;
  b.onclick = () => {
    if (wheel.spinning) return;
    state.cat = c.key;
    $$('#cats .chip').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    pickSlots();
  };
  chipBox.appendChild(b);
});

const distBox = $('#dists');
DISTANCES.forEach((d) => {
  const b = document.createElement('button');
  b.className = 'chip' + (d.key === state.dist ? ' on' : '');
  b.textContent = d.label;
  b.onclick = () => {
    if (wheel.spinning) return;
    state.dist = d.key;
    $$('#dists .chip').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    pickSlots();
  };
  distBox.appendChild(b);
});

$('#count').addEventListener('change', (e) => {
  state.count = +e.target.value;
  pickSlots();
});
$('#sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  pickSlots();
});
$('#reroll').addEventListener('click', () => {
  if (wheel.spinning) return;
  state.sort = 'random';
  $('#sort').value = 'random';
  pickSlots();
});
$('#mute').addEventListener('click', (e) => {
  sfx.enabled = !sfx.enabled;
  e.currentTarget.textContent = sfx.enabled ? '🔊 효과음' : '🔇 효과음';
  e.currentTarget.classList.toggle('off', !sfx.enabled);
});

/* ------------------------------------------------------------------ */
/* 유튜브 — 머쉬베놈 '돌림판' 뮤직비디오                                  */
/*                                                                    */
/* file:// 로 열면 페이지 출처가 없어서 유튜브가 임베드를 거부한다        */
/* (플레이어 에러 153). 반드시 http:// 로 띄워야 재생된다.              */
/* ------------------------------------------------------------------ */

// 공식 MV가 막히면 순서대로 다음 업로드로 넘어간다
const YT_TRACKS = [
  { id: 'pYVKfLBKSSI', label: '돌림판 (feat. 신빠람 이박사) Official MV' },
  { id: 'ohJ_AVpy0MQ', label: '돌림판 (with 신빠람 이박사) MV' },
  { id: 'A9jiHSxq3_w', label: '돌림판 — 뮤직뱅크 250926' },
  { id: 'VAQc6WlPM94', label: '돌림판 — KBS WORLD 250926' },
];

let ytPlayer = null;
let ytTrack = 0;
let ytUnmuted = false;

function ytFail(html) {
  const box = $('#yt-error');
  box.innerHTML = html;
  box.classList.remove('hidden');
  $('#yt-hint').classList.add('hidden');
}

if (location.protocol === 'file:') {
  ytFail(
    `<b>뮤직비디오가 재생되지 않는 이유</b>
     <p><code>file://</code> 로 열면 유튜브가 임베드를 거부합니다 (에러 153).</p>
     <p>이 폴더에서 <code>./start.command</code> 를 실행하거나<br>
     <code>python3 -m http.server 8777</code> 후
     <a href="http://localhost:8777/index.html">localhost:8777</a> 로 접속하세요.</p>`
  );
} else {
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = () => ytFail('<b>유튜브 API를 불러오지 못했습니다.</b><p>네트워크를 확인해 주세요.</p>');
  document.head.appendChild(tag);
}

window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player('yt', {
    host: 'https://www.youtube-nocookie.com',
    videoId: YT_TRACKS[0].id,
    playerVars: {
      autoplay: 1,
      mute: 1, // 브라우저는 음소거 상태에서만 자동재생을 허용한다
      loop: 1,
      playlist: YT_TRACKS[0].id, // loop 는 playlist 가 있어야 동작
      controls: 1,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      playsinline: 1,
    },
    events: {
      onReady: (e) => {
        e.target.mute();
        e.target.playVideo();
        $('#yt-hint').classList.remove('hidden');
      },
      onError: (e) => {
        if (e.data === 153 && location.protocol !== 'file:') {
          ytFail('<b>유튜브가 이 출처에서의 임베드를 거부했습니다.</b><p>에러 153</p>');
          return;
        }
        // 임베드 금지(101/150)나 삭제(100)면 다음 업로드로
        if (++ytTrack < YT_TRACKS.length) {
          const next = YT_TRACKS[ytTrack];
          $('#tv-track').textContent = next.label;
          ytPlayer.loadPlaylist({ playlist: [next.id], index: 0 });
          ytPlayer.mute();
        } else {
          ytFail(`<b>뮤직비디오를 재생할 수 없습니다.</b><p>플레이어 에러 ${e.data}</p>`);
        }
      },
    },
  });
};

function unmuteYt() {
  if (ytUnmuted || !ytPlayer || !ytPlayer.unMute) return;
  ytUnmuted = true;
  ytPlayer.unMute();
  ytPlayer.setVolume(55);
  ytPlayer.playVideo();
  $('#yt-hint').classList.add('hidden');
}
document.addEventListener('pointerdown', unmuteYt, { once: true });
$('#yt-hint').addEventListener('click', (e) => {
  e.stopPropagation();
  unmuteYt();
});

/* ------------------------------------------------------------------ */
/* 색종이                                                               */
/* ------------------------------------------------------------------ */

function confetti() {
  const host = $('#confetti');
  const colors = ['#e8262d', '#ffd400', '#1f8fdb', '#2ea84f', '#f2761b', '#8e3fc0'];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.5 + 's';
    p.style.animationDuration = 1.8 + Math.random() * 1.6 + 's';
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    host.appendChild(p);
    setTimeout(() => p.remove(), 3600);
  }
}

/* ------------------------------------------------------------------ */

pickSlots();
