import { FOOD_DB } from "./foods.js";
import { analyzeMeal, imageToBase64, looksLikeAnthropicKey, MODELS } from "./ai.js";
import { searchUSDA, searchBranded, searchOFF, lookupBarcode, startBarcodeScan, decodeBarcodeFromFile } from "./online.js";
import * as S from "./store.js";
import { MEALS, mealLabel, $, $$, esc, fmt, r1, num, scale, sum, parseKey, startOfDay, addDays, formatBytes } from "./util.js";
import { renderTrends, bindTrends, kgToUnit, unitToKg } from "./trends.js";

const { state } = S;

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

// ---------- icons (inline SVG, stroke = currentColor) ----------
const ICONS = {
  chevL: '<path d="M15 18l-6-6 6-6"/>',
  chevR: '<path d="M9 18l6-6-6-6"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  scale: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8.5 9.5a5 5 0 0 1 7 0L12 13z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
};
const icon = (name, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------- main render ----------
let booted = false;
function render() {
  if (!booted) return;
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  const v = $("#view");
  if (view === "diary") {
    v.innerHTML = renderDiary();
    centerDayStrip(v);
  } else if (view === "history") {
    v.innerHTML = renderTrends();
    bindTrends(v, (range) => {
      state.settings.histRange = range;
      S.persist.settings();
      render();
    });
  } else if (view === "foods") v.innerHTML = renderMyFoods();
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
  const r = 52;
  const c = 2 * Math.PI * r;
  const pct = goal > 0 ? Math.min(eaten / goal, 1) : 0;
  const over = eaten > goal;
  return `<svg viewBox="0 0 130 130" class="ring">
    <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="rg-a"/><stop offset="1" class="rg-b"/></linearGradient></defs>
    <circle cx="65" cy="65" r="${r}" class="ring-bg"/>
    <circle cx="65" cy="65" r="${r}" class="ring-fg ${over ? "over" : ""}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}" transform="rotate(-90 65 65)"/>
  </svg>`;
}

function macroBar(label, val, goal, cls) {
  const pct = goal > 0 ? Math.min((val / goal) * 100, 100) : 0;
  return `<div class="macro"><div class="macro-top"><i class="key bar-key ${cls}"></i>${label}</div>
    <div class="macro-val"><b>${fmt(val)}</b><small>${goal ? ` / ${fmt(goal)}` : ""} g</small></div>
    <div class="bar"><div class="${cls}" style="width:${pct}%"></div></div></div>`;
}

function macroLine(t) {
  return `<span class="mp">P ${fmt(t.p)}g</span><span class="mc">C ${fmt(t.c)}g</span><span class="mf">F ${fmt(t.f)}g</span>`;
}

// Scrollable day strip: every day from the first day you used the app up to today
// (a new day appears at local midnight). Each day shows how close it got to the goal.
function stripStartKey() {
  let first = state.settings.firstUse || curKey();
  // Also reach back to any older logged day (e.g. from an imported backup) or the day being viewed.
  for (const k of [...Object.keys(state.entries), ...Object.keys(state.weights), curKey()]) if (k < first) first = k;
  return first;
}
function dayStrip() {
  const goal = state.settings.goal;
  const today = startOfDay(new Date());
  const todayK = S.dayKey(today);
  const items = [];
  for (let d = parseKey(stripStartKey()), i = 0; d <= today; d = addDays(d, 1), i++) {
    const k = S.dayKey(d);
    const kcal = sum(S.entriesFor(k)).kcal;
    const pct = goal > 0 ? Math.min(kcal / goal, 1) : 0;
    // The first day shown and each 1st of the month show the month instead of the weekday letter.
    const monthTag = i === 0 || d.getDate() === 1;
    items.push(`<button class="wd${k === curKey() ? " on" : ""}${k === todayK ? " today" : ""}" data-act="goto-day" data-key="${k}"
      aria-label="${esc(d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }))}: ${fmt(kcal)} kcal">
      <span class="wd-l${monthTag ? " m" : ""}">${esc(d.toLocaleDateString(undefined, monthTag ? { month: "short" } : { weekday: "narrow" }))}</span>
      <span class="wd-n">${d.getDate()}</span>
      <span class="wd-ring${kcal > goal ? " over" : ""}" style="--pct:${pct.toFixed(3)}"></span></button>`);
  }
  return `<div class="week" data-strip>${items.join("")}</div>`;
}
function centerDayStrip(root) {
  const strip = $("[data-strip]", root);
  const on = strip && $(".wd.on", strip);
  if (on) strip.scrollLeft = on.offsetLeft - (strip.clientWidth - on.offsetWidth) / 2;
}

function renderDiary() {
  const list = S.entriesFor(curKey());
  const t = sum(list);
  const goal = state.settings.goal;
  const left = goal - t.kcal;
  const isToday = curKey() === S.dayKey(new Date());
  const kg = state.weights[curKey()];
  const wu = state.settings.weightUnit === "kg" ? "kg" : "lb";
  return `
  <header class="topbar diary-top">
    <button class="date-title" data-act="today" aria-label="Go to today">
      <span class="eyebrow">${esc(current.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }))}</span>
      <h1>${dayTitle(current)}</h1></button>
    <div class="nav-btns">
      <button class="icon-btn" data-act="prev-day" aria-label="Previous day">${icon("chevL")}</button>
      <button class="icon-btn" data-act="next-day" aria-label="Next day" ${isToday ? "disabled" : ""}>${icon("chevR")}</button>
    </div>
  </header>
  ${dayStrip()}
  <section class="card summary">
    <div class="sum-top">
      <div class="ring-wrap">${ring(t.kcal, goal)}
        <div class="ring-center"><b class="${left < 0 ? "neg" : ""}">${fmt(Math.abs(left))}</b><span>${left < 0 ? "kcal over" : "kcal left"}</span></div>
      </div>
      <div class="sum-side">
        <div class="sum-stat"><span>Goal</span><b>${fmt(goal)}</b></div>
        <div class="sum-stat"><span>Eaten</span><b>${fmt(t.kcal)}</b></div>
        <button class="sum-stat weight-stat" data-act="log-weight" data-key="${curKey()}"><span>${icon("scale")}Weight</span>
          <b>${kg ? `${r1(kgToUnit(kg)).toFixed(1)}<small> ${wu}</small>` : `<em>＋ Log</em>`}</b></button>
      </div>
    </div>
    <div class="macros3">
      ${macroBar("Protein", t.p, state.settings.protein, "p")}
      ${macroBar("Carbs", t.c, state.settings.carbs, "c")}
      ${macroBar("Fat", t.f, state.settings.fat, "f")}
    </div>
  </section>
  <button class="scan-cta" data-act="photo"><span class="cta-icon">${icon("camera")}</span>
    <span class="cta-text"><b>Snap a meal</b><small>AI estimates the calories in the whole plate</small></span>${icon("chevR", "cta-chev")}</button>
  ${MEALS.map((m) => {
    const items = list.filter((e) => e.meal === m.id);
    const mt = sum(items);
    return `<section class="card meal">
      <div class="meal-head"><span class="meal-icon ${m.id}">${m.icon}</span>
        <div class="meal-title"><b>${m.label}</b>${items.length ? `<div class="meal-macros">${macroLine(mt)}</div>` : `<small class="muted">Nothing logged yet</small>`}</div>
        <span class="kcal">${fmt(mt.kcal)}<small>kcal</small></span></div>
      ${items.length ? `<ul class="entries">${items.map((e) => `
        <li data-act="edit-entry" data-id="${esc(e.id)}">
          <div class="e-main"><span class="e-name">${e.kind === "smoothie" ? "🥤 " : ""}${esc(e.name)}</span>
          <span class="e-sub">${e.grams ? `${fmt(e.grams)} g` : "Quick add"}${e.brand ? ` · ${esc(e.brand)}` : ""}${e.source === "ai" ? " · AI" : ""}</span>
          <span class="e-macros">${macroLine(e)}</span></div>
          <span class="e-kcal">${fmt(e.kcal)}<small>kcal</small></span></li>`).join("")}</ul>` : ""}
      <button class="add-btn" data-act="add" data-meal="${m.id}">${icon("plus")}Add food</button>
    </section>`;
  }).join("")}
  <p class="foot">Nutrition per gram from USDA FoodData Central, Open Food Facts and your labels.</p>`;
}

function renderMyFoods() {
  return `
  <header class="topbar"><div><p class="eyebrow">${state.foods.length} saved</p><h1>My Foods</h1></div></header>
  <div class="action-grid">
    <button class="action" data-act="new-smoothie"><span class="action-icon">🥤</span><b>New smoothie</b><small>Build from ingredients</small></button>
    <button class="action" data-act="new-custom"><span class="action-icon">🏷️</span><b>From label</b><small>Enter Nutrition Facts</small></button>
    <button class="action" data-act="scan-to-foods"><span class="action-icon">▦</span><b>Scan barcode</b><small>Packaged foods</small></button>
  </div>
  <section class="card list">
    ${state.foods.length ? state.foods.map((f) => `<button class="food-row" data-act="edit-food" data-id="${esc(f.id)}">
      <div><span class="e-name">${f.kind === "smoothie" ? "🥤 " : ""}${esc(f.name)}</span><span class="e-sub">${f.kind === "smoothie" ? `${f.ingredients.length} ingredients · whole = ${fmt(f.kcal * f.units[0].g / 100)} kcal` : `${esc(f.brand || sourceLabel(f))}${f.units?.[0] ? ` · ${esc(f.units[0].label)} = ${fmt(f.units[0].g)} g` : ""}`}</span></div>
      <span class="e-kcal">${fmt(f.kcal)}<small>/100g</small></span></button>`).join("")
      : `<p class="empty">Packaged foods you scan or enter from a nutrition label are saved here so you can add them again in one tap.</p>`}
  </section>`;
}

function renderSettings() {
  const s = state.settings;
  return `
  <header class="topbar"><div><p class="eyebrow">Calorie Tracker</p><h1>Settings</h1></div></header>
  <section class="card form">
    <h3>Daily goals</h3>
    <label>Calories<input data-set="goal" inputmode="numeric" value="${esc(s.goal)}"></label>
    <div class="grid3">
      <label>Protein g<input data-set="protein" inputmode="numeric" value="${esc(s.protein)}"></label>
      <label>Carbs g<input data-set="carbs" inputmode="numeric" value="${esc(s.carbs)}"></label>
      <label>Fat g<input data-set="fat" inputmode="numeric" value="${esc(s.fat)}"></label>
    </div>
    <label>Body weight unit</label>
    <div class="seg" data-unit-picker>${["lb", "kg"].map((u) => `<button type="button" data-unit="${u}" class="${(s.weightUnit || "lb") === u ? "on" : ""}">${u === "lb" ? "Pounds (lb)" : "Kilograms (kg)"}</button>`).join("")}</div>
  </section>
  <section class="card form">
    <h3>AI photo scanning</h3>
    <p class="hint">Photo scans use Claude through your own Anthropic API key. Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com</a>. The key is stored only on this phone, is never shown again after you save it, is never included in backups, and is sent only to api.anthropic.com. A scan costs roughly a few cents.</p>
    ${S.getApiKey()
      ? `<div class="key-saved"><span>🔒 Key saved: <code>${esc(S.maskedApiKey())}</code></span>
          <div class="row gap"><button class="btn ghost small" data-act="replace-key">Replace</button>
          <button class="btn danger outline small" data-act="remove-key">Remove</button></div></div>`
      : `<label>Anthropic API key
          <div class="row"><input class="key-input" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="sk-ant-...">
          <button class="btn small" data-act="save-key" type="button">Save</button></div></label>`}
    <label>Model<select data-set="model">${MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? "selected" : ""}>${m.label}</option>`).join("")}</select></label>
  </section>
  <section class="card form">
    <h3>Food search</h3>
    <p class="hint">Online search uses USDA FoodData Central (generic + branded/packaged foods) and Open Food Facts (barcodes). The shared demo key allows only ~30 searches an hour, so get your own free key (instant, by email) at <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener">fdc.nal.usda.gov</a> and paste it here.</p>
    <label>USDA API key (optional)<input data-set="usdaKey" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="DEMO_KEY" value="${esc(s.usdaKey)}"></label>
  </section>
  <section class="card form">
    <h3>Storage & backups</h3>
    <div class="storage" data-storage><div class="loading"><div class="spinner"></div>Checking storage…</div></div>
    <div class="row gap"><button class="btn ghost" data-act="export">Export backup</button>
    <label class="btn ghost file-btn">Import backup<input type="file" accept="application/json,.json" data-act-file="import" hidden></label></div>
    <button class="btn danger outline" data-act="wipe">Erase all data</button>
  </section>
  <p class="foot">Calorie Tracker · runs entirely on your phone</p>`;
}

function ago(ts) {
  if (!ts) return "never";
  const days = Math.floor((Date.now() - ts) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

async function fillStorage(box) {
  const info = await S.storageInfo();
  const data = info.diaryBytes + info.localBytes;
  // Growth rate: diary size spread over the days since the first entry (at least a week).
  const spanDays = info.firstDay ? Math.max(7, Math.round((Date.now() - parseKey(info.firstDay)) / 86400000) + 1) : 0;
  const perDay = spanDays ? info.diaryBytes / spanDays : 0;
  let room;
  let pct;
  let limitText;
  if (info.backend === "idb" && info.quota) {
    const free = Math.max(0, info.quota - (info.usage || 0));
    pct = ((info.usage || 0) / info.quota) * 100;
    limitText = `${formatBytes(info.usage)} used of ${formatBytes(info.quota)} this app may use`;
    room = perDay ? free / perDay / 365 : null;
  } else {
    const limit = info.backend === "idb" ? null : S.LOCAL_STORAGE_LIMIT;
    pct = limit ? (data / limit) * 100 : null;
    limitText = limit ? `${formatBytes(data)} used of about ${formatBytes(limit)}` : `${formatBytes(data)} used`;
    room = limit && perDay ? Math.max(0, limit - data) / perDay / 365 : null;
  }
  const years = room == null ? "" : room > 100 ? "more than 100 years" : room >= 1 ? `about ${Math.floor(room)} year${Math.floor(room) === 1 ? "" : "s"}` : `about ${Math.max(1, Math.round(room * 12))} months`;
  const stale = Date.now() - (state.settings.lastBackup || 0) > 30 * 86400000 && info.daysLogged > 0;
  box.innerHTML = `
    <div class="storage-meter"><div style="width:${Math.min(100, Math.max(pct || 0, 0.5)).toFixed(1)}%"></div></div>
    <p class="storage-line"><b>${esc(limitText)}</b></p>
    <ul class="storage-facts">
      <li><span>Your log</span><b>${formatBytes(info.diaryBytes)} · ${info.daysLogged} day${info.daysLogged === 1 ? "" : "s"}</b></li>
      ${perDay ? `<li><span>Growth</span><b>~${formatBytes(Math.round(perDay))} per day</b></li>` : ""}
      ${years ? `<li><span>Room left at this pace</span><b>${years}</b></li>` : ""}
      <li><span>Kept in</span><b>${info.backend === "idb" ? "IndexedDB on this phone" : "Local storage on this phone"}</b></li>
      ${info.persisted != null ? `<li><span>Protected from cleanup</span><b>${info.persisted ? "Yes" : "Not yet"}</b></li>` : ""}
      <li><span>Last backup</span><b class="${stale ? "over-text" : ""}">${ago(state.settings.lastBackup)}</b></li>
    </ul>
    <p class="hint">Your data never leaves this phone, isn't synced to iCloud, and isn't on GitHub. Deleting the Home Screen icon deletes the data with it, so export a backup now and then (to Files or iCloud Drive).</p>`;
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
  $$("[data-unit]", root).forEach((b) =>
    b.addEventListener("click", () => {
      state.settings.weightUnit = b.dataset.unit;
      S.persist.settings();
      $$("[data-unit]", root).forEach((x) => x.classList.toggle("on", x === b));
      toast("Saved");
    })
  );
  $("[data-act-file=import]", root).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await S.importData(await file.text());
      toast("Backup imported");
      render();
    } catch (err) {
      toast(err.message);
    }
  });
  fillStorage($("[data-storage]", root)).catch(() => ($("[data-storage]", root).innerHTML = ""));
}

// ---------- body weight ----------
function openWeight(key = S.dayKey(new Date())) {
  const u = state.settings.weightUnit === "kg" ? "kg" : "lb";
  const existing = state.weights[key];
  // Pre-fill with the most recent weigh-in so a small change is quick to enter.
  const lastKey = Object.keys(state.weights).filter((k) => k <= key).sort().at(-1);
  const start = existing || (lastKey ? state.weights[lastKey] : 0);
  const el = openSheet(
    `<div class="sheet-head"><button class="link" data-close>Cancel</button><h2>Weight</h2><span></span></div>
    <div class="pad form weight-form">
      <label>Date<input type="date" class="w-date" value="${esc(key)}" max="${S.dayKey(new Date())}"></label>
      <div class="grams-box"><input class="grams w-val" inputmode="decimal" placeholder="0.0" value="${start ? r1(kgToUnit(start)).toFixed(1) : ""}"><span>${u}</span></div>
      <p class="hint center">Weigh in at the same time of day (e.g. mornings) for the cleanest trend.</p>
      <button class="btn big" data-a="save">Save weight</button>
      ${existing ? `<button class="btn danger outline" data-a="delete">Delete this weigh-in</button>` : ""}
    </div>`,
    { small: true }
  );
  const valInput = $(".w-val", el);
  setTimeout(() => valInput.focus(), 300);
  el.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-a]")?.dataset.a;
    const day = $(".w-date", el).value || key;
    if (a === "save") {
      const v = num(valInput.value);
      if (!(v > 0 && v < 1500)) return toast(`Enter your weight in ${u}`);
      S.setWeight(day, unitToKg(v));
      toast(`Saved ${r1(v).toFixed(1)} ${u}`);
      closeSheet(el);
      render();
    } else if (a === "delete") {
      S.setWeight(key, 0);
      closeSheet(el);
      render();
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
  else if (act === "new-smoothie") openSmoothie({ meal: defaultMeal() });
  else if (act === "edit-food") {
    const food = state.foods.find((f) => f.id === t.dataset.id);
    if (food?.kind === "smoothie") openSmoothie({ edit: food, meal: defaultMeal() });
    else if (food) openCustomFood({ edit: food, onSaved: () => render() });
  }
  else if (act === "scan-to-foods") openBarcode({ meal: defaultMeal(), saveOnly: true });
  else if (act === "log-weight") openWeight(t.dataset.key || S.dayKey(new Date()));
  else if (act === "save-key") {
    const inp = $(".key-input");
    const key = inp.value.replace(/\s+/g, "");
    if (!looksLikeAnthropicKey(key)) return toast("That doesn't look like an Anthropic key (it should start with sk-ant-)");
    try {
      S.setApiKey(key);
    } catch {
      return toast("Couldn't save the key on this device");
    }
    inp.value = "";
    toast("Key saved");
    render();
  }
  else if (act === "replace-key") {
    if (await confirmDialog("Remove the saved key so you can paste a new one?", "Replace key")) {
      S.clearApiKey();
      render();
    }
  }
  else if (act === "remove-key") {
    if (await confirmDialog("Remove your Anthropic API key from this phone? AI scanning will stop working until you add one again.", "Remove key")) {
      S.clearApiKey();
      toast("Key removed from this phone");
      render();
    }
  }
  else if (act === "export") exportBackup();
  else if (act === "wipe") {
    if (await confirmDialog("Erase ALL entries, weigh-ins, foods, settings and your API key on this device? This cannot be undone.", "Erase everything")) {
      await S.eraseAll();
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
  const done = () => {
    S.markBackedUp();
    if (view === "settings") render();
  };
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Calorie Tracker backup" });
      return done();
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  done();
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
    <div><span class="e-name">${f.kind === "smoothie" ? "🥤 " : ""}${esc(f.name)}</span><span class="e-sub">${esc(f.brand ? `${f.brand} · ` : "")}${f.kind === "smoothie" ? "My smoothie" : sourceLabel(f)}</span></div>
    <span class="e-kcal">${fmt(f.kcal)}<small>/100g</small></span></button>`;
}

// onPick: when set, the sheet is used to choose an ingredient (smoothie builder)
// instead of logging to the diary. onPick(food, grams) is called with the result.
function openAddFood(meal, { onPick } = {}) {
  const foodsById = new Map();
  const picking = !!onPick;
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancel</button><h2>${picking ? "Add ingredient" : `Add to ${mealLabel(meal)}`}</h2><span></span></div>
    <div class="search"><input type="search" placeholder="${picking ? "Search (e.g. banana, milk, protein powder)" : "Search foods (e.g. strawberries, ground turkey)"}" autocomplete="off" enterkeyhint="search"></div>
    <div class="quick-actions ${picking ? "two" : ""}">
      ${picking ? "" : `<button data-a="photo"><span>📷</span>Photo AI</button>`}
      ${picking ? "" : `<button data-a="smoothie"><span>🥤</span>Smoothie</button>`}
      <button data-a="barcode"><span>▦</span>Barcode</button>
      <button data-a="custom"><span>🏷️</span>Label</button>
      ${picking ? "" : `<button data-a="quick"><span>⚡</span>Quick</button>`}
    </div>
    <div class="results"></div>`);
  // Where a chosen food goes: into the diary, or back to the smoothie builder.
  const choose = (food) =>
    picking
      ? openAmount(food, { pick: (f, grams) => { closeSheet(el); onPick(f, grams); } })
      : openAmount(food, { meal, onDone: () => closeSheet(el) });
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
      if (food) choose(food);
      return;
    }
    const a = ev.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    const q = input.value.trim();
    if (a === "online") online(q);
    else if (a === "ask-ai") openPhotoAI({ meal, description: q, autoRun: true, onDone: () => closeSheet(el) });
    else if (a === "photo") openPhotoAI({ meal, onDone: () => closeSheet(el) });
    else if (a === "smoothie") openSmoothie({ meal, onDone: () => closeSheet(el) });
    else if (a === "barcode") openBarcode({ meal, onFood: choose });
    else if (a === "custom") openCustomFood({ prefill: { name: q }, onSaved: choose });
    else if (a === "quick") openQuickAdd({ meal, onDone: () => closeSheet(el) });
  });

  show("");
  setTimeout(() => input.focus(), 300);
}

// ---------- Amount (grams) ----------
const isProteinPowder = (f) => /protein powder|whey|casein|protein isolate|plant protein|protein shake mix/i.test(f.name || "");

/**
 * Grams screen. Modes:
 *  - log a food to the diary (default), or edit an existing diary `entry`
 *  - `pick(food, grams)`: choose an amount for a smoothie ingredient
 * Every food has an "Adjust calories & macros" panel; it opens automatically
 * for protein powder so you can match your tub's label.
 */
function openAmount(orig, { meal, entry, onDone, pick, initialGrams } = {}) {
  let food = { ...orig, units: (orig.units || []).map((u) => ({ ...u })) };
  const units = food.units;
  const powder = isProteinPowder(food);
  const smoothie = food.kind === "smoothie";
  const preferServing = units[0] && (["off", "custom"].includes(food.source) || powder || smoothie);
  let grams = initialGrams ?? entry?.grams ?? (preferServing ? units[0].g : 100);
  let selMeal = entry?.meal || meal || defaultMeal();
  const canSave = !pick && ["off", "usda", "db"].includes(food.source);
  const alreadySaved = state.foods.some((f) => f.id === food.id);
  const base = units[0]; // label basis for the adjust panel (per serving if known, else per 100 g)
  const perBase = (k) => r1(base ? (food[k] * base.g) / 100 : food[k]);
  let adjusted = false;

  const perInfo = () =>
    `${esc(food.brand ? food.brand + " · " : "")}${sourceLabel(food)} · per 100 g: ${fmt(food.kcal)} kcal · P ${r1(food.p)} · C ${r1(food.c)} · F ${r1(food.f)}`;

  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancel</button><h2>${pick ? "Add ingredient" : entry ? "Edit entry" : "Add food"}</h2><span></span></div>
    <div class="amount">
      <h3 class="food-title">${smoothie ? "🥤 " : ""}${esc(food.name)}</h3>
      <p class="muted per-info">${perInfo()}</p>
      <div class="grams-box"><input class="grams" inputmode="decimal" value="${r1(grams)}" aria-label="Grams"><span>g</span></div>
      ${units.length ? `<div class="serv">
        <input class="serv-qty" inputmode="decimal" value="${units[0] ? r1(grams / units[0].g) : 1}" aria-label="Servings">
        <span>×</span>
        <select class="serv-unit">${units.map((u, i) => `<option value="${i}">${esc(u.label)} (${r1(u.g)} g)</option>`).join("")}</select>
        <button class="btn ghost small" data-a="apply-serv" type="button">Use</button></div>` : ""}
      <div class="chips">${(pick ? [15, 30, 50, 100, 150, 250] : [50, 100, 150, 200, 250, 500]).map((g) => `<button type="button" data-g="${g}">${g} g</button>`).join("")}</div>
      <div class="live">
        <div class="live-kcal"><b data-k>0</b><span>kcal</span></div>
        <div class="live-macros"><span class="mp">Protein <b data-p>0</b> g</span><span class="mc">Carbs <b data-c>0</b> g</span><span class="mf">Fat <b data-f>0</b> g</span></div>
      </div>
      ${smoothie ? `<div class="sm-contents"><h4>What's in it</h4><div class="sm-rows"></div>
        ${state.foods.some((f) => f.id === food.id && f.kind === "smoothie") ? `<button class="btn ghost small" data-a="edit-recipe" type="button">Edit saved recipe</button>` : ""}</div>` : `<details class="adjust" ${powder ? "open" : ""}>
        <summary>✏️ Adjust calories & macros${powder ? " — match your tub's label" : ""}</summary>
        <p class="hint">Type the numbers from your package label ${base ? `for <b>${esc(base.label)}</b>` : "per <b>100 g</b>"}. Everything recalculates for the grams above.</p>
        ${base ? `<label>${powder ? "Scoop size (g)" : "Serving size (g)"}<input data-adj="g" inputmode="decimal" value="${r1(base.g)}"></label>` : ""}
        <div class="grid2">
          <label>Calories<input data-adj="kcal" inputmode="decimal" value="${perBase("kcal")}"></label>
          <label>Protein g<input data-adj="p" inputmode="decimal" value="${perBase("p")}"></label>
          <label>Carbs g<input data-adj="c" inputmode="decimal" value="${perBase("c")}"></label>
          <label>Fat g<input data-adj="f" inputmode="decimal" value="${perBase("f")}"></label>
        </div>
        <label class="check"><input type="checkbox" data-adj-save ${powder ? "checked" : ""}> Remember these values in My Foods</label>
      </details>`}
      ${pick ? "" : mealPicker(selMeal)}
      <button class="btn primary big" data-a="save">${pick ? "Add to smoothie" : entry ? "Save changes" : "Add to log"}</button>
      ${canSave && !alreadySaved && !entry ? `<button class="btn ghost" data-a="fav">☆ Save to My Foods</button>` : ""}
      ${entry ? `<button class="btn danger outline" data-a="delete">Delete entry</button>` : ""}
    </div>`);

  // Adjust panel: label values -> per-100 g values on our copy of the food.
  $$("[data-adj]", el).forEach((inp) =>
    inp.addEventListener("input", () => {
      const g = base ? num($("[data-adj=g]", el).value) : 100;
      if (!(g > 0)) return;
      const k = 100 / g;
      food.kcal = num($("[data-adj=kcal]", el).value) * k;
      food.p = num($("[data-adj=p]", el).value) * k;
      food.c = num($("[data-adj=c]", el).value) * k;
      food.f = num($("[data-adj=f]", el).value) * k;
      if (base) {
        base.g = g;
        const opt = $(".serv-unit option", el);
        if (opt) opt.textContent = `${base.label} (${r1(g)} g)`;
      }
      adjusted = true;
      $(".per-info", el).innerHTML = perInfo();
      update();
    })
  );
  // Save the adjusted values as the user's own food so they're reused next time.
  function rememberAdjusted() {
    if (!adjusted || !$("[data-adj-save]", el)?.checked) return;
    const round = (f) => ({ ...f, kcal: r1(f.kcal), p: r1(f.p), c: r1(f.c), f: r1(f.f) });
    food = food.source === "custom"
      ? round(food)
      : round({ ...food, id: "my" + S.uid(), source: "custom", name: food.name.replace(/\s*\(typical\)/i, "") });
    S.saveMyFood(food);
    toast(`Saved “${food.name}” to My Foods`);
  }

  // Smoothie: list every ingredient, scaled to the amount being logged.
  const renderSmoothieContents = () => {
    const box = $(".sm-rows", el);
    if (!box) return;
    const ings = food.ingredients || [];
    const whole = ings.reduce((g, i) => g + i.grams, 0);
    if (!ings.length || !(whole > 0)) {
      box.innerHTML = `<p class="empty small">Ingredient details weren't saved for this entry.</p>`;
      return;
    }
    const factor = grams / whole;
    box.innerHTML = ings.map((i) => {
      const g = i.grams * factor;
      const v = scale(i, g);
      return `<div class="sm-row"><div><span class="e-name">${esc(i.name)}</span>
        <span class="e-sub">${r1(g)} g</span><span class="e-macros">${macroLine(v)}</span></div>
        <span class="e-kcal">${fmt(v.kcal)}<small>kcal</small></span></div>`;
    }).join("");
  };

  const gInput = $(".grams", el);
  const update = () => {
    const v = scale(food, grams);
    $("[data-k]", el).textContent = fmt(v.kcal);
    $("[data-p]", el).textContent = r1(v.p);
    $("[data-c]", el).textContent = r1(v.c);
    $("[data-f]", el).textContent = r1(v.f);
    if (smoothie) renderSmoothieContents();
  };
  const setGrams = (g) => {
    grams = Math.max(0, g);
    gInput.value = r1(grams);
    update();
  };
  // Keep "N × serving" in step when grams are typed or a gram chip is tapped.
  const syncQty = () => {
    const unit = units[num($(".serv-unit", el)?.value)];
    if (unit?.g > 0) $(".serv-qty", el).value = r1(grams / unit.g);
  };
  gInput.addEventListener("input", () => {
    grams = num(gInput.value);
    syncQty();
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
    if (chip) {
      setGrams(num(chip.dataset.g));
      return syncQty();
    }
    const a = ev.target.closest("[data-a]")?.dataset.a;
    if (a === "apply-serv") applyServing();
    else if (a === "edit-recipe") {
      const saved = state.foods.find((f) => f.id === food.id && f.kind === "smoothie");
      if (saved) openSmoothie({ edit: saved, meal: selMeal });
    } else if (a === "fav") {
      S.saveMyFood({ ...food });
      ev.target.closest("[data-a]").remove();
      toast("Saved to My Foods");
    } else if (a === "save") {
      if (!(grams > 0)) return toast("Enter how many grams");
      rememberAdjusted();
      if (pick) {
        closeSheet(el);
        pick({ ...food }, r1(grams));
        return;
      }
      const v = scale(food, grams);
      const data = {
        meal: selMeal, name: food.name, brand: food.brand || "", grams: r1(grams),
        kcal: v.kcal, p: v.p, c: v.c, f: v.f,
        per: { kcal: food.kcal, p: food.p, c: food.c, f: food.f },
        units: food.units, source: food.source, foodId: food.id, kind: food.kind || "",
        ingredients: food.kind === "smoothie" ? food.ingredients : undefined,
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
    ...entry.per, units: entry.units || [], source: entry.source, kind: entry.kind || "",
    // Smoothies: ingredients saved with the entry (or, for older entries, from the saved recipe).
    ingredients: entry.ingredients || state.foods.find((f) => f.id === entry.foodId)?.ingredients,
  };
  openAmount(food, { entry });
}

// ---------- Smoothie builder ----------
// A smoothie is saved as a food with kind "smoothie": its per-100 g values come
// from the sum of its ingredients, and it keeps the ingredient list for editing.
function openSmoothie({ meal, edit, onDone } = {}) {
  let ingredients = (edit?.ingredients || []).map((i) => ({ ...i }));
  let selMeal = meal || defaultMeal();
  const el = openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancel</button><h2>${edit ? "Edit smoothie" : "Smoothie builder"}</h2><span></span></div>
    <div class="pad smoothie form">
      <label>Name<input class="sm-name" value="${esc(edit?.name || "")}" placeholder="e.g. Berry protein smoothie"></label>
      <h4>Ingredients</h4>
      <div class="sm-list"></div>
      <button class="btn ghost add-ing" data-a="add-ing">＋ Add ingredient</button>
      <p class="hint">Liquids are measured in grams ≈ ml (1 cup milk ≈ 244 g). For protein powder you can type your tub's calories and protein per scoop.</p>
      <div class="live sm-total"></div>
      <div class="sm-qty"><span>Drinking</span><input class="qty" inputmode="decimal" value="1"><span>× the whole smoothie</span></div>
      ${mealPicker(selMeal)}
      <label class="check"><input type="checkbox" class="sm-save" checked> Save this smoothie in My Foods for next time</label>
      <button class="btn primary big" data-a="log">Add smoothie to log</button>
      ${edit ? `<button class="btn ghost" data-a="save-only">Save changes without logging</button>
      <button class="btn danger outline" data-a="delete">Delete smoothie</button>` : ""}
    </div>`);
  const list = $(".sm-list", el);
  const totalBox = $(".sm-total", el);
  bindMealPicker(el, (m) => (selMeal = m));

  const toIngredient = (f, grams) => ({
    foodId: f.id, name: f.name, brand: f.brand || "", source: f.source, units: f.units || [],
    kcal: f.kcal, p: f.p, c: f.c, f: f.f, grams,
  });
  const totals = () => sum(ingredients.map((i) => scale(i, i.grams)));
  const totalGrams = () => ingredients.reduce((g, i) => g + i.grams, 0);

  function renderList() {
    list.innerHTML = ingredients.length
      ? ingredients.map((i, idx) => {
          const v = scale(i, i.grams);
          return `<div class="sm-ing" data-idx="${idx}">
            <button class="sm-ing-main" data-a="edit-ing" data-idx="${idx}">
              <span class="e-name">${esc(i.name)}</span>
              <span class="e-sub">${fmt(i.grams)} g · ${fmt(v.kcal)} kcal</span>
              <span class="e-macros">${macroLine(v)}</span>
            </button>
            <button class="sm-del" data-a="del-ing" data-idx="${idx}" aria-label="Remove ${esc(i.name)}">✕</button>
          </div>`;
        }).join("")
      : `<p class="empty small">No ingredients yet. Add fruit, milk, yogurt, protein powder…</p>`;
    const t = totals();
    totalBox.innerHTML = `
      <div class="live-kcal"><b>${fmt(t.kcal)}</b><span>kcal total · ${fmt(totalGrams())} g</span></div>
      <div class="live-macros"><span class="mp">Protein <b>${r1(t.p)}</b> g</span><span class="mc">Carbs <b>${r1(t.c)}</b> g</span><span class="mf">Fat <b>${r1(t.f)}</b> g</span></div>`;
  }

  function buildFood() {
    const g = totalGrams();
    if (!ingredients.length || !(g > 0)) {
      toast("Add at least one ingredient");
      return null;
    }
    const t = totals();
    return {
      id: edit?.id || "sm" + S.uid(),
      name: $(".sm-name", el).value.trim() || "Smoothie",
      brand: "",
      kind: "smoothie",
      source: "custom",
      kcal: r1((t.kcal / g) * 100), p: r1((t.p / g) * 100), c: r1((t.c / g) * 100), f: r1((t.f / g) * 100),
      units: [{ label: "whole smoothie", g: r1(g) }],
      ingredients: ingredients.map((i) => ({ ...i })),
    };
  }

  el.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-a]");
    if (!btn) return;
    const a = btn.dataset.a;
    const idx = num(btn.dataset.idx);
    if (a === "add-ing") {
      openAddFood(selMeal, {
        onPick: (f, grams) => {
          ingredients.push(toIngredient(f, grams));
          renderList();
        },
      });
    } else if (a === "edit-ing") {
      const i = ingredients[idx];
      const asFood = { id: i.foodId, name: i.name, brand: i.brand, source: i.source, units: i.units, kcal: i.kcal, p: i.p, c: i.c, f: i.f };
      openAmount(asFood, {
        initialGrams: i.grams,
        pick: (f, grams) => {
          ingredients[idx] = toIngredient(f, grams);
          renderList();
        },
      });
    } else if (a === "del-ing") {
      ingredients.splice(idx, 1);
      renderList();
    } else if (a === "log") {
      const food = buildFood();
      if (!food) return;
      const qty = num($(".qty", el).value);
      if (!(qty > 0)) return toast("Enter how much you're drinking");
      if ($(".sm-save", el).checked) S.saveMyFood(food);
      const grams = food.units[0].g * qty;
      const v = scale(food, grams);
      S.addEntry(curKey(), {
        meal: selMeal, name: food.name, brand: "", grams: r1(grams),
        kcal: v.kcal, p: v.p, c: v.c, f: v.f,
        per: { kcal: food.kcal, p: food.p, c: food.c, f: food.f },
        units: food.units, source: "custom", foodId: food.id, kind: "smoothie", ingredients: food.ingredients,
      });
      S.rememberRecent(food);
      toast(`Added ${fmt(v.kcal)} kcal smoothie to ${mealLabel(selMeal)}`);
      closeSheet(el);
      onDone?.();
      render();
    } else if (a === "save-only") {
      const food = buildFood();
      if (!food) return;
      S.saveMyFood(food);
      toast("Smoothie saved");
      closeSheet(el);
      render();
    } else if (a === "delete" && (await confirmDialog(`Delete “${edit.name}” from My Foods?`))) {
      S.deleteMyFood(edit.id);
      closeSheet(el);
      render();
    }
  });

  renderList();
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
      <button class="btn primary big" data-a="save">${entry ? "Save changes" : "Add to log"}</button>
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
function openBarcode({ meal, onDone, onFood, saveOnly } = {}) {
  let stop = null;
  const next = onFood || ((f) => openAmount(f, { meal, onDone }));
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
      } else next(food);
    } else {
      toast("Not in the database — enter it from the label");
      openCustomFood({
        prefill: { barcode: code },
        onSaved: (f) => (saveOnly ? render() : next(f)),
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
      ${S.getApiKey() ? "" : `<div class="notice">Add your Anthropic API key in <b>Settings</b> to use AI scanning. <button class="btn small" data-a="go-settings">Open Settings</button></div>`}
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
    if (!S.getApiKey()) return toast("Add your API key in Settings first");
    const btn = $("[data-a=analyze]", el);
    btn.disabled = true;
    out.innerHTML = `<div class="loading"><span class="spinner"></span>Analyzing your meal… this takes 10–40 seconds.</div>`;
    try {
      const res = await analyzeMeal({ apiKey: S.getApiKey(), model: state.settings.model, imageBase64: imageB64, description: desc });
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
            <span class="conf ${esc(it.confidence)}">${esc(it.confidence)} confidence</span></div>
          <div class="ai-g"><input class="ai-grams" inputmode="decimal" value="${r1(it.grams)}"><span>g</span></div>
          <b class="ai-kcal">${fmt(scale(it.per, it.grams).kcal)}</b>
        </div>`).join("")}</div>
      ${notes ? `<p class="hint">${esc(notes)}</p>` : ""}
      <div class="ai-total">Total: <b>${totalsText()}</b></div>
      ${mealPicker(selMeal)}
      <button class="btn primary big" data-a="add-all">Add to log</button>
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
// Refuse to run inside another site's frame (clickjacking protection).
if (window.top !== window.self) {
  document.body.textContent = "Open Calorie Tracker directly.";
  throw new Error("Calorie Tracker will not run inside a frame.");
}
// After a pull-to-refresh, come back to the same tab and day.
try {
  const resume = JSON.parse(sessionStorage.getItem("ct_resume") || "null");
  sessionStorage.removeItem("ct_resume");
  if (resume) {
    if (["diary", "history", "foods", "settings"].includes(resume.view)) view = resume.view;
    if (/^\d{4}-\d{2}-\d{2}$/.test(resume.day || "") && resume.day <= S.dayKey(new Date())) current = parseKey(resume.day);
  }
} catch {}

// Wait for the diary to load from IndexedDB before showing anything.
S.ready.finally(() => {
  S.ensureFirstUse();
  booted = true;
  render();
});
// Ask the browser to keep this app's data even when the phone is low on space.
navigator.storage?.persist?.().catch(() => {});
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
// ---------- new day at local midnight ----------
// The day strip gains a day at 12:00 am. If you were looking at "today", the app moves
// on to the new today (unless a panel is open, so an entry in progress isn't moved).
let knownToday = S.dayKey(new Date());
function checkNewDay() {
  const k = S.dayKey(new Date());
  if (k === knownToday) return false;
  const wasOnToday = curKey() === knownToday;
  knownToday = k;
  if (wasOnToday && !stack.length) current = new Date();
  render();
  return true;
}
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  setTimeout(() => {
    checkNewDay();
    scheduleMidnight();
  }, next - now);
}
scheduleMidnight();
// iOS pauses timers while the app is in the background, so also check when it comes back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !checkNewDay() && (view === "diary" || view === "history")) render();
});

// ---------- feel like an app, not a web page ----------
// Block pinch-zoom (iOS gesture events); double-tap zoom is disabled in CSS (touch-action).
["gesturestart", "gesturechange", "gestureend"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));

// ---------- pull to refresh ----------
// Pull down at the top of a screen to reload the latest version of the app.
(function pullToRefresh() {
  const THRESHOLD = 70;
  const MAX = 110;
  const ind = document.createElement("div");
  ind.id = "ptr";
  ind.setAttribute("aria-hidden", "true");
  ind.innerHTML = `<div class="ptr-ball">${icon("refresh")}</div>`;
  document.body.appendChild(ind);
  const ball = ind.firstChild;
  let startY = null;
  let startX = 0;
  let pull = 0;
  let pulling = false;
  let refreshing = false;
  const show = (d, animate) => {
    const t = animate ? "transform 0.25s ease, opacity 0.25s ease" : "none";
    ind.style.transition = t;
    ind.style.transform = `translate(-50%, ${d - 56}px)`;
    ind.style.opacity = String(Math.min(1, d / 36));
    ball.style.transform = `rotate(${d * 3.2}deg)`;
    ind.classList.toggle("ready", d >= THRESHOLD);
    const v = $("#view");
    v.style.transition = t;
    v.style.transform = d > 0 ? `translateY(${d * 0.35}px)` : "";
  };
  document.addEventListener(
    "touchstart",
    (e) => {
      startY = null;
      if (refreshing || stack.length || e.touches.length !== 1 || window.scrollY > 0) return;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      pulling = false;
      pull = 0;
    },
    { passive: true }
  );
  document.addEventListener(
    "touchmove",
    (e) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (!pulling) {
        // Sideways swipes (day strip) and upward scrolls aren't pulls.
        if (Math.abs(dx) > Math.abs(dy) || dy < 0) {
          if (Math.abs(dx) > 10 || dy < -10) startY = null;
          return;
        }
        if (dy < 10) return;
        if (window.scrollY > 0) return void (startY = null);
        pulling = true;
      }
      e.preventDefault();
      pull = Math.min(MAX, (dy - 10) * 0.5);
      show(pull);
    },
    { passive: false }
  );
  const end = () => {
    if (startY == null) return;
    startY = null;
    if (!pulling) return;
    pulling = false;
    if (pull >= THRESHOLD) {
      refreshing = true;
      ind.classList.add("spin");
      show(THRESHOLD * 0.8, true);
      try {
        sessionStorage.setItem("ct_resume", JSON.stringify({ view, day: curKey() }));
      } catch {}
      setTimeout(() => location.reload(), 450);
    } else show(0, true);
  };
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", end);
})();
// Redraw charts at the new width when the phone rotates.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => view === "history" && render(), 150);
});
