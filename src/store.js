// Local persistence (everything stays on the phone).

const KEYS = { entries: "ct_entries", foods: "ct_myfoods", recent: "ct_recent", settings: "ct_settings" };

const DEFAULT_SETTINGS = {
  goal: 2000,
  protein: 150,
  carbs: 200,
  fat: 65,
  apiKey: "",
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
    { app: "calorie-tracker", version: 1, exported: new Date().toISOString(), entries: state.entries, foods: state.foods, recent: state.recent, settings: { ...state.settings, apiKey: "" } },
    null,
    2
  );
}

export function importData(json) {
  const data = JSON.parse(json);
  if (!data || data.app !== "calorie-tracker") throw new Error("That file isn't a Calorie Tracker backup.");
  state.entries = data.entries || {};
  state.foods = data.foods || [];
  state.recent = data.recent || [];
  const keepKey = state.settings.apiKey;
  state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}), apiKey: keepKey };
  Object.values(persist).forEach((fn) => fn());
}
