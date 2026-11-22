// Local persistence (everything stays on the phone).

const KEYS = { entries: "ct_entries", foods: "ct_myfoods", recent: "ct_recent", settings: "ct_settings" };

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
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    window.dispatchEvent(new CustomEvent("ct-toast", { detail: "Could not save data: " + e.message }));
  }
}

export const state = {
  entries: load(KEYS.entries, {}), // { "YYYY-MM-DD": [entry, ...] }
  foods: load(KEYS.foods, []), // My Foods (custom / saved packaged foods)
  recent: load(KEYS.recent, []), // recently used food objects
  settings: { ...DEFAULT_SETTINGS, ...load(KEYS.settings, {}) },
};

export const persist = {
  entries: () => save(KEYS.entries, state.entries),
  foods: () => save(KEYS.foods, state.foods),
  recent: () => save(KEYS.recent, state.recent),
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

export function entriesFor(key) {
  return state.entries[key] || [];
}

export function addEntry(key, entry) {
  (state.entries[key] ||= []).push({ id: uid(), ts: Date.now(), ...entry });
  persist.entries();
}

export function updateEntry(key, id, patch) {
  const list = state.entries[key] || [];
  const i = list.findIndex((e) => e.id === id);
  if (i >= 0) list[i] = { ...list[i], ...patch };
  persist.entries();
}

export function deleteEntry(key, id) {
  state.entries[key] = (state.entries[key] || []).filter((e) => e.id !== id);
  if (!state.entries[key].length) delete state.entries[key];
  persist.entries();
}

export function rememberRecent(food) {
  if (!food || food.source === "quick") return;
  const slim = { ...food };
  state.recent = [slim, ...state.recent.filter((f) => f.id !== food.id && f.name !== food.name)].slice(0, 30);
  persist.recent();
}

export function saveMyFood(food) {
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
    { app: "calorie-tracker", version: 1, exported: new Date().toISOString(), entries: state.entries, foods: state.foods, recent: state.recent, settings: { ...state.settings } },
    null,
    2
  );
}

/** Erase everything this app stores on the device, including the API key. */
export function eraseAll() {
  [...Object.values(KEYS), API_KEY_SLOT].forEach((k) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  });
}

export function importData(json) {
  const data = JSON.parse(json);
  if (!data || data.app !== "calorie-tracker") throw new Error("That file isn't a Calorie Tracker backup.");
  state.entries = data.entries || {};
  state.foods = data.foods || [];
  state.recent = data.recent || [];
  // A backup never carries an API key; ignore one if a file has it.
  const { apiKey: _ignored, ...importedSettings } = data.settings || {};
  state.settings = { ...DEFAULT_SETTINGS, ...importedSettings };
  Object.values(persist).forEach((fn) => fn());
}
