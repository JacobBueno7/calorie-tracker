import { FOOD_DB } from "./foods.js";
import { analyzeMeal, imageToBase64, MODELS } from "./ai.js";
import { searchUSDA, searchBranded, searchOFF, lookupBarcode, startBarcodeScan, decodeBarcodeFromFile } from "./online.js";
import * as S from "./store.js";

const { state } = S;

const MEALS = [
  { id: "breakfast", label: "Breakfast", icon: "🍳" },
  { id: "lunch", label: "Lunch", icon: "🥪" },
  { id: "dinner", label: "Dinner", icon: "🍽️" },
  { id: "snacks", label: "Snacks", icon: "🍎" },
];
const mealLabel = (id) => MEALS.find((m) => m.id === id)?.label || "Snacks";

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString();
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const scale = (per, grams) => ({
  kcal: (per.kcal * grams) / 100,
  p: (per.p * grams) / 100,
  c: (per.c * grams) / 100,
  f: (per.f * grams) / 100,
});
const sum = (list) =>
  list.reduce((t, e) => ({ kcal: t.kcal + (e.kcal || 0), p: t.p + (e.p || 0), c: t.c + (e.c || 0), f: t.f + (e.f || 0) }), {
    kcal: 0, p: 0, c: 0, f: 0,
  });

function defaultMeal() {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 16) return "lunch";
  if (h < 21) return "dinner";
  return "snacks";
}

function sourceLabel(food) {
  return { db: "Built-in", usda: "USDA", off: "Packaged", custom: "My food", ai: "AI estimate", quick: "Quick add" }[food.source] || "";
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
window.addEventListener("ct-toast", (e) => toast(e.detail));

// ---------- app state ----------
let view = "diary";
let current = new Date();
const curKey = () => S.dayKey(current);

// ---------- sheets (full-screen panels) ----------
const stack = [];
function openSheet(html, { onClose, small } = {}) {
  const el = document.createElement("div");
  el.className = "sheet" + (small ? " small" : "");
  el.innerHTML = `<div class="sheet-panel">${html}</div>`;
  $("#sheets").appendChild(el);
  stack.push({ el, onClose });
  requestAnimationFrame(() => el.classList.add("open"));
  el.addEventListener("click", (ev) => {
    if (ev.target === el && small) closeSheet(el);
    if (ev.target.closest("[data-close]")) closeSheet(el);
  });
  return el;
}
function closeSheet(el) {
  const i = stack.findIndex((s) => s.el === el);
  if (i < 0) return;
  const [{ onClose }] = stack.splice(i, 1);
  onClose?.();
  el.classList.remove("open");
  setTimeout(() => el.remove(), 280);
}
function closeAllSheets() {
  [...stack].reverse().forEach((s) => closeSheet(s.el));
}

function confirmDialog(message, okLabel = "Delete") {
  return new Promise((resolve) => {
    let answered = false;
    const el = openSheet(
      `<div class="confirm"><p>${esc(message)}</p>
       <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" data-ok>${esc(okLabel)}</button></div></div>`,
      { small: true, onClose: () => !answered && resolve(false) }
    );
    $("[data-ok]", el).onclick = () => {
      answered = true;
      resolve(true);
      closeSheet(el);
    };
  });
}

function mealPicker(selected) {
  return `<div class="seg" data-meal-picker>${MEALS.map(
    (m) => `<button type="button" data-meal="${m.id}" class="${m.id === selected ? "on" : ""}">${m.icon} ${m.label}</button>`
  ).join("")}</div>`;
}
function bindMealPicker(root, onChange) {
  $$("[data-meal-picker] button", root).forEach((b) =>
    b.addEventListener("click", () => {
      $$("[data-meal-picker] button", root).forEach((x) => x.classList.toggle("on", x === b));
      onChange(b.dataset.meal);
    })
  );
}

// ---------- main render ----------
function render() {
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  const v = $("#view");
  if (view === "diary") v.innerHTML = renderDiary();
  else if (view === "history") v.innerHTML = renderHistory();
  else if (view === "foods") v.innerHTML = renderMyFoods();
  else if (view === "settings") {
    v.innerHTML = renderSettings();
    bindSettings(v);
  }
}

function dayTitle(d) {
  const today = S.dayKey(new Date());
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const k = S.dayKey(d);
  if (k === today) return "Today";
  if (k === S.dayKey(y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long" });
}

function ring(eaten, goal) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const pct = goal > 0 ? Math.min(eaten / goal, 1) : 0;
  const over = eaten > goal;
  return `<svg viewBox="0 0 130 130" class="ring">
    <circle cx="65" cy="65" r="${r}" class="ring-bg"/>
    <circle cx="65" cy="65" r="${r}" class="ring-fg ${over ? "over" : ""}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" transform="rotate(-90 65 65)"/>
  </svg>`;
}

function macroBar(label, val, goal, cls) {
  const pct = goal > 0 ? Math.min((val / goal) * 100, 100) : 0;
  return `<div class="macro"><div class="macro-top"><span>${label}</span><span>${fmt(val)}${goal ? ` / ${fmt(goal)}` : ""} g</span></div>
    <div class="bar"><div class="${cls}" style="width:${pct}%"></div></div></div>`;
}

function renderDiary() {
  const list = S.entriesFor(curKey());
  const t = sum(list);
  const goal = state.settings.goal;
  const left = goal - t.kcal;
  const isToday = curKey() === S.dayKey(new Date());
  return `
  <header class="topbar">
    <button class="icon-btn" data-act="prev-day" aria-label="Previous day">‹</button>
    <button class="date-title" data-act="today"><span>${dayTitle(current)}</span>
      <small>${current.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</small></button>
    <button class="icon-btn" data-act="next-day" aria-label="Next day" ${isToday ? "disabled" : ""}>›</button>
  </header>
  <section class="card summary">
    <div class="ring-wrap">${ring(t.kcal, goal)}
      <div class="ring-center"><b class="${left < 0 ? "neg" : ""}">${fmt(Math.abs(left))}</b><span>${left < 0 ? "over" : "left"}</span></div>
    </div>
    <div class="sum-side">
      <div class="sum-row"><span>Goal</span><b>${fmt(goal)}</b></div>
      <div class="sum-row"><span>Eaten</span><b>${fmt(t.kcal)}</b></div>
      ${macroBar("Protein", t.p, state.settings.protein, "p")}
      ${macroBar("Carbs", t.c, state.settings.carbs, "c")}
      ${macroBar("Fat", t.f, state.settings.fat, "f")}
    </div>
  </section>
  <button class="scan-cta" data-act="photo"><span class="cam">📷</span><span><b>Snap a meal</b><small>AI estimates the calories in the whole plate</small></span></button>
  ${MEALS.map((m) => {
    const items = list.filter((e) => e.meal === m.id);
    const mt = sum(items);
    return `<section class="card meal">
      <div class="meal-head"><span>${m.icon} ${m.label}</span><span class="kcal">${fmt(mt.kcal)} kcal</span></div>
      ${items.length ? `<ul class="entries">${items.map((e) => `
        <li data-act="edit-entry" data-id="${e.id}">
          <div class="e-main"><span class="e-name">${esc(e.name)}</span>
          <span class="e-sub">${e.grams ? `${fmt(e.grams)} g` : "Quick add"}${e.brand ? ` · ${esc(e.brand)}` : ""}${e.source === "ai" ? " · AI" : ""}</span></div>
          <span class="e-kcal">${fmt(e.kcal)}</span></li>`).join("")}</ul>` : ""}
      <button class="add-btn" data-act="add" data-meal="${m.id}">＋ Add food</button>
    </section>`;
  }).join("")}
  <p class="foot">Values per gram from USDA FoodData Central, Open Food Facts & your labels.</p>`;
}

function renderHistory() {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = S.dayKey(d);
    days.push({ d, k, t: sum(S.entriesFor(k)) });
  }
  const goal = state.settings.goal;
  const max = Math.max(goal * 1.2, ...days.map((x) => x.t.kcal), 1);
  const logged = days.filter((x) => x.t.kcal > 0);
  const avg = logged.length ? logged.reduce((a, x) => a + x.t.kcal, 0) / logged.length : 0;
  const avgP = logged.length ? logged.reduce((a, x) => a + x.t.p, 0) / logged.length : 0;
  return `
  <header class="topbar"><h1>History</h1></header>
  <section class="card">
    <div class="stats">
      <div><b>${fmt(avg)}</b><span>avg kcal / day</span></div>
      <div><b>${fmt(avgP)} g</b><span>avg protein</span></div>
      <div><b>${logged.length}</b><span>days logged</span></div>
    </div>
    <div class="chart">
      <div class="goal-line" style="bottom:${(goal / max) * 100}%"><span>${fmt(goal)}</span></div>
      ${days.map((x) => `<button class="col" data-act="goto-day" data-key="${x.k}" aria-label="${x.k}: ${fmt(x.t.kcal)} kcal">
        <div class="bar-v ${x.t.kcal > goal ? "over" : ""}" style="height:${(x.t.kcal / max) * 100}%"></div>
        <span>${x.d.toLocaleDateString(undefined, { weekday: "narrow" })}</span></button>`).join("")}
    </div>
  </section>
  <section class="card list">
    ${days.slice().reverse().map((x) => `<button class="hist-row" data-act="goto-day" data-key="${x.k}">
      <span>${x.d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
      <span class="muted">P ${fmt(x.t.p)} · C ${fmt(x.t.c)} · F ${fmt(x.t.f)}</span>
      <b>${x.t.kcal ? fmt(x.t.kcal) : "—"}</b></button>`).join("")}
  </section>`;
}

function renderMyFoods() {
  return `
  <header class="topbar"><h1>My Foods</h1></header>
  <div class="row gap pad">
    <button class="btn" data-act="new-custom">＋ New food from label</button>
    <button class="btn ghost" data-act="scan-to-foods">▦ Scan barcode</button>
  </div>
  <section class="card list">
    ${state.foods.length ? state.foods.map((f) => `<button class="food-row" data-act="edit-food" data-id="${f.id}">
      <div><span class="e-name">${esc(f.name)}</span><span class="e-sub">${esc(f.brand || sourceLabel(f))}${f.units?.[0] ? ` · ${esc(f.units[0].label)} = ${fmt(f.units[0].g)} g` : ""}</span></div>
      <span class="e-kcal">${fmt(f.kcal)}<small>/100g</small></span></button>`).join("")
      : `<p class="empty">Packaged foods you scan or enter from a nutrition label are saved here so you can add them again in one tap.</p>`}
  </section>`;
}

function renderSettings() {
  const s = state.settings;
  return `
  <header class="topbar"><h1>Settings</h1></header>
  <section class="card form">
    <h3>Daily goals</h3>
    <label>Calories<input data-set="goal" inputmode="numeric" value="${esc(s.goal)}"></label>
    <div class="grid3">
      <label>Protein g<input data-set="protein" inputmode="numeric" value="${esc(s.protein)}"></label>
      <label>Carbs g<input data-set="carbs" inputmode="numeric" value="${esc(s.carbs)}"></label>
      <label>Fat g<input data-set="fat" inputmode="numeric" value="${esc(s.fat)}"></label>
    </div>
  </section>
  <section class="card form">
    <h3>AI photo scanning</h3>
    <p class="hint">Photo scans use Claude through your own Anthropic API key. Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. The key is stored only on this phone and sent only to Anthropic. A scan costs roughly a few cents.</p>
    <label>Anthropic API key
      <div class="row"><input data-set="apiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-..." value="${esc(s.apiKey)}">
      <button class="btn ghost small" data-act="toggle-key" type="button">Show</button></div></label>
    <label>Model<select data-set="model">${MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? "selected" : ""}>${m.label}</option>`).join("")}</select></label>
  </section>
  <section class="card form">
    <h3>Food search</h3>
    <p class="hint">Online search uses USDA FoodData Central (generic + branded/packaged foods) and Open Food Facts (barcodes). The shared demo key allows only ~30 searches an hour, so get your own free key (instant, by email) at <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener">fdc.nal.usda.gov</a> and paste it here.</p>
    <label>USDA API key (optional)<input data-set="usdaKey" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="DEMO_KEY" value="${esc(s.usdaKey)}"></label>
  </section>
  <section class="card form">
    <h3>Your data</h3>
    <p class="hint">Everything is stored on this device. Make a backup now and then.</p>
    <div class="row gap"><button class="btn ghost" data-act="export">Export backup</button>
    <label class="btn ghost file-btn">Import backup<input type="file" accept="application/json,.json" data-act-file="import" hidden></label></div>
    <button class="btn danger outline" data-act="wipe">Erase all data</button>
  </section>
  <p class="foot">Calorie Tracker · runs entirely on your phone</p>`;
}

function bindSettings(root) {
  $$("[data-set]", root).forEach((inp) =>
    inp.addEventListener("change", () => {
      const k = inp.dataset.set;
      state.settings[k] = ["goal", "protein", "carbs", "fat"].includes(k) ? Math.max(0, Math.round(num(inp.value))) : inp.value.trim();
      S.persist.settings();
      toast("Saved");
    })
  );
  $("[data-act-file=import]", root).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      S.importData(await file.text());
      toast("Backup imported");
      render();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- global click handling ----------
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-act]");
  if (!t || t.closest(".sheet")) return;
  const act = t.dataset.act;
  if (act === "prev-day") { current.setDate(current.getDate() - 1); current = new Date(current); render(); }
  else if (act === "next-day") { current.setDate(current.getDate() + 1); current = new Date(current); render(); }
  else if (act === "today") { current = new Date(); render(); }
  else if (act === "add") openAddFood(t.dataset.meal);
  else if (act === "photo") openPhotoAI({ meal: defaultMeal() });
  else if (act === "edit-entry") editEntry(t.dataset.id);
  else if (act === "goto-day") {
    const [y, m, d] = t.dataset.key.split("-").map(Number);
    current = new Date(y, m - 1, d);
    view = "diary";
    render();
  }
  else if (act === "new-custom") openCustomFood({ onSaved: () => render() });
  else if (act === "edit-food") {
    const food = state.foods.find((f) => f.id === t.dataset.id);
    if (food) openCustomFood({ edit: food, onSaved: () => render() });
  }
  else if (act === "scan-to-foods") openBarcode({ meal: defaultMeal(), saveOnly: true });
  else if (act === "toggle-key") {
    const inp = $("[data-set=apiKey]");
    inp.type = inp.type === "password" ? "text" : "password";
    t.textContent = inp.type === "password" ? "Show" : "Hide";
  }
  else if (act === "export") exportBackup();
  else if (act === "wipe") {
    if (await confirmDialog("Erase ALL entries, foods and settings on this device? This cannot be undone.", "Erase everything")) {
      ["ct_entries", "ct_myfoods", "ct_recent", "ct_settings"].forEach((k) => localStorage.removeItem(k));
      location.reload();
    }
  }
});

$$("#tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    view = b.dataset.view;
    render();
    window.scrollTo(0, 0);
  })
);

async function exportBackup() {
  const json = S.exportData();
  const name = `calories-backup-${S.dayKey(new Date())}.json`;
  const file = new File([json], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Calorie Tracker backup" });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Add food (search) ----------
function searchLocal(q) {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = [...state.foods, ...FOOD_DB];
  const seen = new Set();
  return pool
    .map((f) => {
      const hay = `${f.name} ${f.brand || ""}`.toLowerCase();
      if (!tokens.every((tk) => hay.includes(tk.replace(/s$/, "")))) return null;
      let score = 0;
      if (hay.startsWith(tokens[0])) score += 3;
      if (f.source === "custom" || f.source === "off") score += 2;
      score -= hay.length / 100;
      return { f, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.f)
    .filter((f) => (seen.has(f.id) ? false : seen.add(f.id)))
    .slice(0, 40);
}

function foodRow(f) {
  return `<button class="food-row" data-food="${esc(f.id)}">
    <div><span class="e-name">${esc(f.name)}</span><span class="e-sub">${esc(f.brand ? `${f.brand} · ` : "")}${sourceLabel(f)}</span></div>
    <span class="e-kcal">${fmt(f.kcal)}<small>/100g</small></span></button>`;
}

function openAddFood(meal) {
  const foodsById = new Map();
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancel</button><h2>Add to ${mealLabel(meal)}</h2><span></span></div>
    <div class="search"><input type="search" placeholder="Search foods (e.g. strawberries, ground turkey)" autocomplete="off" enterkeyhint="search"></div>
    <div class="quick-actions">
      <button data-a="photo"><span>📷</span>Photo AI</button>
      <button data-a="barcode"><span>▦</span>Barcode</button>
      <button data-a="custom"><span>🏷️</span>Label</button>
      <button data-a="quick"><span>⚡</span>Quick add</button>
    </div>
    <div class="results"></div>`);
  const input = $("input", el);
  const results = $(".results", el);
  let onlineToken = 0;

  const register = (list) => list.forEach((f) => foodsById.set(f.id, f));

  function show(q) {
    onlineToken++;
    if (!q) {
      register(state.foods);
      register(state.recent);
      results.innerHTML =
        (state.recent.length ? `<h4>Recent</h4>${state.recent.slice(0, 15).map(foodRow).join("")}` : "") +
        (state.foods.length ? `<h4>My Foods</h4>${state.foods.map(foodRow).join("")}` : "") +
        (!state.recent.length && !state.foods.length
          ? `<p class="empty">Type a food to search. Enter exact grams on the next screen and calories are calculated for you.<br><br>For packaged food, scan the barcode or enter the nutrition label.</p>`
          : "");
      return;
    }
    const local = searchLocal(q);
    register(local);
    results.innerHTML = `
      ${local.length ? local.map(foodRow).join("") : `<p class="empty small">No built-in match for “${esc(q)}”.</p>`}
      <div class="more">
        <button class="btn ghost" data-a="online">🔎 Search online for “${esc(q)}”</button>
        <button class="btn ghost" data-a="ask-ai">✨ Ask AI about “${esc(q)}”</button>
      </div>
      <div class="online"></div>`;
  }

  async function online(q) {
    const my = ++onlineToken;
    const box = $(".online", results);
    const more = $(".more", results);
    if (more) more.querySelector("[data-a=online]").remove();
    box.innerHTML = `<div class="loading"><span class="spinner"></span>Searching USDA & packaged foods…</div>`;
    const key = state.settings.usdaKey;
    const [usda, branded, off] = await Promise.allSettled([searchUSDA(q, key), searchBranded(q, key), searchOFF(q)]);
    if (my !== onlineToken) return;
    let html = "";
    const limited = [usda, branded].some((r) => r.status === "rejected" && String(r.reason).includes("429"));
    if (usda.status === "fulfilled" && usda.value.length) {
      register(usda.value);
      html += `<h4>USDA (generic foods)</h4>${usda.value.map(foodRow).join("")}`;
    }
    const packaged = [
      ...(branded.status === "fulfilled" ? branded.value : []),
      ...(off.status === "fulfilled" ? off.value : []),
    ];
    if (packaged.length) {
      register(packaged);
      html += `<h4>Packaged & branded</h4>${packaged.map(foodRow).join("")}`;
    }
    if (limited) html = `<p class="notice">USDA search is rate-limited on the shared demo key. Add your own free USDA key in Settings.</p>` + html;
    else if (usda.status === "rejected" && branded.status === "rejected") html += `<p class="empty small">Online search failed. Check your connection.</p>`;
    box.innerHTML = html || `<p class="empty small">No online results. Try different words, “Ask AI”, or enter it from the label.</p>`;
  }

  let debounce;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => show(input.value.trim()), 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      input.blur();
      online(input.value.trim());
    }
  });

  el.addEventListener("click", (ev) => {
    const row = ev.target.closest("[data-food]");
    if (row) {
      const food = foodsById.get(row.dataset.food);
      if (food) openAmount(food, { meal, onDone: () => closeSheet(el) });
      return;
    }
    const a = ev.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    const q = input.value.trim();
    if (a === "online") online(q);
    else if (a === "ask-ai") openPhotoAI({ meal, description: q, autoRun: true, onDone: () => closeSheet(el) });
    else if (a === "photo") openPhotoAI({ meal, onDone: () => closeSheet(el) });
    else if (a === "barcode") openBarcode({ meal, onDone: () => closeSheet(el) });
    else if (a === "custom")
      openCustomFood({ prefill: { name: q }, onSaved: (food) => openAmount(food, { meal, onDone: () => closeSheet(el) }) });
    else if (a === "quick") openQuickAdd({ meal, onDone: () => closeSheet(el) });
  });

  show("");
  setTimeout(() => input.focus(), 300);
}

// ---------- Amount (grams) ----------
function openAmount(food, { meal, entry, onDone } = {}) {
  const units = food.units || [];
  const startGrams = entry?.grams ?? (units[0] && (food.source === "off" || food.source === "custom") ? units[0].g : 100);
  let grams = startGrams;
  let selMeal = entry?.meal || meal || defaultMeal();
  const canSave = food.source === "off" || food.source === "usda" || food.source === "db";
  const alreadySaved = state.foods.some((f) => f.id === food.id);

  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancel</button><h2>${entry ? "Edit entry" : "Add food"}</h2><span></span></div>
    <div class="amount">
      <h3 class="food-title">${esc(food.name)}</h3>
      <p class="muted">${esc(food.brand ? food.brand + " · " : "")}${sourceLabel(food)} · per 100 g: ${fmt(food.kcal)} kcal · P ${r1(food.p)} · C ${r1(food.c)} · F ${r1(food.f)}</p>
      <div class="grams-box"><input class="grams" inputmode="decimal" value="${r1(grams)}" aria-label="Grams"><span>g</span></div>
      ${units.length ? `<div class="serv">
        <input class="serv-qty" inputmode="decimal" value="1" aria-label="Servings">
        <span>×</span>
        <select class="serv-unit">${units.map((u, i) => `<option value="${i}">${esc(u.label)} (${r1(u.g)} g)</option>`).join("")}</select>
        <button class="btn ghost small" data-a="apply-serv" type="button">Use</button></div>` : ""}
      <div class="chips">${[50, 100, 150, 200, 250, 500].map((g) => `<button type="button" data-g="${g}">${g} g</button>`).join("")}</div>
      <div class="live">
        <div class="live-kcal"><b data-k>0</b><span>kcal</span></div>
        <div class="live-macros"><span>Protein <b data-p>0</b> g</span><span>Carbs <b data-c>0</b> g</span><span>Fat <b data-f>0</b> g</span></div>
      </div>
      ${mealPicker(selMeal)}
      <button class="btn primary big" data-a="save">${entry ? "Save changes" : "Add to diary"}</button>
      ${canSave && !alreadySaved && !entry ? `<button class="btn ghost" data-a="fav">☆ Save to My Foods</button>` : ""}
      ${entry ? `<button class="btn danger outline" data-a="delete">Delete entry</button>` : ""}
    </div>`);

  const gInput = $(".grams", el);
  const update = () => {
    const v = scale(food, grams);
    $("[data-k]", el).textContent = fmt(v.kcal);
    $("[data-p]", el).textContent = r1(v.p);
    $("[data-c]", el).textContent = r1(v.c);
    $("[data-f]", el).textContent = r1(v.f);
  };
  const setGrams = (g) => {
    grams = Math.max(0, g);
    gInput.value = r1(grams);
    update();
  };
  gInput.addEventListener("input", () => {
    grams = num(gInput.value);
    update();
  });
  gInput.addEventListener("focus", () => gInput.select());
  const applyServing = () => {
    const u = units[num($(".serv-unit", el).value)];
    setGrams(num($(".serv-qty", el).value) * u.g);
  };
  if (units.length) {
    $(".serv-qty", el).addEventListener("input", applyServing);
    $(".serv-unit", el).addEventListener("change", applyServing);
  }
  bindMealPicker(el, (m) => (selMeal = m));

  el.addEventListener("click", async (ev) => {
    const chip = ev.target.closest("[data-g]");
    if (chip) return setGrams(num(chip.dataset.g));
    const a = ev.target.closest("[data-a]")?.dataset.a;
    if (a === "apply-serv") applyServing();
    else if (a === "fav") {
      S.saveMyFood({ ...food });
      ev.target.closest("[data-a]").remove();
      toast("Saved to My Foods");
    } else if (a === "save") {
      if (!(grams > 0)) return toast("Enter how many grams");
      const v = scale(food, grams);
      const data = {
        meal: selMeal, name: food.name, brand: food.brand || "", grams: r1(grams),
        kcal: v.kcal, p: v.p, c: v.c, f: v.f,
        per: { kcal: food.kcal, p: food.p, c: food.c, f: food.f },
        units, source: food.source, foodId: food.id,
      };
      if (entry) S.updateEntry(curKey(), entry.id, data);
      else {
        S.addEntry(curKey(), data);
        S.rememberRecent(food);
        if (food.source === "off" && !state.foods.some((f) => f.id === food.id)) S.saveMyFood({ ...food });
      }
      toast(`${entry ? "Updated" : "Added"} ${fmt(v.kcal)} kcal to ${mealLabel(selMeal)}`);
      closeSheet(el);
      onDone?.();
      render();
    } else if (a === "delete") {
      if (await confirmDialog(`Delete “${food.name}”?`)) {
        S.deleteEntry(curKey(), entry.id);
        closeSheet(el);
        render();
      }
    }
  });
  update();
}

function editEntry(id) {
  const entry = S.entriesFor(curKey()).find((e) => e.id === id);
  if (!entry) return;
  if (!entry.per || !entry.grams) return openQuickAdd({ entry });
  const food = {
    id: entry.foodId || "entry" + entry.id, name: entry.name, brand: entry.brand,
    ...entry.per, units: entry.units || [], source: entry.source,
  };
  openAmount(food, { entry });
}

// ---------- Quick add ----------
function openQuickAdd({ meal, entry, onDone } = {}) {
  let selMeal = entry?.meal || meal || defaultMeal();
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancel</button><h2>${entry ? "Edit entry" : "Quick add"}</h2><span></span></div>
    <div class="form pad">
      <label>Name<input data-q="name" value="${esc(entry?.name || "")}" placeholder="e.g. Coffee with milk"></label>
      <label>Calories (kcal)<input data-q="kcal" inputmode="decimal" value="${entry ? r1(entry.kcal) : ""}"></label>
      <div class="grid3">
        <label>Protein g<input data-q="p" inputmode="decimal" value="${entry ? r1(entry.p) : ""}"></label>
        <label>Carbs g<input data-q="c" inputmode="decimal" value="${entry ? r1(entry.c) : ""}"></label>
        <label>Fat g<input data-q="f" inputmode="decimal" value="${entry ? r1(entry.f) : ""}"></label>
      </div>
      ${mealPicker(selMeal)}
      <button class="btn primary big" data-a="save">${entry ? "Save changes" : "Add to diary"}</button>
      ${entry ? `<button class="btn danger outline" data-a="delete">Delete entry</button>` : ""}
    </div>`);
  bindMealPicker(el, (m) => (selMeal = m));
  const val = (k) => num($(`[data-q=${k}]`, el).value);
  el.addEventListener("click", async (ev) => {
    const a = ev.target.closest("[data-a]")?.dataset.a;
    if (a === "save") {
      if (!(val("kcal") > 0)) return toast("Enter calories");
      const data = {
        meal: selMeal, name: $("[data-q=name]", el).value.trim() || "Quick add",
        grams: 0, kcal: val("kcal"), p: val("p"), c: val("c"), f: val("f"), source: "quick",
      };
      if (entry) S.updateEntry(curKey(), entry.id, data);
      else S.addEntry(curKey(), data);
      closeSheet(el);
      onDone?.();
      render();
      toast("Saved");
    } else if (a === "delete" && (await confirmDialog("Delete this entry?"))) {
      S.deleteEntry(curKey(), entry.id);
      closeSheet(el);
      render();
    }
  });
}

// ---------- Custom / packaged food from nutrition label ----------
function openCustomFood({ prefill = {}, edit, onSaved } = {}) {
  const f = edit || {};
  const unit = f.units?.[0];
  // When editing, show values per serving if a serving exists.
  const servG = unit?.g || "";
  const per = (k) => (edit ? r1(unit ? (f[k] * unit.g) / 100 : f[k]) : "");
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancel</button><h2>${edit ? "Edit food" : "Food from label"}</h2><span></span></div>
    <div class="form pad">
      <p class="hint">Copy the numbers from the package's Nutrition Facts label. The app converts them so you can log any gram amount.</p>
      <label>Name *<input data-c="name" value="${esc(f.name || prefill.name || "")}" placeholder="e.g. Chobani Greek Yogurt Vanilla"></label>
      <label>Brand<input data-c="brand" value="${esc(f.brand || "")}"></label>
      <div class="seg" data-basis>
        <button type="button" data-b="serving" class="${!edit || unit ? "on" : ""}">Per serving</button>
        <button type="button" data-b="100" class="${edit && !unit ? "on" : ""}">Per 100 g</button>
      </div>
      <div class="grid2 serving-fields">
        <label>Serving size (g) *<input data-c="servG" inputmode="decimal" value="${esc(servG)}" placeholder="e.g. 150"></label>
        <label>Serving name<input data-c="servName" value="${esc(unit?.label || "")}" placeholder="e.g. 1 cup, 1 bar"></label>
      </div>
      <label>Calories *<input data-c="kcal" inputmode="decimal" value="${per("kcal")}"></label>
      <div class="grid3">
        <label>Protein g<input data-c="p" inputmode="decimal" value="${per("p")}"></label>
        <label>Carbs g<input data-c="c" inputmode="decimal" value="${per("c")}"></label>
        <label>Fat g<input data-c="f" inputmode="decimal" value="${per("f")}"></label>
      </div>
      <label>Barcode (optional)<input data-c="barcode" inputmode="numeric" value="${esc(f.barcode || prefill.barcode || "")}"></label>
      <button class="btn primary big" data-a="save">Save food</button>
      ${edit ? `<button class="btn danger outline" data-a="delete">Delete food</button>` : ""}
    </div>`);
  let basis = !edit || unit ? "serving" : "100";
  const syncBasis = () => ($(".serving-fields", el).style.display = basis === "serving" ? "" : "none");
  $$("[data-basis] button", el).forEach((b) =>
    b.addEventListener("click", () => {
      basis = b.dataset.b;
      $$("[data-basis] button", el).forEach((x) => x.classList.toggle("on", x === b));
      syncBasis();
    })
  );
  syncBasis();
  const v = (k) => $(`[data-c=${k}]`, el).value.trim();
  el.addEventListener("click", async (ev) => {
    const a = ev.target.closest("[data-a]")?.dataset.a;
    if (a === "save") {
      const name = v("name");
      const kcal = num(v("kcal"));
      const sg = num(v("servG"));
      if (!name) return toast("Enter a name");
      if (!(kcal >= 0) || v("kcal") === "") return toast("Enter calories");
      if (basis === "serving" && !(sg > 0)) return toast("Enter the serving size in grams");
      const factor = basis === "serving" ? 100 / sg : 1;
      const food = {
        id: f.id || "my" + S.uid(),
        name, brand: v("brand"), barcode: v("barcode"),
        kcal: r1(kcal * factor), p: r1(num(v("p")) * factor), c: r1(num(v("c")) * factor), f: r1(num(v("f")) * factor),
        units: basis === "serving" ? [{ label: v("servName") || "1 serving", g: sg }] : [],
        source: "custom",
      };
      S.saveMyFood(food);
      toast("Food saved");
      closeSheet(el);
      onSaved?.(food);
    } else if (a === "delete" && (await confirmDialog(`Delete “${f.name}” from My Foods?`))) {
      S.deleteMyFood(f.id);
      closeSheet(el);
      render();
    }
  });
}

// ---------- Barcode ----------
function openBarcode({ meal, onDone, saveOnly } = {}) {
  let stop = null;
  const el = openSheet(
    `<div class="sheet-head"><button class="link" data-close>Cancel</button><h2>Scan barcode</h2><span></span></div>
    <div class="pad">
      <div class="video-wrap"><video playsinline muted autoplay></video><div class="scan-line"></div></div>
      <p class="status muted">Starting camera…</p>
      <label class="btn ghost file-btn">📷 Take a photo of the barcode instead<input type="file" accept="image/*" capture="environment" hidden></label>
      <div class="row gap"><input class="manual" inputmode="numeric" placeholder="Or type the barcode number"><button class="btn" data-a="lookup">Look up</button></div>
    </div>`,
    { onClose: () => stop?.() }
  );
  const status = $(".status", el);

  async function handle(code) {
    stop?.();
    status.textContent = `Found ${code}. Looking it up…`;
    const mine = state.foods.find((f) => f.barcode === code);
    let food = mine;
    if (!food) {
      try {
        food = await lookupBarcode(code, state.settings.usdaKey);
      } catch {
        status.textContent = "Lookup failed — check your connection.";
        return;
      }
    }
    if (!stack.some((s) => s.el === el)) return;
    closeSheet(el);
    if (food) {
      if (saveOnly) {
        S.saveMyFood(food);
        toast(`Saved “${food.name}” to My Foods`);
        render();
      } else openAmount(food, { meal, onDone });
    } else {
      toast("Not in the database — enter it from the label");
      openCustomFood({
        prefill: { barcode: code },
        onSaved: (f) => (saveOnly ? render() : openAmount(f, { meal, onDone })),
      });
    }
  }

  (async () => {
    try {
      stop = await startBarcodeScan($("video", el), handle);
      status.textContent = "Point the camera at the barcode.";
    } catch (e) {
      status.textContent = "Camera unavailable here. Take a photo of the barcode or type the number.";
    }
  })();

  $("input[type=file]", el).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    status.textContent = "Reading barcode…";
    try {
      handle(await decodeBarcodeFromFile(file));
    } catch {
      status.textContent = "Couldn't read a barcode in that photo. Try again closer, or type the number.";
    }
  });
  el.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-a=lookup]")) {
      const code = $(".manual", el).value.replace(/\D/g, "");
      if (code.length >= 6) handle(code);
      else toast("Enter the full barcode number");
    }
  });
}

// ---------- Photo AI ----------
function openPhotoAI({ meal, description = "", autoRun = false, onDone } = {}) {
  let selMeal = meal || defaultMeal();
  let imageB64 = null;
  let items = [];
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancel</button><h2>AI Meal Scan</h2><span></span></div>
    <div class="pad">
      ${state.settings.apiKey ? "" : `<div class="notice">Add your Anthropic API key in <b>Settings</b> to use AI scanning. <button class="btn small" data-a="go-settings">Open Settings</button></div>`}
      <div class="photo-box">
        <img class="preview" alt="" hidden>
        <div class="photo-btns">
          <label class="btn primary file-btn">📷 Take photo<input type="file" accept="image/*" capture="environment" data-in="cam" hidden></label>
          <label class="btn ghost file-btn">🖼️ Library<input type="file" accept="image/*" data-in="lib" hidden></label>
        </div>
      </div>
      <label class="note-label">Details (optional — improves accuracy)
        <textarea rows="2" placeholder="e.g. about 200 g rice, chicken cooked in 1 tbsp olive oil">${esc(description)}</textarea></label>
      <button class="btn primary big" data-a="analyze">✨ Analyze calories</button>
      <div class="ai-out"></div>
    </div>`);
  const out = $(".ai-out", el);
  const preview = $(".preview", el);

  $$("input[type=file]", el).forEach((inp) =>
    inp.addEventListener("change", async () => {
      const file = inp.files[0];
      if (!file) return;
      try {
        imageB64 = await imageToBase64(file);
        preview.src = "data:image/jpeg;base64," + imageB64;
        preview.hidden = false;
        out.innerHTML = "";
        analyze();
      } catch (e) {
        toast(e.message);
      }
    })
  );

  async function analyze() {
    const desc = $("textarea", el).value.trim();
    if (!imageB64 && !desc) return toast("Take a photo or describe the meal");
    if (!state.settings.apiKey) return toast("Add your API key in Settings first");
    const btn = $("[data-a=analyze]", el);
    btn.disabled = true;
    out.innerHTML = `<div class="loading"><span class="spinner"></span>Analyzing your meal… this takes 10–40 seconds.</div>`;
    try {
      const res = await analyzeMeal({ apiKey: state.settings.apiKey, model: state.settings.model, imageBase64: imageB64, description: desc });
      items = res.items.map((it) => ({
        ...it,
        on: true,
        per: {
          kcal: (it.calories / it.grams) * 100,
          p: (it.protein_g / it.grams) * 100,
          c: (it.carbs_g / it.grams) * 100,
          f: (it.fat_g / it.grams) * 100,
        },
      }));
      showResults(res.notes);
    } catch (e) {
      out.innerHTML = `<div class="notice error">${esc(e.message || "Something went wrong")}</div>`;
    } finally {
      btn.disabled = false;
    }
  }

  function totalsText() {
    const t = sum(items.filter((i) => i.on).map((i) => scale(i.per, i.grams)));
    return `${fmt(t.kcal)} kcal · P ${fmt(t.p)} g · C ${fmt(t.c)} g · F ${fmt(t.f)} g`;
  }

  function showResults(notes) {
    if (!items.length) {
      out.innerHTML = `<div class="notice">No food found. ${esc(notes || "")}</div>`;
      return;
    }
    out.innerHTML = `
      <h4>Detected foods <small class="muted">— adjust grams if you know them</small></h4>
      <div class="ai-items">${items.map((it, i) => `
        <div class="ai-item" data-i="${i}">
          <input type="checkbox" ${it.on ? "checked" : ""} aria-label="Include">
          <div class="ai-mid"><input class="ai-name" value="${esc(it.name)}">
            <span class="conf ${it.confidence}">${it.confidence} confidence</span></div>
          <div class="ai-g"><input class="ai-grams" inputmode="decimal" value="${r1(it.grams)}"><span>g</span></div>
          <b class="ai-kcal">${fmt(scale(it.per, it.grams).kcal)}</b>
        </div>`).join("")}</div>
      ${notes ? `<p class="hint">${esc(notes)}</p>` : ""}
      <div class="ai-total">Total: <b>${totalsText()}</b></div>
      ${mealPicker(selMeal)}
      <button class="btn primary big" data-a="add-all">Add to diary</button>
      <p class="hint">Photo estimates are approximate (±20% is typical). For exact numbers, weigh the food and adjust grams.</p>`;
    bindMealPicker(out, (m) => (selMeal = m));
    $$(".ai-item", out).forEach((row) => {
      const it = items[num(row.dataset.i)];
      const refresh = () => {
        $(".ai-kcal", row).textContent = fmt(scale(it.per, it.grams).kcal);
        $(".ai-total b", out).textContent = totalsText();
      };
      $("input[type=checkbox]", row).addEventListener("change", (e) => {
        it.on = e.target.checked;
        row.classList.toggle("off", !it.on);
        refresh();
      });
      $(".ai-grams", row).addEventListener("input", (e) => {
        it.grams = num(e.target.value);
        refresh();
      });
      $(".ai-name", row).addEventListener("input", (e) => (it.name = e.target.value));
    });
  }

  el.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-a]")?.dataset.a;
    if (a === "analyze") analyze();
    else if (a === "go-settings") {
      closeAllSheets();
      view = "settings";
      render();
    } else if (a === "add-all") {
      const chosen = items.filter((i) => i.on && i.grams > 0);
      if (!chosen.length) return toast("Nothing selected");
      for (const it of chosen) {
        const v = scale(it.per, it.grams);
        S.addEntry(curKey(), {
          meal: selMeal, name: it.name || "Food", grams: r1(it.grams),
          kcal: v.kcal, p: v.p, c: v.c, f: v.f,
          per: { kcal: r1(it.per.kcal), p: r1(it.per.p), c: r1(it.per.c), f: r1(it.per.f) },
          units: [], source: "ai",
        });
      }
      toast(`Added ${chosen.length} item${chosen.length > 1 ? "s" : ""} to ${mealLabel(selMeal)}`);
      closeSheet(el);
      onDone?.();
      render();
    }
  });

  if (autoRun && description) analyze();
}

// ---------- boot ----------
render();
navigator.storage?.persist?.().catch(() => {});
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
// Refresh "Today" if the app stays open past midnight.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && view === "diary") render();
});
