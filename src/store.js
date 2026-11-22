// Local persistence (everything stays on the phone).
//
// - Diary entries live in IndexedDB (one record per day). On iPhone, IndexedDB can
//   hold far more than localStorage's ~5 MB limit, so years of history fit easily.
// - Small things (settings, My Foods, recent foods, weigh-ins) live in localStorage.
// - If IndexedDB is unavailable, the diary falls back to localStorage.

const KEYS = { entries: "ct_entries", foods: "ct_myfoods", recent: "ct_recent", settings: "ct_settings", weights: "ct_weights" };

// The Anthropic API key lives in its own storage slot, never inside settings,
// so it can't end up in exports, imports, or anything rendered on screen.
const API_KEY_SLOT = "ct_apikey";

const DEFAULT_SETTINGS = {
  goal: 2000,
  protein: 150,
  carbs: 200,
  fat: 65,
  model: "claude-opus-5-5",
  usdaKey: "",
  weightUnit: "lb",
  histRange: 30,
  lastBackup: 0,
};

export const LOCAL_STORAGE_LIMIT = 5 * 1024 * 1024; // Safari's localStorage quota

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveFailed(e) {
  window.dispatchEvent(new CustomEvent("ct-toast", { detail: "Could not save data: " + (e?.message || e) }));
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    saveFailed(e);
  }
}

export const state = {
  entries: {}, // { "YYYY-MM-DD": [entry, ...] }, loaded from IndexedDB by `ready`
  foods: load(KEYS.foods, []), // My Foods (custom / saved packaged foods)
  recent: load(KEYS.recent, []), // recently used food objects
  weights: load(KEYS.weights, {}), // { "YYYY-MM-DD": kg }
  settings: { ...DEFAULT_SETTINGS, ...load(KEYS.settings, {}) },
};

// ---------- IndexedDB (diary) ----------
const DB_NAME = "calorie-tracker";
const DAYS = "days";
let backend = "idb"; // "idb" or "local" (fallback)
let dbPromise = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DAYS);
    req.onsuccess = () => {
      const db = req.result;
      // iOS can drop the connection while the app is in the background; reopen on next use.
      db.onclose = () => (dbPromise = null);
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}
function getDB() {
  dbPromise ||= openDB().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}
const reqDone = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));
const txDone = (tx) =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error("Save aborted"));
  });
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function readAllDays() {
  const db = await getDB();
  const store = db.transaction(DAYS, "readonly").objectStore(DAYS);
  const [keys, values] = await Promise.all([reqDone(store.getAllKeys()), reqDone(store.getAll())]);
  const out = {};
  keys.forEach((k, i) => {
    if (Array.isArray(values[i]) && values[i].length) out[k] = values[i];
  });
  return out;
}

/** Write the current in-memory value of the given days (deleting empty ones). Retries once on a lost connection. */
async function writeDays(keys, { clear = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const db = await getDB();
      const tx = db.transaction(DAYS, "readwrite");
      const store = tx.objectStore(DAYS);
      if (clear) store.clear();
      for (const k of keys) {
        const list = state.entries[k];
        if (list?.length) store.put(list, k);
        else store.delete(k);
      }
      return await txDone(tx);
    } catch (e) {
      dbPromise = null;
      if (attempt >= 1) throw e;
    }
  }
}

function persistDays(keys) {
  if (backend === "local") return save(KEYS.entries, state.entries);
  writeDays(keys).catch((e) => {
    // Last resort: keep a copy in localStorage; it is merged back into IndexedDB on next launch.
    save(KEYS.entries, state.entries);
    saveFailed(e);
  });
}

/** Resolves once the diary is loaded. Also migrates diaries saved by older versions (localStorage). */
export const ready = (async () => {
  try {
    await withTimeout(getDB(), 4000);
    const fromIDB = await readAllDays();
    const legacy = load(KEYS.entries, null);
    if (legacy && typeof legacy === "object") {
      const changed = [];
      for (const [k, list] of Object.entries(legacy)) {
        if (!Array.isArray(list) || !list.length) continue;
        const cur = fromIDB[k] || [];
        const ids = new Set(cur.map((e) => e.id));
        const add = list.filter((e) => !ids.has(e.id));
        if (add.length) {
          fromIDB[k] = [...cur, ...add].sort((a, b) => (a.ts || 0) - (b.ts || 0));
          changed.push(k);
        }
      }
      state.entries = fromIDB;
      if (changed.length) await writeDays(changed);
      localStorage.removeItem(KEYS.entries); // only after the copy is safely in IndexedDB
    }
    state.entries = fromIDB;
    backend = "idb";
  } catch {
    backend = "local";
    state.entries = load(KEYS.entries, {});
  }
})();

export const persist = {
  entries: () => persistDays(Object.keys(state.entries)),
  foods: () => save(KEYS.foods, state.foods),
  recent: () => save(KEYS.recent, state.recent),
  weights: () => save(KEYS.weights, state.weights),
  settings: () => save(KEYS.settings, state.settings),
};

// ---------- Anthropic API key ----------
export function getApiKey() {
  try {
    return localStorage.getItem(API_KEY_SLOT) || "";
  } catch {
    return "";
  }
}
export function setApiKey(key) {
  localStorage.setItem(API_KEY_SLOT, key);
}
export function clearApiKey() {
  try {
    localStorage.removeItem(API_KEY_SLOT);
  } catch {}
}
/** "sk-ant-…AbCd": enough to recognise which key is saved without revealing it. */
export function maskedApiKey() {
  const k = getApiKey();
  return k ? `${k.slice(0, 7)}…${k.slice(-4)}` : "";
}
// One-time migration: older versions kept the key inside settings.
if ("apiKey" in state.settings) {
  if (state.settings.apiKey && !getApiKey()) setApiKey(state.settings.apiKey);
  delete state.settings.apiKey;
  persist.settings();
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** First day the app was used (YYYY-MM-DD). Set once; for existing users it's the earliest logged day. */
export function ensureFirstUse() {
  if (/^\d{4}-\d{2}-\d{2}$/.test(state.settings.firstUse || "")) return;
  const keys = [...Object.keys(state.entries), ...Object.keys(state.weights), dayKey(new Date())].sort();
  state.settings.firstUse = keys[0];
  persist.settings();
}

export function entriesFor(key) {
  return state.entries[key] || [];
}

// Store numbers to 2 decimals: identical on screen, much smaller on disk.
const r2 = (n) => Math.round(n * 100) / 100;
function tidy(e) {
  for (const k of ["kcal", "p", "c", "f", "grams"]) if (typeof e[k] === "number") e[k] = r2(e[k]);
  if (e.ingredients === undefined) delete e.ingredients;
  return e;
}

export function addEntry(key, entry) {
  (state.entries[key] ||= []).push(tidy({ id: uid(), ts: Date.now(), ...entry }));
  persistDays([key]);
}

export function updateEntry(key, id, patch) {
  const list = state.entries[key] || [];
  const i = list.findIndex((e) => e.id === id);
  if (i >= 0) list[i] = tidy({ ...list[i], ...patch });
  persistDays([key]);
}

export function deleteEntry(key, id) {
  state.entries[key] = (state.entries[key] || []).filter((e) => e.id !== id);
  if (!state.entries[key].length) delete state.entries[key];
  persistDays([key]);
}

// ---------- body weight (stored in kg) ----------
export const KG_PER_LB = 0.45359237;
export function setWeight(key, kg) {
  if (kg > 0) state.weights[key] = Math.round(kg * 1000) / 1000;
  else delete state.weights[key];
  persist.weights();
}

// Drop search-index fields (_s, _w) that foods from the big list carry.
const slimFood = (food) => Object.fromEntries(Object.entries(food).filter(([k]) => !k.startsWith("_")));

export function rememberRecent(food) {
  if (!food || food.source === "quick") return;
  const slim = slimFood(food);
  state.recent = [slim, ...state.recent.filter((f) => f.id !== food.id && f.name !== food.name)].slice(0, 30);
  persist.recent();
}

export function saveMyFood(food) {
  food = slimFood(food);
  const existing = state.foods.findIndex((f) => f.id === food.id);
  if (existing >= 0) state.foods[existing] = food;
  else state.foods.unshift(food);
  persist.foods();
}

export function deleteMyFood(id) {
  state.foods = state.foods.filter((f) => f.id !== id);
  persist.foods();
}

export function exportData() {
  return JSON.stringify(
    {
      app: "calorie-tracker", version: 2, exported: new Date().toISOString(),
      entries: state.entries, foods: state.foods, recent: state.recent, weights: state.weights, settings: { ...state.settings },
    },
    null,
    2
  );
}
export function markBackedUp() {
  state.settings.lastBackup = Date.now();
  persist.settings();
}

/** Erase everything this app stores on the device, including the API key. */
export async function eraseAll() {
  state.entries = {};
  try {
    if (backend === "idb") await writeDays([], { clear: true });
  } catch {}
  [...Object.values(KEYS), API_KEY_SLOT].forEach((k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  });
}

export async function importData(json) {
  const data = JSON.parse(json);
  if (!data || data.app !== "calorie-tracker") throw new Error("That file isn't a Calorie Tracker backup.");
  state.entries = data.entries && typeof data.entries === "object" ? data.entries : {};
  state.foods = Array.isArray(data.foods) ? data.foods : [];
  state.recent = Array.isArray(data.recent) ? data.recent : [];
  state.weights = data.weights && typeof data.weights === "object" ? data.weights : {};
  // A backup never carries an API key; ignore one if a file has it.
  const { apiKey: _ignored, ...importedSettings } = data.settings || {};
  state.settings = { ...DEFAULT_SETTINGS, ...importedSettings };
  if (backend === "idb") await writeDays(Object.keys(state.entries), { clear: true });
  else save(KEYS.entries, state.entries);
  persist.foods();
  persist.recent();
  persist.weights();
  persist.settings();
}

// ---------- storage report ----------
const UTF16 = 2; // conservative: Safari may store strings as 2 bytes per character

/** How much this app stores, where, and how much room is left. */
export async function storageInfo() {
  const diaryChars = JSON.stringify(state.entries).length;
  let otherChars = 0;
  for (const k of [...Object.values(KEYS), API_KEY_SLOT]) {
    try {
      otherChars += (localStorage.getItem(k) || "").length + k.length;
    } catch {}
  }
  const days = Object.keys(state.entries).sort();
  let estimate = null;
  let persisted = null;
  try {
    estimate = await navigator.storage?.estimate?.();
  } catch {}
  try {
    persisted = await navigator.storage?.persisted?.();
  } catch {}
  return {
    backend,
    diaryBytes: diaryChars * (backend === "idb" ? 1 : UTF16),
    localBytes: (otherChars + (backend === "local" ? diaryChars : 0)) * UTF16,
    usage: estimate?.usage ?? null,
    quota: estimate?.quota ?? null,
    persisted,
    firstDay: days[0] || null,
    daysLogged: days.length,
  };
}
