// Small helpers shared by the views.

export const MEALS = [
  { id: "breakfast", label: "Breakfast", icon: "🍳" },
  { id: "lunch", label: "Lunch", icon: "🥪" },
  { id: "dinner", label: "Dinner", icon: "🍽️" },
  { id: "snacks", label: "Snacks", icon: "🍎" },
];
export const mealLabel = (id) => MEALS.find((m) => m.id === id)?.label || "Snacks";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const fmt = (n) => Math.round(Number(n) || 0).toLocaleString();
export const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
export const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
export const scale = (per, grams) => ({
  kcal: (per.kcal * grams) / 100,
  p: (per.p * grams) / 100,
  c: (per.c * grams) / 100,
  f: (per.f * grams) / 100,
});
export const sum = (list) =>
  list.reduce((t, e) => ({ kcal: t.kcal + (e.kcal || 0), p: t.p + (e.p || 0), c: t.c + (e.c || 0), f: t.f + (e.f || 0) }), {
    kcal: 0, p: 0, c: 0, f: 0,
  });

// ---------- dates (local calendar days) ----------
export const parseKey = (k) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

export function formatBytes(b) {
  if (b == null) return "—";
  if (b < 1000) return `${Math.round(b)} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}
