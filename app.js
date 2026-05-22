// ============================================================
// Peraravatar — main application
// ============================================================

const STORAGE_KEY = 'peraravatar.config.v1';
const OLD_STORAGE_KEYS = ['pngtuber-lite.config.v1']; // migration support

// One-time migration: copy from old localStorage key if present
(function migrateStorageKey() {
  if (localStorage.getItem(STORAGE_KEY)) return;
  for (const oldKey of OLD_STORAGE_KEYS) {
    const old = localStorage.getItem(oldKey);
    if (old) {
      try {
        localStorage.setItem(STORAGE_KEY, old);
        localStorage.removeItem(oldKey);
      } catch (e) {}
      break;
    }
  }
})();

const DEFAULT_MOTION = {
  breathAmpY: 3,
  breathPeriod: 3800,
  swayAmpX: 1,
  swayPeriod: 5200,
  surpriseHopY: 12,
  surpriseHopDur: 200,
  talkTiltMaxDeg: 2.5,
  talkTiltPeriod: 3500,
  talkTiltLerp: 0.04,
  idleLookAmpX: 4,
  idleLookPeriod: 7000,
  idleLookDelay: 5000,
  idleLookFadeIn: 1500,
  loudPulseMin: 30,
  loudPulseDelta: 20,
  loudPulseScale: 0.035,
  loudPulseDur: 260,
  loudPulseRearm: 0.5,
  sleepyAfter: 30000,
  sleepyBreathMul: 0.5,
  yosomiIntervalMin: 7000,
  yosomiIntervalMax: 15000,
  yosomiDuration: 1500,
  yosomiTiltDeg: 3,
};

const FIXED_SLOTS = [
  { key: 'normal',      label: '通常' },
  { key: 'close',       label: '瞬き(閉眼)' },
  { key: 'surprised',   label: '驚き' },
  { key: 'yosomi_left', label: 'よそ見(左)' },
  { key: 'yosomi_right',label: 'よそ見(右)' },
];

// In the config, every image slot stores an "image key" (string) which refers
// to an entry in IndexedDB. The actual dataURL is loaded into `imageCache`
// at startup and consulted at render time.
const DEFAULT_CONFIG = {
  images: {
    normal: null,
    close: null,
    surprised: null,
    yosomi_left: null,
    yosomi_right: null,
  },
  mouthTiers: [
    { threshold: 5,   images: [] },
    { threshold: 7.5, images: [] },
    { threshold: 10,  images: [] },
  ],
  threshold1: 5,
  threshold2: 10,
  threshold3: 60,
  surpriseMode: 'oneshot',
  surpriseStyle: 'hop',
  motion: { ...DEFAULT_MOTION },
  blinkMin: 2000,
  blinkMax: 5000,
  blinkDuration: 150,
  obsMode: false,
};

// ============================================================
// IndexedDB wrapper for image blobs
// ============================================================
const DB_NAME = 'peraravatar';
const OLD_DB_NAMES = ['pngtuber-lite'];
const DB_VERSION = 1;
const IMAGE_STORE = 'images';
let _db = null;

// One-time migration: copy entries from any old IndexedDB databases into the
// current one, then drop the old DB.
async function migrateOldIndexedDB() {
  for (const oldName of OLD_DB_NAMES) {
    try {
      const oldDb = await new Promise((resolve, reject) => {
        const req = indexedDB.open(oldName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onupgradeneeded = () => {
          // DB didn't exist before; nothing to migrate. Abort to avoid creating it fresh.
          req.transaction.abort();
        };
      }).catch(() => null);
      if (!oldDb) continue;
      if (!oldDb.objectStoreNames.contains(IMAGE_STORE)) { oldDb.close(); continue; }
      const entries = await new Promise((resolve) => {
        const tx = oldDb.transaction(IMAGE_STORE, 'readonly');
        const store = tx.objectStore(IMAGE_STORE);
        const out = [];
        const cur = store.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { out.push([c.key, c.value]); c.continue(); }
          else resolve(out);
        };
        cur.onerror = () => resolve(out);
      });
      oldDb.close();
      for (const [k, v] of entries) {
        try { await idbSet(k, v); } catch (e) {}
      }
      try { indexedDB.deleteDatabase(oldName); } catch (e) {}
    } catch (e) { /* ignore */ }
  }
}

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE)) db.createObjectStore(IMAGE_STORE);
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function idbSet(key, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readwrite');
    tx.objectStore(IMAGE_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbDelete(key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readwrite');
    tx.objectStore(IMAGE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGetAll() {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readonly');
    const store = tx.objectStore(IMAGE_STORE);
    const result = {};
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { result[cursor.key] = cursor.value; cursor.continue(); }
      else { resolve(result); }
    };
    req.onerror = () => reject(req.error);
  }));
}

function idbClear() {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readwrite');
    tx.objectStore(IMAGE_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// ============================================================
// Runtime caches and config
// ============================================================
function cloneDeep(o) { return JSON.parse(JSON.stringify(o)); }

let config = cloneDeep(DEFAULT_CONFIG);
let imageCache = {}; // imageKey -> dataURL

function newImageKey() {
  return 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function loadConfigFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    config = { ...cloneDeep(DEFAULT_CONFIG), ...stored };
    config.images = { ...DEFAULT_CONFIG.images, ...(stored.images || {}) };
    config.motion = { ...DEFAULT_MOTION, ...(stored.motion || {}) };
    if (!Array.isArray(config.mouthTiers) || config.mouthTiers.length === 0) {
      config.mouthTiers = cloneDeep(DEFAULT_CONFIG.mouthTiers);
    }
  } catch (e) {
    console.warn('Config load failed:', e);
  }
}

let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      setDebug('localStorage 保存失敗: ' + e.message, true);
    }
  }, 200);
}

// Migrate any legacy dataURL entries (from the previous version that stored
// images directly in localStorage) into IndexedDB.
async function migrateLegacyDataURLs() {
  let migrated = false;
  const migrateOne = async (v) => {
    if (typeof v === 'string' && v.startsWith('data:')) {
      const k = newImageKey();
      await idbSet(k, v);
      imageCache[k] = v;
      migrated = true;
      return k;
    }
    return v;
  };
  for (const slot of FIXED_SLOTS) {
    config.images[slot.key] = await migrateOne(config.images[slot.key]);
  }
  for (const tier of config.mouthTiers) {
    for (let i = 0; i < tier.images.length; i++) {
      tier.images[i] = await migrateOne(tier.images[i]);
    }
  }
  if (migrated) {
    // Force a synchronous-ish save now that dataURLs are gone.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); }
    catch (e) { setDebug('migration save failed: ' + e.message, true); }
  }
}

// ============================================================
// DOM refs
// ============================================================
const avatar          = document.getElementById('avatar');
const panel           = document.getElementById('panel');
const panelToggle     = document.getElementById('panel-toggle');
const fixedSlotsDiv   = document.getElementById('fixed-slots');
const mouthTiersDiv   = document.getElementById('mouth-tiers');
const addMouthTierBtn = document.getElementById('addMouthTier');
const volText         = document.getElementById('volText');
const volBar          = document.getElementById('volBar');
const debugDiv        = document.getElementById('debug');
const startMicBtn     = document.getElementById('startMic');

function setDebug(msg, isError) {
  debugDiv.textContent = 'debug: ' + msg;
  debugDiv.classList.toggle('error', !!isError);
}

// ============================================================
// URL params
// ============================================================
const URL_PARAMS = new URLSearchParams(location.search);
const FORCE_SURPRISED = URL_PARAMS.get('surprised') === '1';
const FORCE_HIDE_PANEL = URL_PARAMS.get('panel') === '0';

// ============================================================
// File picker → dataURL
// ============================================================
function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ dataURL: reader.result, name: file.name });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

async function storeNewImage(dataURL) {
  const key = newImageKey();
  await idbSet(key, dataURL);
  imageCache[key] = dataURL;
  return key;
}

async function removeImageByKey(key) {
  if (!key) return;
  try {
    await idbDelete(key);
  } catch (e) {
    // ignore
  }
  delete imageCache[key];
}

// ============================================================
// UI: Fixed image slots
// ============================================================
function buildFixedSlots() {
  fixedSlotsDiv.innerHTML = '';
  for (const slot of FIXED_SLOTS) {
    const row = document.createElement('div');
    row.className = 'image-slot';
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const labelArea = document.createElement('div');
    labelArea.className = 'label-area';
    labelArea.innerHTML =
      `<div class="slot-name">${slot.label}</div>` +
      `<div class="filename"></div>`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'クリア';
    actions.appendChild(clearBtn);

    row.appendChild(thumb);
    row.appendChild(labelArea);
    row.appendChild(actions);
    fixedSlotsDiv.appendChild(row);

    const refreshThumb = () => {
      const key = config.images[slot.key];
      const dataURL = key && imageCache[key];
      if (dataURL) {
        thumb.style.backgroundImage = `url(${dataURL})`;
        thumb.classList.remove('empty');
        labelArea.querySelector('.filename').textContent = '設定済み';
      } else {
        thumb.style.backgroundImage = '';
        thumb.classList.add('empty');
        labelArea.querySelector('.filename').textContent = '未設定（クリックで選択）';
      }
    };

    thumb.addEventListener('click', async () => {
      const result = await pickImageFile();
      if (!result) return;
      const oldKey = config.images[slot.key];
      const newKey = await storeNewImage(result.dataURL);
      config.images[slot.key] = newKey;
      await removeImageByKey(oldKey);
      refreshThumb();
      saveConfig();
    });

    clearBtn.addEventListener('click', async () => {
      const oldKey = config.images[slot.key];
      config.images[slot.key] = null;
      await removeImageByKey(oldKey);
      refreshThumb();
      saveConfig();
    });

    refreshThumb();
  }
}

// ============================================================
// UI: Mouth tiers (variable count)
// ============================================================
function sortMouthTiers() {
  config.mouthTiers.sort((a, b) => a.threshold - b.threshold);
}

function buildMouthTiers() {
  mouthTiersDiv.innerHTML = '';
  sortMouthTiers();
  for (let i = 0; i < config.mouthTiers.length; i++) {
    const tier = config.mouthTiers[i];
    const card = document.createElement('div');
    card.className = 'mouth-tier';

    const header = document.createElement('div');
    header.className = 'mouth-tier-header';
    header.innerHTML =
      `<label>音量 ≥</label>` +
      `<input type="range" min="0" max="100" step="0.5" value="${tier.threshold}">` +
      `<span class="val">${tier.threshold}</span>` +
      `<button class="remove-tier danger">削除</button>`;
    card.appendChild(header);

    const imagesDiv = document.createElement('div');
    imagesDiv.className = 'mouth-tier-images';
    card.appendChild(imagesDiv);
    mouthTiersDiv.appendChild(card);

    const refreshImages = () => {
      imagesDiv.innerHTML = '';
      for (let j = 0; j < tier.images.length; j++) {
        const key = tier.images[j];
        const dataURL = imageCache[key];
        const t = document.createElement('div');
        t.className = 'img-thumb';
        if (dataURL) t.style.backgroundImage = `url(${dataURL})`;
        const x = document.createElement('div');
        x.className = 'remove';
        x.textContent = '×';
        x.title = '削除';
        x.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const removed = tier.images.splice(j, 1)[0];
          await removeImageByKey(removed);
          refreshImages();
          saveConfig();
        });
        t.appendChild(x);
        t.addEventListener('click', async () => {
          const result = await pickImageFile();
          if (!result) return;
          const oldKey = tier.images[j];
          const newKey = await storeNewImage(result.dataURL);
          tier.images[j] = newKey;
          await removeImageByKey(oldKey);
          refreshImages();
          saveConfig();
        });
        imagesDiv.appendChild(t);
      }
      const add = document.createElement('div');
      add.className = 'add-img';
      add.textContent = '+';
      add.title = '画像を追加';
      add.addEventListener('click', async () => {
        const result = await pickImageFile();
        if (!result) return;
        const newKey = await storeNewImage(result.dataURL);
        tier.images.push(newKey);
        refreshImages();
        saveConfig();
      });
      imagesDiv.appendChild(add);
    };
    refreshImages();

    const slider = header.querySelector('input[type=range]');
    const valSpan = header.querySelector('.val');
    slider.addEventListener('input', () => {
      tier.threshold = +slider.value;
      valSpan.textContent = tier.threshold;
      saveConfig();
    });
    slider.addEventListener('change', () => { buildMouthTiers(); });

    header.querySelector('.remove-tier').addEventListener('click', async () => {
      if (config.mouthTiers.length <= 1) { alert('最低1つの口パク段階は必要です'); return; }
      const tierToRemove = config.mouthTiers[i];
      for (const k of tierToRemove.images) await removeImageByKey(k);
      config.mouthTiers.splice(i, 1);
      buildMouthTiers();
      saveConfig();
    });
  }
}

addMouthTierBtn.addEventListener('click', () => {
  sortMouthTiers();
  const last = config.mouthTiers[config.mouthTiers.length - 1];
  const newThr = last ? Math.min(100, last.threshold + 5) : 5;
  config.mouthTiers.push({ threshold: newThr, images: [] });
  buildMouthTiers();
  saveConfig();
});

// ============================================================
// UI: Tabs
// ============================================================
document.querySelectorAll('#panel-tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('#panel-tabs .tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  });
});

// ============================================================
// UI: bind controls
// ============================================================
function bindRange(id, getter, setter, fmt) {
  const el = document.getElementById(id);
  if (!el) return;
  const valSpan = el.parentElement.querySelector('.val');
  const update = () => {
    const v = getter();
    el.value = v;
    if (valSpan) valSpan.textContent = fmt ? fmt(v) : v;
  };
  el.addEventListener('input', () => {
    setter(+el.value);
    if (valSpan) valSpan.textContent = fmt ? fmt(+el.value) : el.value;
    saveConfig();
  });
  update();
}

// Time-based binding: config holds milliseconds, UI displays seconds.
function bindRangeMs(id, getter, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  const valSpan = el.parentElement.querySelector('.val');
  const fmt = (s) => s.toFixed(2) + 's';
  const update = () => {
    const s = getter() / 1000;
    el.value = s;
    if (valSpan) valSpan.textContent = fmt(s);
  };
  el.addEventListener('input', () => {
    const s = +el.value;
    setter(s * 1000);
    if (valSpan) valSpan.textContent = fmt(s);
    saveConfig();
  });
  update();
}

function bindSelect(id, getter, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = getter();
  el.addEventListener('change', () => { setter(el.value); saveConfig(); });
}

function bindCheckbox(id, getter, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.checked = !!getter();
  el.addEventListener('change', () => { setter(el.checked); saveConfig(); });
}

function bindAllControls() {
  bindRange('thr1', () => config.threshold1, v => config.threshold1 = v);
  bindRange('thr2', () => config.threshold2, v => config.threshold2 = v);
  bindRange('thr3', () => config.threshold3, v => config.threshold3 = v);
  bindSelect('surpriseMode', () => config.surpriseMode, v => {
    config.surpriseMode = v;
    volSurprised = false; oneshotUntil = 0; oneshotCooldownUntil = 0;
  });
  bindSelect('surpriseStyle', () => config.surpriseStyle, v => config.surpriseStyle = v);

  // Non-time motion params (numbers, ratios, degrees, etc.)
  const motionPlain = [
    'breathAmpY','swayAmpX',
    'talkTiltMaxDeg','talkTiltLerp',
    'idleLookAmpX',
    'loudPulseMin','loudPulseDelta','loudPulseScale',
    'surpriseHopY',
    'yosomiTiltDeg',
    'sleepyBreathMul',
  ];
  for (const k of motionPlain) {
    bindRange('m_' + k, () => config.motion[k], v => config.motion[k] = v);
  }

  // Time-based motion params (stored as ms, edited as seconds)
  const motionTime = [
    'breathPeriod','swayPeriod',
    'talkTiltPeriod',
    'idleLookPeriod','idleLookDelay',
    'surpriseHopDur',
    'yosomiIntervalMin','yosomiIntervalMax','yosomiDuration',
    'sleepyAfter',
  ];
  for (const k of motionTime) {
    bindRangeMs('m_' + k, () => config.motion[k], v => config.motion[k] = v);
  }

  bindRangeMs('b_blinkMin', () => config.blinkMin, v => config.blinkMin = v);
  bindRangeMs('b_blinkMax', () => config.blinkMax, v => config.blinkMax = v);
  bindRangeMs('b_blinkDuration', () => config.blinkDuration, v => config.blinkDuration = v);
  bindCheckbox('obsMode', () => config.obsMode, v => config.obsMode = v);
}

// ============================================================
// Panel hide/show
// ============================================================
panelToggle.addEventListener('click', () => panel.classList.toggle('hidden'));
function applyPanelInitialState() {
  if (FORCE_SURPRISED || FORCE_HIDE_PANEL || config.obsMode) {
    panel.classList.add('hidden');
  }
}

// ============================================================
// Runtime state
// ============================================================
let currentVolume = 0;
let blinking = false;
let surprised = FORCE_SURPRISED;
let volSurprised = false;
let oneshotUntil = 0;
let oneshotCooldownUntil = 0;
const ONESHOT_HOLD_MS = 600;
const ONESHOT_COOLDOWN_MS = 400;
let lastTalkTime = 0;
let tiltTarget = 0;
let tiltCurrent = 0;
let nextTiltChange = 0;
let loudPulseUntil = 0;
let loudArmed = true;
let yosomiUntil = 0;
let yosomiSide = 'left';
let surpriseStartedAt = 0;
let prevSurprised = false;
let mouthChoiceIndex = 0;
let mouthChoiceTier = -1;

function scheduleBlink() {
  const sleepy = (performance.now() - lastTalkTime) > config.motion.sleepyAfter;
  const base = sleepy ? config.blinkMin * 2 : config.blinkMin;
  const span = sleepy ? config.blinkMax * 1.8 - base : config.blinkMax - config.blinkMin;
  const next = base + Math.random() * Math.max(100, span);
  const closeMs = sleepy ? config.blinkDuration * 1.8 : config.blinkDuration;
  setTimeout(() => {
    blinking = true;
    setTimeout(() => {
      blinking = false;
      scheduleBlink();
    }, closeMs);
  }, next);
}

function pickYosomiSide() {
  const hasLeft  = !!config.images.yosomi_left;
  const hasRight = !!config.images.yosomi_right;
  if (hasLeft && hasRight) return Math.random() < 0.5 ? 'left' : 'right';
  if (hasLeft) return 'left';
  if (hasRight) return 'right';
  return null;
}

function triggerYosomi() {
  const side = pickYosomiSide();
  if (!side) return;
  yosomiSide = side;
  yosomiUntil = performance.now() + config.motion.yosomiDuration;
}

function scheduleYosomi() {
  const m = config.motion;
  const next = m.yosomiIntervalMin + Math.random() * Math.max(100, m.yosomiIntervalMax - m.yosomiIntervalMin);
  setTimeout(() => {
    const now = performance.now();
    const silentDur = now - lastTalkTime;
    if (silentDur > m.idleLookDelay && !surprised && !volSurprised && !FORCE_SURPRISED) {
      triggerYosomi();
    }
    scheduleYosomi();
  }, next);
}

setInterval(() => {
  mouthChoiceIndex = Math.floor(Math.random() * 9973);
}, 220);

// ============================================================
// Keyboard
// ============================================================
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !FORCE_SURPRISED) {
    if (!surprised) surprised = true;
    e.preventDefault();
  }
  if (e.code === 'KeyH') panel.classList.toggle('hidden');
  if (e.code === 'KeyY') triggerYosomi();
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !FORCE_SURPRISED) surprised = false;
});

// ============================================================
// Microphone
// ============================================================
let micStarted = false;
async function startMic() {
  if (micStarted) return;
  try {
    setDebug('getUserMedia呼出中...');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('mediaDevices.getUserMedia が利用不可');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStarted = true;
    setDebug('マイク取得成功');
    if (config.obsMode || FORCE_HIDE_PANEL) panel.classList.add('hidden');

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    let smoothed = 0;
    function tick() {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const raw = Math.min(100, rms * 250);
      smoothed = smoothed * 0.5 + raw * 0.5;
      currentVolume = smoothed;
      volText.textContent = currentVolume.toFixed(1);
      volBar.style.width = currentVolume + '%';

      const now = performance.now();
      if (currentVolume > config.threshold1) lastTalkTime = now;

      const m = config.motion;
      const loudThr = Math.max(config.threshold2 + m.loudPulseDelta, m.loudPulseMin);
      if (currentVolume > loudThr && loudArmed && now > loudPulseUntil) {
        loudPulseUntil = now + m.loudPulseDur;
        loudArmed = false;
      }
      if (currentVolume < config.threshold2 * m.loudPulseRearm) loudArmed = true;

      if (config.surpriseMode === 'hold') {
        volSurprised = currentVolume > config.threshold3;
      } else if (config.surpriseMode === 'oneshot') {
        if (currentVolume > config.threshold3 && now > oneshotCooldownUntil && now > oneshotUntil) {
          oneshotUntil = now + ONESHOT_HOLD_MS;
          oneshotCooldownUntil = oneshotUntil + ONESHOT_COOLDOWN_MS;
        }
        volSurprised = now < oneshotUntil;
      } else {
        volSurprised = false;
      }

      requestAnimationFrame(tick);
    }
    tick();
  } catch (err) {
    setDebug(err.name + ': ' + err.message, true);
  }
}
startMicBtn.addEventListener('click', startMic);

// ============================================================
// Image selection per frame
// ============================================================
function urlOf(key) {
  return (key && imageCache[key]) || null;
}

function pickMouthTierImage() {
  let selectedTierIdx = -1;
  for (let i = 0; i < config.mouthTiers.length; i++) {
    const t = config.mouthTiers[i];
    if (t.threshold <= currentVolume && t.images.some(k => imageCache[k])) {
      selectedTierIdx = i;
    }
  }
  if (selectedTierIdx < 0) return null;
  if (selectedTierIdx !== mouthChoiceTier) {
    mouthChoiceTier = selectedTierIdx;
    mouthChoiceIndex = Math.floor(Math.random() * 9973);
  }
  const tier = config.mouthTiers[selectedTierIdx];
  const validKeys = tier.images.filter(k => imageCache[k]);
  return validKeys[mouthChoiceIndex % validKeys.length] || null;
}

function pickImageForState(now) {
  const isSurprised = surprised || volSurprised;
  if (isSurprised) return urlOf(config.images.surprised) || urlOf(config.images.normal);
  if (blinking)    return urlOf(config.images.close)     || urlOf(config.images.normal);
  if (currentVolume < config.threshold1) {
    if (now < yosomiUntil) {
      const key = yosomiSide === 'right' ? config.images.yosomi_right : config.images.yosomi_left;
      return urlOf(key) || urlOf(config.images.normal);
    }
    return urlOf(config.images.normal);
  }
  const tierKey = pickMouthTierImage();
  if (tierKey) return urlOf(tierKey);
  return urlOf(config.images.normal);
}

// ============================================================
// Render loop
// ============================================================
let lastSrc = '';
function render(now) {
  const m = config.motion;
  const isSurprised = surprised || volSurprised;

  const src = pickImageForState(now);
  if (src && src !== lastSrc) {
    avatar.src = src;
    lastSrc = src;
  } else if (!src && lastSrc) {
    avatar.removeAttribute('src');
    lastSrc = '';
  }

  if (isSurprised && !prevSurprised) surpriseStartedAt = now;
  prevSurprised = isSurprised;

  const isTalking = currentVolume > config.threshold1;
  const silentDur = now - lastTalkTime;
  const isSleepy = silentDur > m.sleepyAfter;

  const breathMul = isSleepy ? m.sleepyBreathMul : 1;
  const breathY = Math.sin((now / m.breathPeriod) * Math.PI * 2) * m.breathAmpY * breathMul;
  const swayX = Math.sin((now / m.swayPeriod) * Math.PI * 2) * m.swayAmpX;

  if (isTalking) {
    if (now > nextTiltChange) {
      tiltTarget = (Math.random() - 0.5) * 2 * m.talkTiltMaxDeg;
      nextTiltChange = now + m.talkTiltPeriod * (0.7 + Math.random() * 0.6);
    }
  } else if (now < yosomiUntil) {
    tiltTarget = (yosomiSide === 'right' ? +1 : -1) * Math.abs(m.yosomiTiltDeg);
  } else {
    tiltTarget = 0;
  }
  tiltCurrent += (tiltTarget - tiltCurrent) * m.talkTiltLerp;

  let idleLookX = 0;
  if (!isTalking && silentDur > m.idleLookDelay) {
    const fadeIn = Math.min(1, (silentDur - m.idleLookDelay) / m.idleLookFadeIn);
    idleLookX = Math.sin((now / m.idleLookPeriod) * Math.PI * 2) * m.idleLookAmpX * fadeIn;
  }

  let loudScale = 1;
  if (now < loudPulseUntil) {
    const remain = (loudPulseUntil - now) / m.loudPulseDur;
    loudScale = 1 + m.loudPulseScale * remain;
  }

  let surpriseY = 0, surpriseScale = 1, surpriseRot = 0;
  if (isSurprised) {
    const elapsed = now - surpriseStartedAt;
    const t = Math.min(1, elapsed / m.surpriseHopDur);
    const curve = Math.sin(t * Math.PI);
    if (config.surpriseStyle === 'recoil') {
      surpriseY = curve * m.surpriseHopY * 0.35;
      surpriseScale = 1 - curve * 0.05;
    } else {
      surpriseY = -curve * m.surpriseHopY;
      surpriseScale = 1 + curve * 0.04;
    }
    if (elapsed > m.surpriseHopDur) surpriseRot = Math.sin(now / 35) * 0.8;
  }

  const tx = swayX + idleLookX;
  const ty = breathY + surpriseY;
  const finalScale = surpriseScale * loudScale;
  const finalRot = surpriseRot + tiltCurrent;
  avatar.style.transform =
    `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) ` +
    `scale(${finalScale.toFixed(3)}) ` +
    `rotate(${finalRot.toFixed(2)}deg)`;

  requestAnimationFrame(render);
}

// ============================================================
// Config tab buttons (reset / export / import)
// ============================================================
document.getElementById('resetDefaults').addEventListener('click', async () => {
  if (!confirm('全ての設定（画像含む）をデフォルトに戻します。よろしいですか？')) return;
  localStorage.removeItem(STORAGE_KEY);
  try { await idbClear(); } catch (e) {}
  location.reload();
});

// Export: include image dataURLs inline so the JSON is fully portable
document.getElementById('exportConfig').addEventListener('click', () => {
  // Build a config copy where image-key references are replaced with dataURLs
  const exportConfig = cloneDeep(config);
  const resolve = (k) => (k && imageCache[k]) ? imageCache[k] : null;
  for (const slot of FIXED_SLOTS) {
    exportConfig.images[slot.key] = resolve(exportConfig.images[slot.key]);
  }
  for (const tier of exportConfig.mouthTiers) {
    tier.images = tier.images.map(resolve).filter(Boolean);
  }
  const blob = new Blob([JSON.stringify(exportConfig, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'peraravatar-config.json';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('importConfig').addEventListener('click', () => {
  document.getElementById('importFile').click();
});
document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);
      if (typeof imported !== 'object' || !imported) throw new Error('JSON が不正です');
      const next = { ...cloneDeep(DEFAULT_CONFIG), ...imported };
      next.images = { ...DEFAULT_CONFIG.images, ...(imported.images || {}) };
      next.motion = { ...DEFAULT_MOTION, ...(imported.motion || {}) };
      // Reset existing image store and load all dataURLs from the JSON
      await idbClear();
      imageCache = {};
      const importOne = async (v) => {
        if (typeof v === 'string' && v.startsWith('data:')) {
          const k = newImageKey();
          await idbSet(k, v);
          imageCache[k] = v;
          return k;
        }
        return null;
      };
      for (const slot of FIXED_SLOTS) {
        next.images[slot.key] = await importOne(next.images[slot.key]);
      }
      if (Array.isArray(next.mouthTiers)) {
        for (const tier of next.mouthTiers) {
          if (!Array.isArray(tier.images)) tier.images = [];
          const newKeys = [];
          for (const v of tier.images) {
            const k = await importOne(v);
            if (k) newKeys.push(k);
          }
          tier.images = newKeys;
        }
      }
      config = next;
      saveConfig();
      location.reload();
    } catch (err) {
      alert('読み込み失敗: ' + err.message);
    }
  };
  reader.readAsText(file);
});

// ============================================================
// Initialize (async)
// ============================================================
async function init() {
  loadConfigFromStorage();
  try {
    await migrateOldIndexedDB();
    imageCache = await idbGetAll();
  } catch (e) {
    setDebug('IndexedDB 初期化失敗: ' + e.message, true);
  }
  // Migrate legacy dataURLs from localStorage config into IndexedDB
  await migrateLegacyDataURLs();

  buildFixedSlots();
  buildMouthTiers();
  bindAllControls();
  applyPanelInitialState();

  setDebug('protocol=' + location.protocol + ' mediaDevices=' + (navigator.mediaDevices ? 'OK' : 'undefined'),
           !navigator.mediaDevices);

  scheduleBlink();
  scheduleYosomi();
  requestAnimationFrame(render);

  // Try auto-mic after slight delay (works in OBS with --use-fake-ui-for-media-stream)
  setTimeout(startMic, 300);
}

init();
