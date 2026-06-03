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
  loudPulseScale: 0.005,
  loudPulseDur: 260,
  loudPulseRearm: 0.5,
  sleepyAfter: 30000,
  sleepyBreathMul: 0.5,
  fullAsleepAfter: 90000, // total silence ms until eyes stay closed permanently
  yosomiIntervalMin: 7000,
  yosomiIntervalMax: 15000,
  yosomiDuration: 1500,
  yosomiTiltDeg: 3,
  // Custom-expression animation parameters
  recoilFactor: 0.35,
  shakeAmp: 3.5,
  bounceAmp: 6,
  bounceSpeed: 180,    // ms divisor for sin (smaller = faster)
  wobbleAmp: 9,
  wobbleSpeed: 350,
  wobbleRot: 3,
  nodAmp: 5,
  nodSpeed: 230,
  nodRot: 1,
  headshakeAmp: 7,
  headshakeSpeed: 110,
  headshakeRot: 3,
};

const FIXED_SLOTS = [
  { key: 'normal',      label: '通常' },
  { key: 'close',       label: '瞬き(閉眼)' },
  { key: 'yosomi_left', label: 'よそ見(左)' },
  { key: 'yosomi_right',label: 'よそ見(右)' },
];

// In the config, every image reference is a string that can be either:
//   - an IndexedDB key like "img_xxx" (user-uploaded images)
//   - a relative path like "examples/sample_normal.png" (bundled defaults)
//   - null (unset)
// `urlOf(ref)` resolves either form to a URL usable as an <img src>.
const DEFAULT_CONFIG = {
  images: {
    normal:       'examples/sample_normal.png',
    close:        'examples/sample_close.png',
    yosomi_left:  'examples/sample_left.png',
    yosomi_right: 'examples/sample_right.png',
  },
  mouthTiers: [
    { threshold: 5,  images: ['examples/sample_mouth_o.png'] },
    { threshold: 18, images: ['examples/sample_mouth_i.png'] },
    { threshold: 25, images: ['examples/sample_mouth_a.png'] },
  ],
  // User-defined expressions triggered by hotkeys or volume.
  // Held while the key is down. Optionally fires when volume exceeds threshold.
  // Each: { id, label, imageKey, hotkey (e.code), animation, volumeMode, volumeThreshold }
  //   volumeMode: 'off' (default) | 'oneshot' | 'hold'
  customExpressions: [
    { id: 'default_surprise', label: 'びっくり', imageKey: 'examples/sample_surprised.png', hotkey: 'KeyZ', animation: 'recoil', volumeMode: 'hold', volumeThreshold: 90, volumePatterns: [], volumePatternThreshold: 0.75 },
    { id: 'default_smile',    label: '笑い',     imageKey: 'examples/sample_smile.png',     hotkey: 'KeyX', animation: 'bounce', volumeMode: 'off',     volumeThreshold: 60, volumePatterns: [], volumePatternThreshold: 0.75 },
    { id: 'default_cry',      label: '泣き',     imageKey: 'examples/sample_cry.png',       hotkey: 'KeyC', animation: 'shake',  volumeMode: 'off',     volumeThreshold: 60, volumePatterns: [], volumePatternThreshold: 0.75 },
  ],
  threshold1: 5,
  motion: { ...DEFAULT_MOTION },
  blinkMin: 2000,
  blinkMax: 5000,
  blinkDuration: 150,
  obsMode: false,
  // Background for verifying image transparency.
  // mode: 'transparent' | 'checker' | 'color'
  backgroundMode: 'transparent',
  backgroundColor: '#88c0d0',
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
    if (!Array.isArray(config.customExpressions)) {
      config.customExpressions = cloneDeep(DEFAULT_CONFIG.customExpressions);
    }
    // Migrate legacy single-pattern field to plural patterns array.
    for (const exp of config.customExpressions) {
      if (!Array.isArray(exp.volumePatterns)) {
        exp.volumePatterns = (Array.isArray(exp.volumePattern) && exp.volumePattern.length === PATTERN_LENGTH)
          ? [exp.volumePattern]
          : [];
      }
      delete exp.volumePattern;
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
const customExpressionsDiv = document.getElementById('custom-expressions');
const addCustomExpressionBtn = document.getElementById('addCustomExpression');
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
// ?custom=<hotkey hint> e.g. ?custom=z forces the expression bound to Z
// (or by label/id if no key match). Computed lazily after config loads.
const FORCE_CUSTOM_HINT = URL_PARAMS.get('custom');
const FORCE_HIDE_PANEL = URL_PARAMS.get('panel') === '0';
let forcedExpressionId = null; // populated in init() once customExpressions known

function hotkeyHintToCode(hint) {
  if (!hint) return null;
  const s = String(hint).trim().toLowerCase();
  if (!s) return null;
  if (s === 'space') return 'Space';
  if (s === 'escape' || s === 'esc') return 'Escape';
  if (/^[a-z]$/.test(s)) return 'Key' + s.toUpperCase();
  if (/^[0-9]$/.test(s)) return 'Digit' + s;
  return s; // pass through unchanged for advanced users (e.g. 'F1')
}

function resolveForcedExpression(hint) {
  if (!hint) return null;
  const code = hotkeyHintToCode(hint);
  // Try matching by hotkey code first
  let exp = config.customExpressions.find(e => e.hotkey === code);
  if (exp) return exp;
  // Fallback: by id
  exp = config.customExpressions.find(e => e.id === hint);
  if (exp) return exp;
  // Fallback: by label (case-insensitive)
  const lower = String(hint).toLowerCase();
  exp = config.customExpressions.find(e => (e.label || '').toLowerCase() === lower);
  return exp || null;
}

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
  try {
    await idbSet(key, dataURL);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    const isQuota = e && (e.name === 'QuotaExceededError' ||
                         /quota|storage/i.test(msg));
    if (isQuota) {
      const friendly = 'ブラウザのストレージ容量を超えました。\n' +
        '・既存の画像をいくつか削除する\n' +
        '・「設定」タブの「JSONで書き出し」でバックアップ→「デフォルトに戻す」でリセット\n' +
        '・登録する画像のファイルサイズを小さくする (PNGを縮小・JPEG化など)\n' +
        'のいずれかをお試しください。';
      setDebug('ストレージ容量超過: ' + msg, true);
      alert(friendly);
    } else {
      setDebug('画像保存失敗: ' + msg, true);
      alert('画像の保存に失敗しました: ' + msg);
    }
    throw e;
  }
  imageCache[key] = dataURL;
  return key;
}

async function removeImageByKey(key) {
  if (!key || typeof key !== 'string') return;
  if (!key.startsWith('img_')) return; // path-based reference, nothing to delete in IDB
  try { await idbDelete(key); } catch (e) { /* ignore */ }
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
      const url = urlOf(config.images[slot.key]);
      if (url) {
        thumb.style.backgroundImage = `url(${url})`;
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
// UI: Custom expressions
// ============================================================
function newExpressionId() {
  return 'exp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function keyCodeLabel(code) {
  if (!code) return '(未設定)';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'N' + code.slice(6);
  return code;
}

const RESERVED_KEYS_FOR_CUSTOM = new Set(['KeyH', 'KeyY']);

const ANIMATION_OPTIONS = [
  { value: 'none',      label: '動かない' },
  { value: 'hop',       label: 'ホップ（上に跳ねる）' },
  { value: 'recoil',    label: 'リコイル（後ろに引く）' },
  { value: 'shake',     label: '震える（細かく揺れる）' },
  { value: 'bounce',    label: 'バウンス（軽く上下に弾む）' },
  { value: 'wobble',    label: 'ゆらゆら（左右に揺れる）' },
  { value: 'nod',       label: 'うなずく（縦に振る）' },
  { value: 'headshake', label: '首を振る（横に振る）' },
];
// Preferred default hotkey order for newly added custom expressions
const AUTO_HOTKEY_CANDIDATES = [
  'KeyZ','KeyX','KeyC','KeyV','KeyB','KeyN','KeyM',
  'KeyA','KeyS','KeyD','KeyF','KeyG',
  'Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0',
];

function nextAvailableHotkey() {
  const used = new Set(config.customExpressions.map(e => e.hotkey).filter(Boolean));
  used.add('KeyH'); used.add('KeyY');
  for (const k of AUTO_HOTKEY_CANDIDATES) {
    if (!used.has(k)) return k;
  }
  return null;
}

let keyCaptureTarget = null; // expression id currently in hotkey-capture mode
let keyCaptureButton = null;

function buildCustomExpressions() {
  customExpressionsDiv.innerHTML = '';
  for (let i = 0; i < config.customExpressions.length; i++) {
    const exp = config.customExpressions[i];
    const card = document.createElement('div');
    card.className = 'expression-card';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';

    const body = document.createElement('div');
    body.className = 'body';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'exp-label';
    labelInput.placeholder = '名前（例: 笑い）';
    labelInput.value = exp.label || '';

    const hotkeyRow = document.createElement('div');
    hotkeyRow.className = 'hotkey-row';
    const hotkeyBtn = document.createElement('button');
    hotkeyBtn.className = 'hotkey-btn';
    hotkeyBtn.textContent = keyCodeLabel(exp.hotkey);
    hotkeyBtn.title = 'クリックしてキーを割り当て（押している間だけ表示）';
    const animSelect = document.createElement('select');
    animSelect.className = 'anim-select';
    for (const opt of ANIMATION_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      animSelect.appendChild(o);
    }
    animSelect.value = exp.animation || 'none';
    hotkeyRow.appendChild(hotkeyBtn);
    hotkeyRow.appendChild(animSelect);

    // Volume trigger - mode select (own row so the long labels are readable)
    const volModeRow = document.createElement('div');
    volModeRow.className = 'hotkey-row';
    const volModeLabel = document.createElement('span');
    volModeLabel.style.cssText = 'font-size:10px;color:#888;flex:0 0 auto;';
    volModeLabel.textContent = '音量発火:';
    const volModeSelect = document.createElement('select');
    volModeSelect.className = 'anim-select';
    volModeSelect.title = '音量がしきい値を超えた時の挙動';
    for (const [v, lbl] of [
      ['off', '発火しない'],
      ['oneshot', '超えた瞬間に一度だけ（1秒）'],
      ['hold', '超えてる間ずっと'],
    ]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = lbl;
      volModeSelect.appendChild(o);
    }
    volModeSelect.value = exp.volumeMode || 'off';
    volModeRow.appendChild(volModeLabel);
    volModeRow.appendChild(volModeSelect);

    // Volume trigger - threshold row (slider + number, hidden when mode = off)
    const volThrRow = document.createElement('div');
    volThrRow.className = 'hotkey-row';
    const volThrLabel = document.createElement('span');
    volThrLabel.style.cssText = 'font-size:10px;color:#888;flex:0 0 auto;';
    volThrLabel.textContent = '発火音量:';
    const volThresholdSlider = document.createElement('input');
    volThresholdSlider.type = 'range';
    volThresholdSlider.min = '0';
    volThresholdSlider.max = '100';
    volThresholdSlider.step = '1';
    volThresholdSlider.value = exp.volumeThreshold != null ? exp.volumeThreshold : 60;
    volThresholdSlider.style.flex = '1';
    volThresholdSlider.style.minWidth = '40px';
    const volThresholdInput = document.createElement('input');
    volThresholdInput.type = 'number';
    volThresholdInput.className = 'val';
    volThresholdInput.min = '0';
    volThresholdInput.max = '100';
    volThresholdInput.step = '1';
    volThresholdInput.value = exp.volumeThreshold != null ? exp.volumeThreshold : 60;
    volThresholdInput.title = '音量がこの値を超えると発火';
    volThrRow.appendChild(volThrLabel);
    volThrRow.appendChild(volThresholdSlider);
    volThrRow.appendChild(volThresholdInput);
    volThrRow.style.display = (volModeSelect.value === 'off') ? 'none' : '';

    // Volume pattern row
    const patternRow = document.createElement('div');
    patternRow.className = 'hotkey-row';
    patternRow.style.flexWrap = 'wrap';
    const patternLabel = document.createElement('span');
    patternLabel.style.cssText = 'font-size:10px;color:#888;flex:0 0 auto;';
    patternLabel.textContent = '音声パターン:';
    const recordBtn = document.createElement('button');
    recordBtn.className = 'record-btn';
    recordBtn.textContent = '🎤 録音追加';
    recordBtn.title = '2.5秒間の音声パターンを記録。複数登録可、どれか一致で発火';
    const patternStatus = document.createElement('span');
    patternStatus.className = 'pattern-status';
    patternStatus.style.cssText = 'font-size:10px;color:#aaa;flex:0 0 auto;';
    const patternList = document.createElement('span');
    patternList.className = 'pattern-list';
    patternList.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;flex:1;';
    patternRow.appendChild(patternLabel);
    patternRow.appendChild(recordBtn);
    patternRow.appendChild(patternStatus);
    patternRow.appendChild(patternList);

    function refreshPatternList() {
      patternList.innerHTML = '';
      const patterns = Array.isArray(exp.volumePatterns) ? exp.volumePatterns : [];
      patternStatus.textContent = patterns.length > 0 ? `${patterns.length}個` : '未記録';
      for (let pi = 0; pi < patterns.length; pi++) {
        const del = document.createElement('button');
        del.className = 'danger';
        del.textContent = `#${pi + 1} ×`;
        del.title = `パターン ${pi + 1} を削除`;
        del.style.cssText = 'padding:1px 5px;font-size:10px;margin:0;';
        const idx = pi;
        del.addEventListener('click', () => {
          exp.volumePatterns.splice(idx, 1);
          delete patternCooldowns[exp.id];
          saveConfig();
          refreshPatternList();
          sensRow.style.display = exp.volumePatterns.length > 0 ? '' : 'none';
        });
        patternList.appendChild(del);
      }
    }
    refreshPatternList();

    // Sensitivity row (only show when at least one pattern is recorded)
    const sensRow = document.createElement('div');
    sensRow.className = 'hotkey-row';
    sensRow.style.display = (Array.isArray(exp.volumePatterns) && exp.volumePatterns.length > 0) ? '' : 'none';
    const sensLabel = document.createElement('span');
    sensLabel.style.cssText = 'font-size:10px;color:#888;flex:0 0 auto;';
    sensLabel.textContent = '感度:';
    const sensSlider = document.createElement('input');
    sensSlider.type = 'range';
    sensSlider.min = '0.3';
    sensSlider.max = '0.95';
    sensSlider.step = '0.05';
    sensSlider.value = (exp.volumePatternThreshold != null) ? exp.volumePatternThreshold : 0.75;
    sensSlider.style.flex = '1';
    sensSlider.style.minWidth = '40px';
    const sensInput = document.createElement('input');
    sensInput.type = 'number';
    sensInput.className = 'val';
    sensInput.min = '0.3';
    sensInput.max = '0.95';
    sensInput.step = '0.05';
    sensInput.value = (+sensSlider.value).toFixed(2);
    sensRow.appendChild(sensLabel);
    sensRow.appendChild(sensSlider);
    sensRow.appendChild(sensInput);

    body.appendChild(labelInput);
    body.appendChild(hotkeyRow);
    body.appendChild(volModeRow);
    body.appendChild(volThrRow);
    body.appendChild(patternRow);
    body.appendChild(sensRow);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-exp danger';
    removeBtn.textContent = '削除';

    card.appendChild(thumb);
    card.appendChild(body);
    card.appendChild(removeBtn);
    customExpressionsDiv.appendChild(card);

    const refreshThumb = () => {
      const url = urlOf(exp.imageKey);
      if (url) {
        thumb.style.backgroundImage = `url(${url})`;
        thumb.classList.remove('empty');
      } else {
        thumb.style.backgroundImage = '';
        thumb.classList.add('empty');
      }
    };
    refreshThumb();

    thumb.addEventListener('click', async () => {
      const result = await pickImageFile();
      if (!result) return;
      const oldKey = exp.imageKey;
      const newKey = await storeNewImage(result.dataURL);
      exp.imageKey = newKey;
      await removeImageByKey(oldKey);
      refreshThumb();
      saveConfig();
    });

    labelInput.addEventListener('input', () => {
      exp.label = labelInput.value;
      saveConfig();
    });

    animSelect.addEventListener('change', () => {
      exp.animation = animSelect.value;
      saveConfig();
    });

    volModeSelect.addEventListener('change', () => {
      exp.volumeMode = volModeSelect.value;
      volThrRow.style.display = (volModeSelect.value === 'off') ? 'none' : '';
      saveConfig();
    });

    volThresholdSlider.addEventListener('input', () => {
      const v = +volThresholdSlider.value;
      exp.volumeThreshold = v;
      volThresholdInput.value = v;
      saveConfig();
    });
    volThresholdInput.addEventListener('input', () => {
      let v = +volThresholdInput.value;
      if (Number.isNaN(v)) return;
      v = Math.max(0, Math.min(100, v));
      exp.volumeThreshold = v;
      volThresholdSlider.value = v;
      saveConfig();
    });

    recordBtn.addEventListener('click', async () => {
      const result = await recordVolumePattern(exp, recordBtn);
      if (result) {
        refreshPatternList();
        sensRow.style.display = '';
      }
    });

    sensSlider.addEventListener('input', () => {
      const v = +sensSlider.value;
      exp.volumePatternThreshold = v;
      sensInput.value = v.toFixed(2);
      saveConfig();
    });
    sensInput.addEventListener('input', () => {
      let v = +sensInput.value;
      if (Number.isNaN(v)) return;
      v = Math.max(0.3, Math.min(0.95, v));
      exp.volumePatternThreshold = v;
      sensSlider.value = v;
      saveConfig();
    });

    hotkeyBtn.addEventListener('click', () => {
      if (keyCaptureButton) {
        keyCaptureButton.classList.remove('capturing');
        keyCaptureButton.textContent = keyCodeLabel(
          (config.customExpressions.find(e => e.id === keyCaptureTarget) || {}).hotkey
        );
      }
      keyCaptureTarget = exp.id;
      keyCaptureButton = hotkeyBtn;
      hotkeyBtn.classList.add('capturing');
      hotkeyBtn.textContent = '...';
    });

    removeBtn.addEventListener('click', async () => {
      if (exp.imageKey) await removeImageByKey(exp.imageKey);
      delete volumeOneshotStates[exp.id];
      config.customExpressions.splice(i, 1);
      buildCustomExpressions();
      saveConfig();
    });
  }
}

addCustomExpressionBtn.addEventListener('click', () => {
  config.customExpressions.push({
    id: newExpressionId(),
    label: '',
    imageKey: null,
    hotkey: nextAvailableHotkey(),
    animation: 'none',
    volumeMode: 'off',
    volumeThreshold: 60,
    volumePatterns: [],
    volumePatternThreshold: 0.75,
  });
  buildCustomExpressions();
  saveConfig();
});

async function recordVolumePattern(exp, btn) {
  if (!micStarted) {
    alert('先にマイク許可ボタンを押してください');
    return null;
  }
  btn.disabled = true;
  const origLabel = btn.textContent;
  for (let i = 3; i > 0; i--) {
    btn.textContent = `${i}…`;
    await new Promise(r => setTimeout(r, 1000));
  }
  btn.textContent = '🔴 録音中';
  btn.classList.add('recording');
  const samples = new Array(PATTERN_LENGTH);
  for (let i = 0; i < PATTERN_LENGTH; i++) {
    samples[i] = currentVolume;
    await new Promise(r => setTimeout(r, PATTERN_SAMPLE_MS));
  }
  if (!Array.isArray(exp.volumePatterns)) exp.volumePatterns = [];
  exp.volumePatterns.push(samples);
  saveConfig();
  btn.classList.remove('recording');
  btn.disabled = false;
  btn.textContent = origLabel;
  return samples;
}

function cancelKeyCapture() {
  if (keyCaptureButton) {
    const exp = config.customExpressions.find(e => e.id === keyCaptureTarget);
    keyCaptureButton.classList.remove('capturing');
    keyCaptureButton.textContent = keyCodeLabel(exp ? exp.hotkey : null);
  }
  keyCaptureTarget = null;
  keyCaptureButton = null;
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

    // Coerce to number to prevent any HTML injection via imported config.
    const safeThr = Number(tier.threshold);
    const thrVal = Number.isFinite(safeThr) ? safeThr : 0;
    const header = document.createElement('div');
    header.className = 'mouth-tier-header';
    header.innerHTML =
      `<label>音量 ≥</label>` +
      `<input type="range" min="0" max="100" step="0.5" value="${thrVal}">` +
      `<input type="number" class="val" min="0" max="100" step="0.5" value="${thrVal}">` +
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
        const url = urlOf(key);
        const t = document.createElement('div');
        t.className = 'img-thumb';
        if (url) t.style.backgroundImage = `url(${url})`;
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
    const valInput = header.querySelector('input[type=number].val');
    slider.addEventListener('input', () => {
      tier.threshold = +slider.value;
      valInput.value = tier.threshold;
      saveConfig();
    });
    slider.addEventListener('change', () => { buildMouthTiers(); });
    valInput.addEventListener('input', () => {
      let v = +valInput.value;
      if (Number.isNaN(v)) return;
      v = Math.max(0, Math.min(100, v));
      tier.threshold = v;
      slider.value = v;
      saveConfig();
    });
    valInput.addEventListener('change', () => { buildMouthTiers(); });

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
// Helpers for the optional value display element which may be either a
// <span> (read-only) or an <input type="number"> (editable).
function setValDisplay(valEl, text, numericValue) {
  if (!valEl) return;
  if (valEl.tagName === 'INPUT') valEl.value = numericValue;
  else valEl.textContent = text;
}

function bindRange(id, getter, setter, fmt) {
  const el = document.getElementById(id);
  if (!el) return;
  const valEl = el.parentElement.querySelector('.val');
  if (valEl && valEl.tagName === 'INPUT') {
    valEl.min = el.min;
    valEl.max = el.max;
    valEl.step = el.step;
  }
  const update = () => {
    const v = getter();
    el.value = v;
    setValDisplay(valEl, fmt ? fmt(v) : v, v);
  };
  el.addEventListener('input', () => {
    const v = +el.value;
    setter(v);
    setValDisplay(valEl, fmt ? fmt(v) : el.value, v);
    saveConfig();
  });
  if (valEl && valEl.tagName === 'INPUT') {
    valEl.addEventListener('input', () => {
      let v = +valEl.value;
      if (Number.isNaN(v)) return;
      const minV = +el.min, maxV = +el.max;
      if (!Number.isNaN(minV)) v = Math.max(minV, v);
      if (!Number.isNaN(maxV)) v = Math.min(maxV, v);
      el.value = v;
      setter(v);
      saveConfig();
    });
  }
  update();
}

// Time-based binding: config holds milliseconds, UI displays seconds.
function bindRangeMs(id, getter, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  const valEl = el.parentElement.querySelector('.val');
  const fmt = (s) => s.toFixed(2) + 's';
  if (valEl && valEl.tagName === 'INPUT') {
    valEl.min = el.min;
    valEl.max = el.max;
    valEl.step = el.step;
  }
  const update = () => {
    const s = getter() / 1000;
    el.value = s;
    setValDisplay(valEl, fmt(s), +s.toFixed(2));
  };
  el.addEventListener('input', () => {
    const s = +el.value;
    setter(s * 1000);
    setValDisplay(valEl, fmt(s), +s.toFixed(2));
    saveConfig();
  });
  if (valEl && valEl.tagName === 'INPUT') {
    valEl.addEventListener('input', () => {
      let s = +valEl.value;
      if (Number.isNaN(s)) return;
      const minV = +el.min, maxV = +el.max;
      if (!Number.isNaN(minV)) s = Math.max(minV, s);
      if (!Number.isNaN(maxV)) s = Math.min(maxV, s);
      el.value = s;
      setter(s * 1000);
      saveConfig();
    });
  }
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

  // Non-time motion params (numbers, ratios, degrees, etc.)
  const motionPlain = [
    'breathAmpY','swayAmpX',
    'talkTiltMaxDeg','talkTiltLerp',
    'idleLookAmpX',
    'loudPulseMin','loudPulseScale',
    'yosomiTiltDeg',
    'sleepyBreathMul',
    // Custom-expression animation params
    'surpriseHopY',
    'recoilFactor',
    'shakeAmp',
    'bounceAmp','bounceSpeed',
    'wobbleAmp','wobbleSpeed','wobbleRot',
    'nodAmp','nodSpeed','nodRot',
    'headshakeAmp','headshakeSpeed','headshakeRot',
  ];
  for (const k of motionPlain) {
    bindRange('m_' + k, () => config.motion[k], v => config.motion[k] = v);
  }

  // Time-based motion params (stored as ms, edited as seconds)
  const motionTime = [
    'breathPeriod','swayPeriod',
    'talkTiltPeriod',
    'idleLookPeriod','idleLookDelay',
    'yosomiIntervalMin','yosomiIntervalMax','yosomiDuration',
    'sleepyAfter','fullAsleepAfter',
    'surpriseHopDur',
  ];
  for (const k of motionTime) {
    bindRangeMs('m_' + k, () => config.motion[k], v => config.motion[k] = v);
  }

  bindRangeMs('b_blinkMin', () => config.blinkMin, v => config.blinkMin = v);
  bindRangeMs('b_blinkMax', () => config.blinkMax, v => config.blinkMax = v);
  bindRangeMs('b_blinkDuration', () => config.blinkDuration, v => config.blinkDuration = v);
  bindCheckbox('obsMode', () => config.obsMode, v => config.obsMode = v);

  // Background mode (transparent / checker / color)
  const bgModeSel = document.getElementById('backgroundMode');
  const bgColorInput = document.getElementById('backgroundColor');
  const bgColorRow = document.getElementById('backgroundColorRow');
  if (bgModeSel && bgColorInput && bgColorRow) {
    bgModeSel.value = config.backgroundMode || 'transparent';
    bgColorInput.value = config.backgroundColor || '#88c0d0';
    const refreshBgUI = () => {
      bgColorRow.style.display = (config.backgroundMode === 'color') ? '' : 'none';
    };
    applyBackground();
    refreshBgUI();
    bgModeSel.addEventListener('change', () => {
      config.backgroundMode = bgModeSel.value;
      saveConfig();
      applyBackground();
      refreshBgUI();
    });
    bgColorInput.addEventListener('input', () => {
      config.backgroundColor = bgColorInput.value;
      saveConfig();
      if (config.backgroundMode === 'color') applyBackground();
    });
  }
}

function applyBackground() {
  document.body.classList.remove('bg-checker');
  if (config.backgroundMode === 'checker') {
    document.body.style.backgroundColor = '';
    document.body.classList.add('bg-checker');
  } else if (config.backgroundMode === 'color') {
    document.body.style.backgroundColor = config.backgroundColor || '#88c0d0';
  } else {
    document.body.style.backgroundColor = '';
  }
}

// ============================================================
// Panel hide/show
// ============================================================
panelToggle.addEventListener('click', () => panel.classList.toggle('hidden'));
function applyPanelInitialState() {
  if (forcedExpressionId || FORCE_HIDE_PANEL || config.obsMode) {
    panel.classList.add('hidden');
  }
}

// ============================================================
// Runtime state
// ============================================================
let currentVolume = 0;
let blinking = false;
let lastTalkTime = 0;
let tiltTarget = 0;
let tiltCurrent = 0;
let nextTiltChange = 0;
let loudPulseUntil = 0;
let loudArmed = true;
let yosomiUntil = 0;
let yosomiSide = 'left';
let mouthChoiceIndex = 0;
let mouthChoiceTier = -1;
let mouthTierLastChangedAt = 0;
const MOUTH_TIER_DOWNGRADE_HOLD_MS = 150; // prevent rapid drop-to-lower-tier flicker
let lastRawLoudTime = 0; // last time the *raw* (un-smoothed) volume exceeded threshold1
const QUICK_CLOSE_MS = 50; // if raw is silent for this long, force-close the mouth

// Active expression state. May be set by keyboard (held) or by volume detection.
let activeCustomExpressionId = null;
let activeExpressionStartedAt = 0;     // for animations that need elapsed time
let activeExpressionAnimation = null;  // cached animation name
let keyboardHeldExpressionId = null;   // ID held down by keyboard
const volumeOneshotStates = {};        // expressionId -> { until, cooldownUntil }
const ONESHOT_HOLD_MS = 1000;
const ONESHOT_COOLDOWN_MS = 400;

// Volume pattern matching constants
const PATTERN_LENGTH = 50;             // 50 samples
const PATTERN_SAMPLE_MS = 50;          // sample every 50ms -> 2.5 second window
const PATTERN_CHECK_MS = 100;          // check correlations every 100ms
const PATTERN_FIRE_DURATION_MS = 1000; // hold expression for 1s after match
const PATTERN_COOLDOWN_MS = 2500;      // cooldown after a match (suppress re-fire)
const PATTERN_SHIFT_TOLERANCE = 6;     // ±300ms time-shift slack for matching

const volumeBuffer = new Array(PATTERN_LENGTH).fill(0);
let volumeBufferWriteIdx = 0;
let lastBufferSampleTime = 0;
let lastPatternCheckTime = 0;
const patternCooldowns = Object.create(null);
let patternFiredExpressionId = null;
let patternFireUntil = 0;


function scheduleBlink() {
  const m = config.motion;
  const silentDur = performance.now() - lastTalkTime;

  // Fully asleep: pickImageForState handles the locked-close image.
  // We still poll periodically in case the user wakes up.
  if (silentDur >= m.fullAsleepAfter) {
    blinking = false;
    setTimeout(scheduleBlink, 500);
    return;
  }

  // Sleepy progress: 0 before sleepyAfter, 1 at fullAsleepAfter, linear between.
  const range = Math.max(1, m.fullAsleepAfter - m.sleepyAfter);
  const progress = silentDur < m.sleepyAfter ? 0 :
                   Math.min(1, (silentDur - m.sleepyAfter) / range);

  // As we get sleepier: blinks get longer (closure scales up) and intervals stretch.
  const closeMs = config.blinkDuration * (1 + progress * 20);
  const baseI   = config.blinkMin * (1 + progress * 1.5);
  const maxI    = config.blinkMax * (1 + progress * 1.5);
  const next    = baseI + Math.random() * Math.max(100, maxI - baseI);

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

function setActiveExpression(id, now) {
  if (id === activeCustomExpressionId) return; // unchanged
  activeCustomExpressionId = id;
  if (id) {
    const exp = config.customExpressions.find(e => e.id === id);
    activeExpressionAnimation = exp ? (exp.animation || 'none') : null;
    activeExpressionStartedAt = now;
  } else {
    activeExpressionAnimation = null;
  }
}

// Pearson correlation between two equal-length arrays. Returns -1..1.
function correlation(a, b) {
  const n = a.length;
  if (n === 0 || n !== b.length) return 0;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

// Cross-correlation: try several time shifts of the pattern against the live
// buffer, return the highest correlation. Robust to slight timing differences
// (e.g. laughing slightly faster/slower than the recorded sample).
function maxShiftedCorrelation(live, pattern) {
  const n = live.length;
  if (n !== pattern.length) return correlation(live, pattern);
  let best = -1;
  for (let shift = -PATTERN_SHIFT_TOLERANCE; shift <= PATTERN_SHIFT_TOLERANCE; shift++) {
    const a = [], b = [];
    for (let i = 0; i < n; i++) {
      const j = i + shift;
      if (j < 0 || j >= n) continue;
      a.push(live[i]);
      b.push(pattern[j]);
    }
    if (a.length < n - PATTERN_SHIFT_TOLERANCE * 2) continue;
    const c = correlation(a, b);
    if (c > best) best = c;
  }
  return best;
}

// Count significant local maxima. Used to discriminate between rapidly
// oscillating patterns (laughter) and slowly varying ones (cry / sustained
// vowels). Threshold scales with the pattern's own standard deviation.
function countLocalPeaks(arr) {
  const n = arr.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (arr[i] - mean) * (arr[i] - mean);
  const std = Math.sqrt(varSum / n);
  const minProm = Math.max(1, std * 0.5);
  let count = 0;
  for (let i = 1; i < n - 1; i++) {
    if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1]) {
      const localMin = Math.min(arr[i - 1], arr[i + 1]);
      if (arr[i] - localMin >= minProm) count++;
    }
  }
  return count;
}

function snapshotOrderedBuffer() {
  const out = new Array(PATTERN_LENGTH);
  for (let i = 0; i < PATTERN_LENGTH; i++) {
    out[i] = volumeBuffer[(volumeBufferWriteIdx + i) % PATTERN_LENGTH];
  }
  return out;
}

function checkVolumePatterns(now) {
  if (now < patternFireUntil) return; // an expression is currently firing
  const live = snapshotOrderedBuffer();
  // Skip if the buffer is mostly silent (avoids matching the silent baseline)
  let sum = 0;
  for (let i = 0; i < live.length; i++) sum += live[i];
  if (sum / live.length < 3) return;
  // Need some variance, otherwise correlation is meaningless
  let variance = 0;
  const mean = sum / live.length;
  for (let i = 0; i < live.length; i++) variance += (live[i] - mean) * (live[i] - mean);
  if (variance / live.length < 4) return;

  const livePeaks = countLocalPeaks(live);
  let winnerId = null;
  let bestCorr = -1;
  let topCorr = -1;
  let topLabel = '';
  let topPeakDiff = 0;
  let topPatIdx = -1;
  for (const exp of config.customExpressions) {
    const patterns = Array.isArray(exp.volumePatterns) ? exp.volumePatterns : [];
    if (patterns.length === 0) continue;
    if (!urlOf(exp.imageKey)) continue;

    // Find this expression's best-matching pattern
    let expBestCorr = -1;
    let expBestPeakDiff = 0;
    let expBestPeakAllow = 2;
    let expBestPatIdx = -1;
    for (let pi = 0; pi < patterns.length; pi++) {
      const pat = patterns[pi];
      if (!Array.isArray(pat) || pat.length !== PATTERN_LENGTH) continue;
      const corr = maxShiftedCorrelation(live, pat);
      if (corr > expBestCorr) {
        const patPeaks = countLocalPeaks(pat);
        expBestCorr = corr;
        expBestPeakDiff = Math.abs(livePeaks - patPeaks);
        expBestPeakAllow = Math.max(2, Math.ceil(patPeaks * 0.3));
        expBestPatIdx = pi;
      }
    }

    if (expBestCorr > topCorr) {
      topCorr = expBestCorr;
      topLabel = exp.label || exp.id;
      topPeakDiff = expBestPeakDiff;
      topPatIdx = expBestPatIdx;
    }

    if (now < (patternCooldowns[exp.id] || 0)) continue;
    const thr = (typeof exp.volumePatternThreshold === 'number') ? exp.volumePatternThreshold : 0.75;
    const peakOK = expBestPeakDiff <= expBestPeakAllow;
    if (expBestCorr >= thr && peakOK && expBestCorr > bestCorr) {
      bestCorr = expBestCorr;
      winnerId = exp.id;
    }
  }
  if (topCorr > -0.5 && topLabel) {
    setDebug(`pat: ${topLabel}#${topPatIdx + 1}=${topCorr.toFixed(2)} peak±${topPeakDiff}` +
             (winnerId ? ' [FIRED]' : ''));
  }
  if (winnerId) {
    patternFiredExpressionId = winnerId;
    patternFireUntil = now + PATTERN_FIRE_DURATION_MS;
    patternCooldowns[winnerId] = patternFireUntil + PATTERN_COOLDOWN_MS;
  }
}

function scheduleYosomi() {
  const m = config.motion;
  const next = m.yosomiIntervalMin + Math.random() * Math.max(100, m.yosomiIntervalMax - m.yosomiIntervalMin);
  setTimeout(() => {
    const now = performance.now();
    const silentDur = now - lastTalkTime;
    // Suppress yosomi once we enter the sleepy state (sleepyAfter).
    if (silentDur > m.idleLookDelay && silentDur < m.sleepyAfter &&
        !activeCustomExpressionId && !forcedExpressionId) {
      triggerYosomi();
    }
    scheduleYosomi();
  }, next);
}

setInterval(() => {
  mouthChoiceIndex = Math.floor(Math.random() * 9973);
}, 350);

// ============================================================
// Keyboard
// ============================================================
document.addEventListener('keydown', (e) => {
  // Hotkey capture mode (for both surprise and custom expressions)
  if (keyCaptureTarget) {
    if (e.code === 'Escape') {
      cancelKeyCapture();
      e.preventDefault();
      return;
    }
    if (RESERVED_KEYS_FOR_CUSTOM.has(e.code)) {
      alert('このキー (' + keyCodeLabel(e.code) + ') は予約されています。別のキーを選んでください。');
      return;
    }
    const isInputFocused = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (isInputFocused) return;

    const exp = config.customExpressions.find(x => x.id === keyCaptureTarget);
    if (exp) {
      // Remove duplicates from other custom expressions
      for (const other of config.customExpressions) {
        if (other.id !== exp.id && other.hotkey === e.code) other.hotkey = null;
      }
      exp.hotkey = e.code;
      saveConfig();
    }
    cancelKeyCapture();
    buildCustomExpressions();
    e.preventDefault();
    return;
  }

  // Ignore keypresses while typing in input fields
  if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT')) {
    return;
  }

  // Ignore auto-repeat (we only care about the initial press / final release)
  if (e.repeat) {
    e.preventDefault();
    return;
  }

  if (e.code === 'KeyH') { panel.classList.toggle('hidden'); return; }
  if (e.code === 'KeyY') { triggerYosomi(); return; }

  // Custom expression hotkeys — press-and-hold (includes the default びっくり)
  for (const exp of config.customExpressions) {
    if (exp.hotkey && exp.hotkey === e.code && urlOf(exp.imageKey)) {
      keyboardHeldExpressionId = exp.id;
      e.preventDefault();
      return;
    }
  }
});
document.addEventListener('keyup', (e) => {
  for (const exp of config.customExpressions) {
    if (exp.hotkey && exp.hotkey === e.code && keyboardHeldExpressionId === exp.id) {
      keyboardHeldExpressionId = null;
      return;
    }
  }
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
      // Track raw loud time for quick mouth-close detection.
      if (raw > config.threshold1) lastRawLoudTime = performance.now();
      // Asymmetric envelope used only for *tier selection* (which mouth shape).
      // Smooth release keeps the tier stable through brief volume dips between
      // syllables. Whether the mouth is open vs closed is decided by `raw`.
      if (raw > smoothed) {
        smoothed = smoothed * 0.5 + raw * 0.5;
      } else {
        smoothed = smoothed * 0.92 + raw * 0.08;
      }
      currentVolume = smoothed;
      volText.textContent = currentVolume.toFixed(1);
      volBar.style.width = currentVolume + '%';

      const now = performance.now();
      if (currentVolume > config.threshold1) lastTalkTime = now;

      const m = config.motion;
      const loudThr = m.loudPulseMin;
      if (currentVolume > loudThr && loudArmed && now > loudPulseUntil) {
        loudPulseUntil = now + m.loudPulseDur;
        loudArmed = false;
      }
      if (currentVolume < loudThr * m.loudPulseRearm) loudArmed = true;

      // Per-expression volume trigger detection.
      // The expression with the highest currently-active threshold wins.
      let volumeWinnerId = null;
      let volumeWinnerThreshold = -Infinity;
      for (const exp of config.customExpressions) {
        const mode = exp.volumeMode;
        if (!mode || mode === 'off') continue;
        const thr = exp.volumeThreshold;
        if (typeof thr !== 'number') continue;
        let active = false;
        if (mode === 'hold') {
          active = currentVolume > thr;
        } else if (mode === 'oneshot') {
          const st = volumeOneshotStates[exp.id] || { until: 0, cooldownUntil: 0 };
          if (currentVolume > thr && now > st.cooldownUntil && now > st.until) {
            st.until = now + ONESHOT_HOLD_MS;
            st.cooldownUntil = st.until + ONESHOT_COOLDOWN_MS;
            volumeOneshotStates[exp.id] = st;
          }
          active = now < st.until;
        }
        if (active && thr > volumeWinnerThreshold) {
          volumeWinnerThreshold = thr;
          volumeWinnerId = exp.id;
        }
      }

      // Volume pattern detection: rolling buffer + periodic correlation check
      if (now - lastBufferSampleTime >= PATTERN_SAMPLE_MS) {
        volumeBuffer[volumeBufferWriteIdx] = currentVolume;
        volumeBufferWriteIdx = (volumeBufferWriteIdx + 1) % PATTERN_LENGTH;
        lastBufferSampleTime = now;
      }
      if (now - lastPatternCheckTime >= PATTERN_CHECK_MS) {
        lastPatternCheckTime = now;
        checkVolumePatterns(now);
      }

      // Priority: URL-forced > keyboard > volume > pattern > none
      if (forcedExpressionId) {
        setActiveExpression(forcedExpressionId, now);
      } else if (keyboardHeldExpressionId) {
        setActiveExpression(keyboardHeldExpressionId, now);
      } else if (volumeWinnerId) {
        setActiveExpression(volumeWinnerId, now);
      } else if (patternFiredExpressionId && now < patternFireUntil) {
        setActiveExpression(patternFiredExpressionId, now);
      } else {
        setActiveExpression(null, now);
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
function urlOf(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (ref.startsWith('img_')) return imageCache[ref] || null;
  return ref; // direct path / URL (for bundled samples or external URLs)
}

function pickMouthTierImage() {
  // Find the tier with the highest threshold that is still <= currentVolume
  // and that has at least one valid image. Order-independent.
  let bestIdx = -1;
  let bestThreshold = -Infinity;
  for (let i = 0; i < config.mouthTiers.length; i++) {
    const t = config.mouthTiers[i];
    if (t.threshold <= currentVolume &&
        t.threshold > bestThreshold &&
        t.images.some(k => urlOf(k))) {
      bestThreshold = t.threshold;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;

  // Hysteresis: only allow a drop to a lower tier if enough time has passed
  // since the last change. Upgrades to a higher tier always take effect.
  const now = performance.now();
  if (mouthChoiceTier >= 0 && bestIdx < mouthChoiceTier) {
    if (now - mouthTierLastChangedAt < MOUTH_TIER_DOWNGRADE_HOLD_MS) {
      bestIdx = mouthChoiceTier;
    }
  }
  if (bestIdx !== mouthChoiceTier) {
    mouthChoiceTier = bestIdx;
    mouthTierLastChangedAt = now;
    mouthChoiceIndex = Math.floor(Math.random() * 9973);
  }
  const tier = config.mouthTiers[bestIdx];
  const validKeys = tier.images.filter(k => urlOf(k));
  return validKeys[mouthChoiceIndex % validKeys.length] || null;
}

function pickImageForState(now) {
  // Highest priority: active custom expression (keyboard or volume-triggered)
  if (activeCustomExpressionId) {
    const exp = config.customExpressions.find(e => e.id === activeCustomExpressionId);
    if (exp && exp.imageKey) {
      const url = urlOf(exp.imageKey);
      if (url) return url;
    }
  }
  // Fully asleep: eyes stay closed
  const silentDur = now - lastTalkTime;
  if (silentDur >= config.motion.fullAsleepAfter) {
    return urlOf(config.images.close) || urlOf(config.images.normal);
  }
  if (blinking) return urlOf(config.images.close) || urlOf(config.images.normal);

  // Quick-close: if the *raw* audio has been silent for QUICK_CLOSE_MS, close
  // the mouth immediately even if the smoothed envelope is still elevated.
  // This avoids the mouth flicking through lower tiers as the envelope decays.
  const rawSilentDur = now - lastRawLoudTime;
  const effectivelyQuiet = rawSilentDur > QUICK_CLOSE_MS || currentVolume < config.threshold1;

  if (effectivelyQuiet) {
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
function computeExpressionAnimation(now, animType, startedAt) {
  let x = 0, y = 0, scale = 1, rot = 0;
  const elapsed = now - startedAt;
  const m = config.motion;
  switch (animType) {
    case 'hop': {
      const t = Math.min(1, elapsed / m.surpriseHopDur);
      const curve = Math.sin(t * Math.PI);
      y = -curve * m.surpriseHopY;
      scale = 1 + curve * 0.04;
      if (elapsed > m.surpriseHopDur) rot = Math.sin(now / 35) * 0.8;
      break;
    }
    case 'recoil': {
      const t = Math.min(1, elapsed / m.surpriseHopDur);
      const curve = Math.sin(t * Math.PI);
      y = curve * m.surpriseHopY * m.recoilFactor;
      scale = 1 - curve * 0.05;
      if (elapsed > m.surpriseHopDur) rot = Math.sin(now / 35) * 0.8;
      break;
    }
    case 'shake':
      x = (Math.random() - 0.5) * m.shakeAmp;
      y = (Math.random() - 0.5) * m.shakeAmp;
      break;
    case 'bounce':
      y = -Math.abs(Math.sin(now / m.bounceSpeed)) * m.bounceAmp;
      break;
    case 'wobble':
      x = Math.sin(now / m.wobbleSpeed) * m.wobbleAmp;
      rot = Math.sin(now / m.wobbleSpeed) * m.wobbleRot;
      break;
    case 'nod':
      y = Math.sin(now / m.nodSpeed) * m.nodAmp;
      rot = Math.sin(now / m.nodSpeed) * m.nodRot;
      break;
    case 'headshake':
      x = Math.sin(now / m.headshakeSpeed) * m.headshakeAmp;
      rot = Math.sin(now / m.headshakeSpeed) * m.headshakeRot;
      break;
  }
  return { x, y, scale, rot };
}

function render(now) {
  const m = config.motion;
  const isExpressionActive = !!activeCustomExpressionId;

  const src = pickImageForState(now);
  if (src && src !== lastSrc) {
    avatar.src = src;
    lastSrc = src;
  } else if (!src && lastSrc) {
    avatar.removeAttribute('src');
    lastSrc = '';
  }

  const isTalking = currentVolume > config.threshold1;
  const silentDur = now - lastTalkTime;
  const isSleepy = silentDur > m.sleepyAfter;

  const breathMul = isSleepy ? m.sleepyBreathMul : 1;
  const breathY = Math.sin((now / m.breathPeriod) * Math.PI * 2) * m.breathAmpY * breathMul;
  const swayX = Math.sin((now / m.swayPeriod) * Math.PI * 2) * m.swayAmpX;

  // Tilt: suppress automated tilts during an active custom expression
  if (isExpressionActive) {
    tiltTarget = 0;
  } else if (isTalking) {
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

  // Idle look: suppressed during expression active, talking, or once in sleepy state
  let idleLookX = 0;
  if (!isExpressionActive && !isTalking && silentDur > m.idleLookDelay && silentDur < m.sleepyAfter) {
    const fadeIn = Math.min(1, (silentDur - m.idleLookDelay) / m.idleLookFadeIn);
    idleLookX = Math.sin((now / m.idleLookPeriod) * Math.PI * 2) * m.idleLookAmpX * fadeIn;
  }

  let loudScale = 1;
  if (now < loudPulseUntil) {
    const remain = (loudPulseUntil - now) / m.loudPulseDur;
    loudScale = 1 + m.loudPulseScale * remain;
  }

  // Custom expression animation
  let cx = 0, cy = 0, cScale = 1, cRot = 0;
  if (isExpressionActive && activeExpressionAnimation && activeExpressionAnimation !== 'none') {
    const a = computeExpressionAnimation(now, activeExpressionAnimation, activeExpressionStartedAt);
    cx = a.x; cy = a.y; cScale = a.scale; cRot = a.rot;
  }

  const tx = swayX + idleLookX + cx;
  const ty = breathY + cy;
  const finalScale = cScale * loudScale;
  const finalRot = cRot + tiltCurrent;
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
  const resolve = (k) => {
    if (!k || typeof k !== 'string') return null;
    if (k.startsWith('img_')) return imageCache[k] || null;
    return k; // preserve paths/URLs
  };
  for (const slot of FIXED_SLOTS) {
    exportConfig.images[slot.key] = resolve(exportConfig.images[slot.key]);
  }
  for (const tier of exportConfig.mouthTiers) {
    tier.images = tier.images.map(resolve).filter(Boolean);
  }
  if (Array.isArray(exportConfig.customExpressions)) {
    for (const exp of exportConfig.customExpressions) {
      exp.imageKey = resolve(exp.imageKey);
    }
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
        if (typeof v !== 'string' || !v) return null;
        if (v.startsWith('data:')) {
          const k = newImageKey();
          await idbSet(k, v);
          imageCache[k] = v;
          return k;
        }
        return v; // preserve relative paths or URLs as-is
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
      if (Array.isArray(next.customExpressions)) {
        for (const exp of next.customExpressions) {
          exp.imageKey = await importOne(exp.imageKey);
          if (!exp.id) exp.id = newExpressionId();
        }
      } else {
        next.customExpressions = [];
      }
      config = next;
      // Bypass the debounced saveConfig — location.reload() below would cancel
      // its pending setTimeout, losing the imported config in localStorage.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      } catch (e) {
        setDebug('localStorage 保存失敗: ' + e.message, true);
        alert('設定の保存に失敗しました: ' + e.message);
        return;
      }
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

  // Replace static `<span class="val">` displays next to range sliders with
  // editable number inputs so users can type values precisely.
  document.querySelectorAll('.row > input[type=range]').forEach((slider) => {
    const span = slider.parentElement.querySelector('span.val');
    if (!span) return;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'val';
    if (span.id) input.id = span.id;
    input.value = span.textContent || slider.value;
    span.parentNode.replaceChild(input, span);
  });

  // Resolve URL-forced expression now that customExpressions are loaded
  if (FORCE_CUSTOM_HINT) {
    const exp = resolveForcedExpression(FORCE_CUSTOM_HINT);
    if (exp) forcedExpressionId = exp.id;
  }

  buildFixedSlots();
  buildCustomExpressions();
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
