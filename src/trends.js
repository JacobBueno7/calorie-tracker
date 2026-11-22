// History / trends view: averages over time, streaks, weight trend, patterns.
import * as S from "./store.js";
import { MEALS, $, $$, esc, fmt, r1, sum, parseKey, startOfDay, addDays, daysBetween } from "./util.js";

const { state } = S;

export const RANGES = [
  { id: 7, label: "7D", long: "7 days" },
  { id: 30, label: "30D", long: "30 days" },
  { id: 90, label: "90D", long: "90 days" },
  { id: 365, label: "1Y", long: "year" },
  { id: "all", label: "All", long: "all time" },
];
const KCAL_PER_KG = 7700; // energy in 1 kg of body weight change (≈3,500 kcal per lb)
const MINUS = "−";

const avgOf = (arr, f) => (arr.length ? arr.reduce((a, x) => a + f(x), 0) / arr.length : 0);
const signed = (n, digits = 0) => {
  const v = digits ? r1(n) : Math.round(n);
  return v > 0 ? `+${v.toLocaleString()}` : v < 0 ? `${MINUS}${Math.abs(v).toLocaleString()}` : "0";
};
const mealOf = (e) => (MEALS.some((m) => m.id === e.meal) ? e.meal : "snacks");
const shortDate = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
const longDate = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const unit = () => (state.settings.weightUnit === "kg" ? "kg" : "lb");
export const kgToUnit = (kg) => (unit() === "kg" ? kg : kg / S.KG_PER_LB);
export const unitToKg = (v) => (unit() === "kg" ? v : v * S.KG_PER_LB);
const wFmt = (kg) => r1(kgToUnit(kg)).toFixed(1);

function dayInfo(k) {
  const list = S.entriesFor(k);
  return { k, d: parseKey(k), t: sum(list), list, logged: list.length > 0 };
}

function windowFor(range, today) {
  if (range === "all") {
    const keys = [...Object.keys(state.entries), ...Object.keys(state.weights)].sort();
    let start = keys.length ? parseKey(keys[0]) : addDays(today, -6);
    if (daysBetween(start, today) < 6) start = addDays(today, -6);
    return { start, len: daysBetween(start, today) + 1 };
  }
  return { start: addDays(today, -(range - 1)), len: range };
}

function streaks(today) {
  const has = (d) => (state.entries[S.dayKey(d)] || []).length > 0;
  let cur = 0;
  let d = has(today) ? today : addDays(today, -1);
  while (has(d)) {
    cur++;
    d = addDays(d, -1);
  }
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of Object.keys(state.entries).filter((k) => state.entries[k]?.length).sort()) {
    const dd = parseKey(k);
    run = prev && daysBetween(prev, dd) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = dd;
  }
  return { cur, best };
}

/** Least-squares slope (y per x). */
function slope(points) {
  const n = points.length;
  if (n < 2) return 0;
  const mx = avgOf(points, (p) => p.x);
  const my = avgOf(points, (p) => p.y);
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den ? num / den : 0;
}

export function computeTrends(range, now = new Date()) {
  const today = startOfDay(now);
  const todayKey = S.dayKey(today);
  const goal = state.settings.goal;
  const pGoal = state.settings.protein;
  const { start, len } = windowFor(range, today);

  const days = [];
  for (let i = 0; i < len; i++) days.push(dayInfo(S.dayKey(addDays(start, i))));
  // Averages use completed days only: today is still in progress.
  const done = days.filter((x) => x.logged && x.k !== todayKey);
  const n = done.length;
  const avg = { kcal: avgOf(done, (x) => x.t.kcal), p: avgOf(done, (x) => x.t.p), c: avgOf(done, (x) => x.t.c), f: avgOf(done, (x) => x.t.f) };

  let prev = null;
  if (range !== "all") {
    const pd = [];
    for (let i = 1; i <= len; i++) {
      const x = dayInfo(S.dayKey(addDays(start, -i)));
      if (x.logged) pd.push(x);
    }
    if (pd.length) prev = { n: pd.length, kcal: avgOf(pd, (x) => x.t.kcal) };
  }

  const sorted = [...done].sort((a, b) => b.t.kcal - a.t.kcal);

  // ----- buckets for the calories chart -----
  const mode = len <= 35 ? "day" : len <= 200 ? "week" : "month";
  const buckets = [];
  if (mode === "day") {
    for (const x of days) {
      const partial = x.k === todayKey;
      buckets.push({ start: x.d, keys: [x.k], n: x.logged ? 1 : 0, partial: partial && x.logged, ...x.t, kcal: x.logged ? x.t.kcal : 0 });
    }
  } else {
    const keyOf = (d) => (mode === "week" ? S.dayKey(addDays(d, -((d.getDay() + 6) % 7))) : `${d.getFullYear()}-${d.getMonth()}`);
    const map = new Map();
    for (const x of days) {
      const id = keyOf(x.d);
      if (!map.has(id)) {
        const s = mode === "week" ? parseKey(id) : new Date(x.d.getFullYear(), x.d.getMonth(), 1);
        map.set(id, { start: s, keys: [], done: [] });
      }
      const b = map.get(id);
      b.keys.push(x.k);
      if (x.logged && x.k !== todayKey) b.done.push(x);
    }
    for (const b of map.values()) {
      buckets.push({
        start: b.start, keys: b.keys, n: b.done.length,
        kcal: avgOf(b.done, (x) => x.t.kcal), p: avgOf(b.done, (x) => x.t.p), c: avgOf(b.done, (x) => x.t.c), f: avgOf(b.done, (x) => x.t.f),
      });
    }
  }

  // 7-day rolling average of completed, logged days (daily chart only)
  let rolling = null;
  if (mode === "day" && len >= 14) {
    rolling = days.map((x) => {
      if (x.k === todayKey) return null;
      const win = [];
      for (let i = 0; i < 7; i++) {
        const y = dayInfo(S.dayKey(addDays(x.d, -i)));
        if (y.logged) win.push(y.t.kcal);
      }
      return win.length >= 3 ? win.reduce((a, v) => a + v, 0) / win.length : null;
    });
  }

  // ----- patterns -----
  const meals = MEALS.map((m) => ({ ...m, kcal: n ? done.reduce((a, x) => a + sum(x.list.filter((e) => mealOf(e) === m.id)).kcal, 0) / n : 0 }));

  let weekdays = null;
  if (len >= 14) {
    weekdays = [1, 2, 3, 4, 5, 6, 0].map((wd) => {
      const set = done.filter((x) => x.d.getDay() === wd);
      return { wd, label: new Date(2024, 0, 7 + wd).toLocaleDateString(undefined, { weekday: "short" }), n: set.length, kcal: avgOf(set, (x) => x.t.kcal) };
    });
  }

  const foodMap = new Map();
  let windowKcal = 0;
  for (const x of days)
    for (const e of x.list) {
      const key = String(e.name || "Food").toLowerCase().trim();
      const f = foodMap.get(key) || { name: e.name || "Food", kind: e.kind, kcal: 0, count: 0 };
      f.kcal += e.kcal || 0;
      f.count++;
      foodMap.set(key, f);
      windowKcal += e.kcal || 0;
    }
  const topFoods = [...foodMap.values()].sort((a, b) => b.kcal - a.kcal).slice(0, 8);

  // ----- weight -----
  const wAll = Object.entries(state.weights)
    .map(([k, kg]) => ({ k, d: parseKey(k), kg }))
    .sort((a, b) => a.d - b.d);
  const trendAt = (d) => avgOf(wAll.filter((w) => w.d <= d && daysBetween(w.d, d) < 7), (w) => w.kg);
  const wIn = wAll.filter((w) => w.d >= start && w.d <= today).map((w) => ({ ...w, trend: trendAt(w.d) }));
  let weight = { all: wAll, points: wIn, latest: wAll.at(-1) || null };
  if (wIn.length >= 2) {
    const kgPerDay = slope(wIn.map((w) => ({ x: daysBetween(start, w.d), y: w.kg })));
    const first = wIn[0];
    const last = wIn.at(-1);
    const span = daysBetween(first.d, last.d);
    weight = { ...weight, kgPerDay, change: last.trend - first.trend, span };
    if (span >= 14 && wIn.length >= 3) {
      const inSpan = done.filter((x) => x.d >= first.d && x.d <= last.d);
      if (inSpan.length >= 10) {
        const intake = avgOf(inSpan, (x) => x.t.kcal);
        weight.tdee = intake - kgPerDay * KCAL_PER_KG;
        weight.coverage = inSpan.length / (span + 1);
      }
    }
  }

  return {
    range, today, todayKey, start, len, goal, pGoal, days, done, n, avg, prev,
    under: done.filter((x) => x.t.kcal <= goal).length,
    proteinHit: done.filter((x) => x.t.p >= pGoal).length,
    hi: sorted[0] || null, lo: sorted.at(-1) || null,
    streak: streaks(today), mode, buckets, rolling, meals, weekdays, topFoods, windowKcal, weight,
    anyData: Object.keys(state.entries).length > 0 || wAll.length > 0,
  };
}

// ---------------- rendering ----------------
let M = null; // model for the current render (used by the charts)

export function renderTrends() {
  const range = RANGES.some((r) => String(r.id) === String(state.settings.histRange)) ? state.settings.histRange : 30;
  M = computeTrends(range);
  const R = RANGES.find((r) => String(r.id) === String(range));
  return `
  <header class="topbar"><div><p class="eyebrow">Your progress</p><h1>History</h1></div></header>
  <div class="seg range">${RANGES.map((r) => `<button type="button" data-range="${r.id}" class="${String(r.id) === String(range) ? "on" : ""}">${r.label}</button>`).join("")}</div>
  ${!M.anyData
    ? `<section class="card empty-card"><div class="empty-icon">📈</div><h3>No history yet</h3><p class="muted">Log a few days of meals and your averages, streaks and trends will show up here.</p></section>`
    : [heroCard(R), tiles(), calCard(), weightCard(), macroCard(), mealCard(), weekdayCard(), foodsCard(), tableCard()].join("")}`;
}

function heroCard(R) {
  const { avg, n, prev, goal } = M;
  const diff = avg.kcal - goal;
  return `<section class="card hero">
    <p class="eyebrow">Average per day · ${R.id === "all" ? "all time" : `last ${R.long}`}</p>
    ${n ? `<div class="hero-num">${fmt(avg.kcal)}<span>kcal</span></div>
    <div class="hero-sub">
      <span class="pill">${Math.abs(diff) < 1 ? "Right on your goal" : `${fmt(Math.abs(diff))} ${diff > 0 ? "over" : "under"} your ${fmt(goal)} goal`}</span>
      ${prev && R.id !== "all" ? `<span class="pill ghost">${prev.kcal > avg.kcal ? "▼" : prev.kcal < avg.kcal ? "▲" : "="} ${fmt(Math.abs(avg.kcal - prev.kcal))} vs previous ${R.long}</span>` : ""}
    </div>
    <p class="hint">From ${n} logged day${n === 1 ? "" : "s"}. Today is counted once it's over.</p>`
    : `<div class="hero-num muted">—</div><p class="hint">No completed days logged in this range yet.</p>`}
  </section>`;
}

function tile(label, value, sub, attrs = "") {
  return `<${attrs ? "button" : "div"} class="tile" ${attrs}><span class="tile-label">${label}</span><b>${value}</b><span class="tile-sub">${sub}</span></${attrs ? "button" : "div"}>`;
}
function tiles() {
  const { n, todayKey, days, under, proteinHit, avg, pGoal, streak, hi, lo } = M;
  const possible = days.filter((x) => x.k !== todayKey).length || 1;
  return `<section class="tiles">
    ${tile("Days logged", `${n}<small>/${possible}</small>`, `${Math.round((n / possible) * 100)}% of days`)}
    ${tile("At or under goal", `${under}<small>/${n}</small>`, n ? `${Math.round((under / n) * 100)}% of logged days` : "—")}
    ${tile("Streak", `${streak.cur}<small> day${streak.cur === 1 ? "" : "s"}</small>`, `Best ever: ${streak.best}`)}
    ${tile("Avg protein", `${fmt(avg.p)}<small> g</small>`, n ? `Goal hit ${proteinHit} of ${n} days` : `Goal ${fmt(pGoal)} g`)}
    ${hi ? tile("Highest day", fmt(hi.t.kcal), esc(longDate(hi.d)), `data-act="goto-day" data-key="${hi.k}"`) : ""}
    ${lo && n > 1 ? tile("Lowest day", fmt(lo.t.kcal), esc(longDate(lo.d)), `data-act="goto-day" data-key="${lo.k}"`) : ""}
  </section>`;
}

function calCard() {
  const sub = { day: "per day", week: "weekly average per day", month: "monthly average per day" }[M.mode];
  return `<section class="card">
    <div class="card-head"><h3>Calories</h3><span class="muted">${sub}</span></div>
    <div class="readout" data-readout="cal"></div>
    <div class="chart-box" data-chart="cal" tabindex="0" aria-label="Calories chart. Use left and right arrows to read values."></div>
    <div class="legend">
      <span><i class="key bar-key"></i>At or under goal</span><span><i class="key bar-key over"></i>Over goal</span>
      <span><i class="key goal-key"></i>Goal</span>${M.rolling ? `<span><i class="key line-key"></i>7-day average</span>` : ""}
    </div>
  </section>`;
}

function weightCard() {
  const w = M.weight;
  const u = unit();
  const head = `<div class="card-head"><h3>Weight</h3><button class="btn ghost small" data-act="log-weight">＋ Log weight</button></div>`;
  if (w.points.length < 2)
    return `<section class="card">${head}
      ${w.latest ? `<p class="big-line"><b>${wFmt(w.latest.kg)} ${u}</b> <span class="muted">on ${esc(longDate(w.latest.d))}</span></p>` : ""}
      <p class="hint">Weigh in a few times a week (same time of day) to see your trend. After 2 weeks of weigh-ins and logged meals, the app estimates your maintenance calories.</p>
    </section>`;
  const last = w.points.at(-1);
  const perWeek = kgToUnit(w.kgPerDay * 7);
  let tdee = "";
  if (w.tdee) {
    const t = Math.round(w.tdee / 10) * 10;
    const goalRate = kgToUnit(((M.goal - t) * 7) / KCAL_PER_KG);
    tdee = `<div class="tdee">
      <div><span class="tile-label">Estimated maintenance</span><b>${fmt(t)} <small>kcal/day</small></b></div>
      <p class="hint">From your logged intake and weight trend over ${w.span} days. At your ${fmt(M.goal)} kcal goal you'd ${Math.abs(goalRate) < 0.05 ? "hold steady" : `${goalRate < 0 ? "lose" : "gain"} about ${Math.abs(goalRate).toFixed(1)} ${u}/week`}.${w.coverage < 0.8 ? " Some days aren't logged, so treat this as rough." : ""} Only as accurate as your logging.</p>
    </div>`;
  }
  return `<section class="card">${head}
    <div class="mini-stats">
      <div><span class="tile-label">Trend</span><b>${wFmt(last.trend)} <small>${u}</small></b></div>
      <div><span class="tile-label">Change</span><b>${signed(kgToUnit(w.change), 1)} <small>${u}</small></b></div>
      <div><span class="tile-label">Rate</span><b>${signed(perWeek, 1)} <small>${u}/wk</small></b></div>
    </div>
    <div class="readout" data-readout="weight"></div>
    <div class="chart-box" data-chart="weight" tabindex="0" aria-label="Weight chart. Use left and right arrows to read values."></div>
    <div class="legend"><span><i class="key dot-key"></i>Weigh-in</span><span><i class="key line-key accent"></i>7-day trend</span></div>
    ${tdee}
  </section>`;
}

function macroCard() {
  const { avg, n } = M;
  if (!n) return "";
  const parts = [
    { id: "p", label: "Protein", g: avg.p, kcal: avg.p * 4, goal: state.settings.protein },
    { id: "c", label: "Carbs", g: avg.c, kcal: avg.c * 4, goal: state.settings.carbs },
    { id: "f", label: "Fat", g: avg.f, kcal: avg.f * 9, goal: state.settings.fat },
  ];
  const tot = parts.reduce((a, p) => a + p.kcal, 0) || 1;
  parts.forEach((p) => (p.pct = (p.kcal / tot) * 100));
  return `<section class="card">
    <div class="card-head"><h3>Macro split</h3><span class="muted">share of calories</span></div>
    <div class="seg-bar" role="img" aria-label="${parts.map((p) => `${p.label} ${Math.round(p.pct)}%`).join(", ")}">
      ${parts.filter((p) => p.pct > 0).map((p) => `<div class="part ${p.id}" style="flex:${p.pct.toFixed(2)}">${p.pct >= 12 ? `${Math.round(p.pct)}%` : ""}</div>`).join("")}
    </div>
    <div class="macro-rows">${parts.map((p) => `<div class="macro-row"><span><i class="key bar-key ${p.id}"></i>${p.label}</span>
      <span class="muted">${Math.round(p.pct)}%</span><b>${fmt(p.g)} g<small> / ${fmt(p.goal)} g goal</small></b></div>`).join("")}</div>
  </section>`;
}

function hbars(rows, { goal, total } = {}) {
  const max = Math.max(goal || 0, ...rows.map((r) => r.kcal), 1) * 1.08;
  return `<div class="hbars">${rows.map((r) => `<div class="hbar">
    <span class="hb-label">${r.label}</span>
    <div class="hb-track">${r.kcal > 0 ? `<div class="hb-fill ${goal && r.kcal > goal ? "over" : ""}" style="width:${((r.kcal / max) * 100).toFixed(1)}%"></div>` : ""}
      ${goal ? `<div class="hb-goal" style="left:${((goal / max) * 100).toFixed(1)}%"></div>` : ""}</div>
    <span class="hb-val">${r.kcal > 0 ? fmt(r.kcal) : "—"}${total ? `<small>${Math.round((r.kcal / total) * 100)}%</small>` : r.sub ? `<small>${r.sub}</small>` : ""}</span>
  </div>`).join("")}</div>`;
}

function mealCard() {
  if (!M.n) return "";
  const total = M.meals.reduce((a, m) => a + m.kcal, 0) || 1;
  return `<section class="card">
    <div class="card-head"><h3>By meal</h3><span class="muted">average kcal per day</span></div>
    ${hbars(M.meals.map((m) => ({ label: `${m.icon} ${m.label}`, kcal: m.kcal })), { total })}
  </section>`;
}

function weekdayCard() {
  if (!M.weekdays || M.n < 5) return "";
  return `<section class="card">
    <div class="card-head"><h3>By weekday</h3><span class="muted">average kcal</span></div>
    ${hbars(M.weekdays.map((w) => ({ label: w.label, kcal: w.kcal, sub: w.n ? `${w.n}×` : "" })), { goal: M.goal })}
    <p class="hint">The line in each row is your ${fmt(M.goal)} kcal goal. Red means that weekday averages over it.</p>
  </section>`;
}

function foodsCard() {
  if (!M.topFoods.length) return "";
  const total = M.windowKcal || 1;
  return `<section class="card">
    <div class="card-head"><h3>Top calorie sources</h3><span class="muted">this range</span></div>
    <div class="top-foods">${M.topFoods.map((f) => `<div class="tf">
      <div class="tf-main"><span class="e-name">${f.kind === "smoothie" ? "🥤 " : ""}${esc(f.name)}</span>
        <span class="e-sub">${f.count}× logged · ${Math.round((f.kcal / total) * 100)}% of calories</span>
        <div class="tf-bar"><div style="width:${((f.kcal / M.topFoods[0].kcal) * 100).toFixed(1)}%"></div></div></div>
      <span class="e-kcal">${fmt(f.kcal)}<small>kcal</small></span></div>`).join("")}</div>
  </section>`;
}

function tableCard() {
  const u = unit();
  if (M.mode === "day") {
    return `<section class="card list">
      <div class="card-head pad-x"><h3>Day by day</h3></div>
      ${M.days.slice().reverse().map((x) => {
        const w = state.weights[x.k];
        return `<button class="hist-row" data-act="goto-day" data-key="${x.k}">
          <span class="hr-date">${esc(longDate(x.d))}${x.k === M.todayKey ? ` <small class="pill tiny">Today</small>` : ""}</span>
          <span class="hr-macros">${x.logged ? `P ${fmt(x.t.p)} · C ${fmt(x.t.c)} · F ${fmt(x.t.f)}` : ""}${w ? `${x.logged ? " · " : ""}⚖️ ${wFmt(w)} ${u}` : ""}</span>
          <b class="${x.logged && x.t.kcal > M.goal ? "over-text" : ""}">${x.logged ? fmt(x.t.kcal) : "—"}</b></button>`;
      }).join("")}
    </section>`;
  }
  const label = (b) => (M.mode === "week" ? `Week of ${shortDate(b.start)}` : b.start.toLocaleDateString(undefined, { month: "long", year: "numeric" }));
  return `<section class="card list">
    <div class="card-head pad-x"><h3>${M.mode === "week" ? "Week by week" : "Month by month"}</h3><span class="muted">avg per logged day</span></div>
    ${M.buckets.slice().reverse().map((b) => `<div class="hist-row">
      <span class="hr-date">${esc(label(b))}<small class="muted"> · ${b.n} day${b.n === 1 ? "" : "s"}</small></span>
      <span class="hr-macros">${b.n ? `P ${fmt(b.p)} · C ${fmt(b.c)} · F ${fmt(b.f)}` : ""}</span>
      <b class="${b.n && b.kcal > M.goal ? "over-text" : ""}">${b.n ? fmt(b.kcal) : "—"}</b></div>`).join("")}
  </section>`;
}

// ---------------- charts (SVG, sized to the real width) ----------------
function niceScale(min, max, maxTicks, steps) {
  for (const s of steps) {
    const lo = Math.floor(min / s) * s;
    const hi = Math.ceil(max / s) * s;
    if ((hi - lo) / s <= maxTicks) return { lo, hi, step: s };
  }
  const s = steps.at(-1);
  return { lo: Math.floor(min / s) * s, hi: Math.ceil(max / s) * s, step: s };
}
const tickLabel = (v) => (v >= 10000 ? `${r1(v / 1000)}K` : v.toLocaleString());
// Column with a 4px rounded top and a square base.
function colPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function drawCal(box, readout) {
  const W = Math.max(240, box.clientWidth);
  const H = 196;
  const padL = 38, padR = 4, padT = 14, padB = 24;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const B = M.buckets;
  const nB = B.length;
  const peak = Math.max(M.goal * 1.12, ...B.map((b) => b.kcal || 0), ...(M.rolling || []).filter(Boolean));
  const { hi: top, step } = niceScale(0, peak, 4, [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000]);
  const y = (v) => padT + ph - (v / top) * ph;
  const slot = pw / nB;
  const bw = slot >= 8 ? Math.min(24, Math.max(3, slot * 0.64), slot - 2) : Math.max(1, slot - 1);
  const parts = [];
  for (let v = 0; v <= top + 1e-6; v += step) {
    parts.push(`<line class="grid${v === 0 ? " base" : ""}" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`);
    parts.push(`<text class="tick" x="${padL - 6}" y="${y(v) + 3.5}" text-anchor="end">${tickLabel(v)}</text>`);
  }
  B.forEach((b, i) => {
    if (!(b.kcal > 0)) return;
    const h = Math.max(1.5, (b.kcal / top) * ph);
    const x = padL + i * slot + (slot - bw) / 2;
    parts.push(`<path class="col${b.kcal > M.goal ? " over" : ""}${b.partial ? " partial" : ""}" data-i="${i}" d="${colPath(x, padT + ph - h, bw, h)}"/>`);
  });
  const gy = y(M.goal);
  parts.push(`<line class="goal" x1="${padL}" x2="${W - padR}" y1="${gy}" y2="${gy}"/>`);
  parts.push(`<text class="goal-label" x="${W - padR}" y="${gy - 5}" text-anchor="end">Goal ${fmt(M.goal)}</text>`);
  if (M.rolling) {
    let d = "";
    let pen = false;
    M.rolling.forEach((v, i) => {
      if (v == null) return void (pen = false);
      d += `${pen ? "L" : "M"}${(padL + i * slot + slot / 2).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    if (d) parts.push(`<path class="avg-halo" d="${d}"/><path class="avg-line" d="${d}"/>`);
  }
  // x labels: count back from the newest bucket so the latest always has one
  const want = M.mode === "day" && nB <= 7 ? nB : 5;
  const every = Math.max(1, Math.ceil(nB / want));
  for (let i = nB - 1; i >= 0; i -= every) {
    const b = B[i];
    const cx = padL + i * slot + slot / 2;
    const txt =
      M.mode === "day" && nB <= 7 ? b.start.toLocaleDateString(undefined, { weekday: "short" })
      : M.mode === "month" ? b.start.toLocaleDateString(undefined, b.start.getMonth() === 0 ? { month: "short", year: "2-digit" } : { month: "short" })
      : shortDate(b.start);
    const anchor = cx < padL + 22 ? "start" : cx > W - 22 ? "end" : "middle";
    parts.push(`<text class="xlab" x="${anchor === "start" ? cx - slot / 2 : anchor === "end" ? W - padR : cx}" y="${H - 6}" text-anchor="${anchor}">${esc(txt)}</text>`);
  }
  box.innerHTML = `<svg class="cal-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;

  const describe = (i) => {
    const b = B[i];
    if (M.mode === "day") {
      const k = b.keys[0];
      const roll = M.rolling?.[i];
      if (!b.n) return roRow(`<span class="ro-date">${esc(longDate(b.start))}</span>`, "Nothing logged");
      return roRow(
        `<span class="ro-val"><b>${fmt(b.kcal)}</b> kcal${b.partial ? " so far" : ""}</span> <span class="ro-date">${esc(longDate(b.start))}</span>`,
        `<span class="mp">P ${fmt(b.p)}</span> <span class="mc">C ${fmt(b.c)}</span> <span class="mf">F ${fmt(b.f)}</span>${roll ? ` · 7-day avg ${fmt(roll)}` : ""}`,
        `<button class="btn ghost small" data-act="goto-day" data-key="${k}">Open ›</button>`
      );
    }
    const label = M.mode === "week" ? `Week of ${shortDate(b.start)}` : b.start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    if (!b.n) return roRow(`<span class="ro-date">${esc(label)}</span>`, "Nothing logged");
    return roRow(
      `<span class="ro-val"><b>${fmt(b.kcal)}</b> kcal/day</span> <span class="ro-date">${esc(label)}</span>`,
      `<span class="mp">P ${fmt(b.p)}</span> <span class="mc">C ${fmt(b.c)}</span> <span class="mf">F ${fmt(b.f)}</span> · ${b.n} day${b.n === 1 ? "" : "s"} logged`
    );
  };
  const idle = roRow(`<span class="muted">Tap or drag across the chart to see each ${M.mode}.</span>`, "");
  readout.innerHTML = idle;
  bindScrub(box, nB, (x) => Math.floor((x - padL) / slot), (i) => {
    const svg = $("svg", box);
    svg.classList.toggle("has-sel", i != null);
    $$(".col", svg).forEach((c) => c.classList.toggle("sel", Number(c.dataset.i) === i));
    readout.innerHTML = i == null ? idle : describe(i);
  });
}

function drawWeight(box, readout) {
  const pts = M.weight.points;
  const W = Math.max(240, box.clientWidth);
  const H = 170;
  const padL = 38, padR = 8, padT = 12, padB = 24;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const vals = pts.flatMap((p) => [kgToUnit(p.kg), kgToUnit(p.trend)]);
  const { lo, hi, step } = niceScale(Math.min(...vals) - 0.3, Math.max(...vals) + 0.3, 4, [0.5, 1, 2, 5, 10, 20, 50]);
  const y = (v) => padT + ph - ((v - lo) / (hi - lo || 1)) * ph;
  const span = Math.max(1, M.len - 1);
  const x = (d) => padL + (daysBetween(M.start, d) / span) * pw;
  const parts = [];
  for (let v = lo; v <= hi + 1e-6; v += step) {
    parts.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`);
    parts.push(`<text class="tick" x="${padL - 6}" y="${y(v) + 3.5}" text-anchor="end">${r1(v)}</text>`);
  }
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)},${y(kgToUnit(p.trend)).toFixed(1)}`).join("");
  parts.push(`<path class="w-line" d="${line}"/>`);
  pts.forEach((p, i) => parts.push(`<circle class="w-dot" data-i="${i}" cx="${x(p.d).toFixed(1)}" cy="${y(kgToUnit(p.kg)).toFixed(1)}" r="4"/>`));
  const ticks = [M.start, addDays(M.start, Math.round(span / 2)), M.today];
  ticks.forEach((d, i) => parts.push(`<text class="xlab" x="${i === 0 ? padL : i === 2 ? W - padR : x(d)}" y="${H - 6}" text-anchor="${["start", "middle", "end"][i]}">${esc(shortDate(d))}</text>`));
  box.innerHTML = `<svg class="w-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`;

  const u = unit();
  const idle = roRow(`<span class="muted">Tap a weigh-in for details.</span>`, "");
  readout.innerHTML = idle;
  // nearest weigh-in to the pointer, by x
  const nearest = (px) => {
    let best = 0;
    pts.forEach((p, i) => {
      if (Math.abs(x(p.d) - px) < Math.abs(x(pts[best].d) - px)) best = i;
    });
    return best;
  };
  bindScrub(box, pts.length, nearest, (i) => {
    const svg = $("svg", box);
    svg.classList.toggle("has-sel", i != null);
    $$(".w-dot", svg).forEach((c) => c.classList.toggle("sel", Number(c.dataset.i) === i));
    if (i == null) return void (readout.innerHTML = idle);
    const p = pts[i];
    readout.innerHTML = roRow(
      `<span class="ro-val"><b>${wFmt(p.kg)}</b> ${u}</span> <span class="ro-date">${esc(longDate(p.d))}</span>`,
      `7-day trend ${wFmt(p.trend)} ${u}`,
      `<button class="btn ghost small" data-act="log-weight" data-key="${p.k}">Edit</button>`
    );
  });
}

// Fixed-height readout above a chart: headline, detail line, optional action button.
function roRow(head, detail, action = "") {
  return `<div class="ro-main"><div class="ro-head">${head}</div><div class="ro-macros">${detail || "&nbsp;"}</div></div>${action}`;
}

/** Tap / drag / hover / arrow-key selection shared by both charts. */
function bindScrub(box, count, indexAt, onSelect) {
  let sel = null;
  const set = (i) => {
    sel = i == null ? null : Math.max(0, Math.min(count - 1, i));
    onSelect(sel);
  };
  const at = (e) => set(indexAt(e.clientX - box.getBoundingClientRect().left));
  box.addEventListener("pointerdown", at);
  box.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" || e.buttons) at(e);
  });
  box.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && set(null));
  box.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      set(sel == null ? count - 1 : sel + (e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "Escape") set(null);
  });
}

export function bindTrends(root, onRange) {
  $$("[data-range]", root).forEach((b) =>
    b.addEventListener("click", () => onRange(b.dataset.range === "all" ? "all" : Number(b.dataset.range)))
  );
  if (!M) return;
  const cal = $("[data-chart=cal]", root);
  if (cal) drawCal(cal, $("[data-readout=cal]", root));
  const w = $("[data-chart=weight]", root);
  if (w) drawWeight(w, $("[data-readout=weight]", root));
}
