// Offline food search: the ~200 curated built-ins plus ~13,400 USDA FoodData Central foods
// (Foundation, FNDDS "foods as eaten", SR Legacy incl. restaurant & fast food), per 100 g.
// The big list is a separate file, loaded the first time it's needed and then cached for offline use.
import { FOOD_DB } from "./foods.js";

/* global __FOODS_DB_URL__ */
const DB_URL = typeof __FOODS_DB_URL__ !== "undefined" ? __FOODS_DB_URL__ : "foods-usda.json";

let big = null;
let loading = null;

export function loadFoodDB() {
  if (big) return Promise.resolve(big);
  loading ||= fetch(DB_URL)
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((j) => (big = j.foods.map(rowToFood)))
    .catch((e) => {
      loading = null;
      throw e;
    });
  return loading;
}
export const foodDBLoaded = () => !!big;
export const foodDBSize = () => FOOD_DB.length + (big ? big.length : 13400);

function rowToFood([fdcId, name, kcal, p, c, f, units, set]) {
  const s = norm(name);
  return { id: "usda" + fdcId, name, kcal, p, c, f, units: (units || []).map(([label, g]) => ({ label, g })), source: "usda", set, _s: s, _w: s.split(" ").length };
}

// ---------- text matching ----------
// Singular/plural-insensitive: "strawberries" ~ "strawberry", "tomatoes" ~ "tomato", "fries" ~ "fry".
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(ch|sh|x|ss|o)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}
function norm(text) {
  return (
    " " +
    String(text || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // jalapeño -> jalapeno
      .toLowerCase()
      .replace(/['’]/g, "") // McDonald's -> mcdonalds
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9%]+/g, " ")
      .trim()
      .split(" ")
      .map(stem)
      .join(" ")
  );
}

// Everyday words -> the words USDA uses.
const SYNONYMS = {
  coke: ["cola"], pepsi: ["cola"], soda: ["soft drink", "cola", "carbonated"], pop: ["soft drink"],
  sprite: ["lemon lime"], oj: ["orange juice"], pb: ["peanut butter"], pbj: ["peanut butter and jelly"],
  hotdog: ["hot dog", "frankfurter"], frank: ["frankfurter"], ketchup: ["catsup"], catsup: ["ketchup"],
  chickpea: ["garbanzo"], garbanzo: ["chickpea"], scallion: ["green onion", "spring onion"],
  jello: ["gelatin"], popsicle: ["ice pop"], mac: ["macaroni"], spaghetti: ["pasta"],
  fry: ["french fry", "fried"], hamburger: ["burger"], burger: ["hamburger", "cheeseburger"],
  doughnut: ["donut"], donut: ["doughnut"], yoghurt: ["yogurt"], yogurt: ["yoghurt"],
  bbq: ["barbecue"], barbecue: ["bbq"], mcdonald: ["mcdonalds"], mcdonalds: ["mcdonald"],
  bagel: ["bagel"], shake: ["milkshake", "milk shake"], milkshake: ["milk shake", "shake"],
  steak: ["beef steak", "steak"], gyro: ["gyro"], boba: ["bubble tea"], latte: ["coffee latte", "latte"],
};
const SYN = Object.fromEntries(Object.entries(SYNONYMS).map(([k, v]) => [stem(k), v.map((x) => norm(x).trim())]));

const builtIns = FOOD_DB.map((f) => {
  const s = norm(f.name);
  return { food: f, s, w: s.split(" ").length };
});

const STOP = new Set(["and", "with", "or", "the", "a", "an", "of", "in", "on", "w"]);
const wordHit = (s, x) => s.includes(" " + x + " ") || s.endsWith(" " + x);

/**
 * Search everything offline. `mine` = My Foods (ranked first when they match).
 * Returns { foods, partialFrom }: foods matching every word first, then (if there are few)
 * "close matches" that contain some of the words, starting at index `partialFrom`.
 */
export function searchFoods(q, mine = [], limit = 60) {
  let toks = norm(q).trim().split(" ").filter(Boolean);
  const meaningful = toks.filter((t) => !STOP.has(t));
  if (meaningful.length) toks = meaningful;
  if (!toks.length) return { foods: [], partialFrom: 0 };
  const alts = toks.map((t) => [t, ...(SYN[t] || [])]);
  const wantsBaby = /baby|infant|toddler/.test(q.toLowerCase());
  const first = toks[0];

  const strict = [];
  const partial = [];
  const consider = (food, s, w, boost) => {
    let matched = 0;
    let whole = 0;
    for (const a of alts) {
      if (a.some((x) => s.includes(" " + x))) matched++;
      if (a.some((x) => wordHit(s, x))) whole++;
    }
    if (!matched) return;
    // Words only matched as the start of a longer word ("pho" in "phosphate") count for less;
    // the last word gets a pass since it may still be being typed.
    const lastTyping = alts[alts.length - 1].some((x) => s.includes(" " + x)) && !alts[alts.length - 1].some((x) => wordHit(s, x));
    let score = boost + whole * 1.5 - (matched - whole - (lastTyping ? 1 : 0)) * 1.5;
    if (s.startsWith(" " + first)) score += 3;
    score -= w * 0.12; // shorter names are the more generic, more likely match
    if (food.set === 1) score += 0.6; // FNDDS: foods as people eat them
    else if (food.set === 0) score += 0.3; // Foundation: newest lab data
    if (!wantsBaby && / (babyfood|baby food|infant formula|toddler)/.test(s)) score -= 5;
    if (matched === alts.length) strict.push({ food, score, s });
    else if (alts.length > 1 && whole >= 1) partial.push({ food, score: score + whole * 2, s });
  };
  for (const f of mine) {
    const s = norm(`${f.name} ${f.brand || ""}`);
    consider(f, s, s.split(" ").length, 6);
  }
  for (const b of builtIns) consider(b.food, b.s, b.w, 4);
  if (big) for (const f of big) consider(f, f._s, f._w, 0);

  const ids = new Set();
  const names = new Set();
  const take = (list, max) => {
    const out = [];
    list.sort((a, b) => b.score - a.score);
    for (const { food, s } of list) {
      // One row per food: skip the same id, or the same name already shown (built-in beats USDA).
      if (ids.has(food.id) || (food.source !== "custom" && names.has(s))) continue;
      ids.add(food.id);
      names.add(s);
      out.push(food);
      if (out.length >= max) break;
    }
    return out;
  };
  const foods = take(strict, limit);
  const partialFrom = foods.length;
  if (foods.length < 8) foods.push(...take(partial, 25));
  return { foods, partialFrom };
}
