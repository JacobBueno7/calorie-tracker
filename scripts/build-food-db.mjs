// Builds data/foods-usda.json from USDA FoodData Central bulk downloads (public domain).
//
// Download the JSON zips from https://fdc.nal.usda.gov/download-datasets and unzip them:
//   - Foundation Foods         (FoodData_Central_foundation_food_json_*.zip)
//   - FNDDS / Survey Foods     (FoodData_Central_survey_food_json_*.zip)
//   - SR Legacy                (FoodData_Central_sr_legacy_food_json_2018-04.zip)
// then run:
//   node scripts/build-food-db.mjs <foundation.json> <survey.json> <sr_legacy.json>
//
// Output: one compact row per food, values per 100 g:
//   [fdcId, name, kcal, protein, carbs, fat, [[portionLabel, grams], ...], set]
//   set: 0 = Foundation, 1 = FNDDS (foods as eaten), 2 = SR Legacy
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const [foundationPath, surveyPath, srPath] = process.argv.slice(2);
if (!srPath) {
  console.error("usage: node scripts/build-food-db.mjs <foundation.json> <survey.json> <sr_legacy.json>");
  process.exit(1);
}
const load = (p) => {
  const j = JSON.parse(readFileSync(p, "utf8"));
  return j[Object.keys(j)[0]];
};

const r1 = (n) => Math.round(n * 10) / 10;
function nutrient(food, ...ids) {
  for (const id of ids) {
    const n = food.foodNutrients.find((x) => x.nutrient?.id === id && typeof x.amount === "number");
    if (n) return n.amount;
  }
  return null;
}
function macros(food) {
  const p = nutrient(food, 1003) ?? 0;
  const f = nutrient(food, 1004, 1085) ?? 0;
  const c = nutrient(food, 1005, 1050) ?? 0;
  // Energy (kcal): reported value, else Atwater-specific/general, else computed 4/4/9.
  let kcal = nutrient(food, 1008, 2048, 2047);
  if (kcal == null && (p || f || c)) kcal = p * 4 + c * 4 + f * 9;
  if (kcal == null) return null;
  return [r1(kcal), r1(p), r1(c), r1(f)];
}

const SKIP_PORTION = /quantity not specified|cubic inch|surface inch|^1 oz yields|^1 100 calorie|guideline amount/i;
function portions(food, set) {
  const out = [];
  const seen = new Set();
  for (const pt of food.foodPortions || []) {
    const g = pt.gramWeight;
    if (!(g > 0)) continue;
    let label;
    if (set === 1) {
      if (/quantity not specified/i.test(pt.portionDescription || "")) label = "1 typical serving";
      else label = pt.portionDescription;
    } else {
      const amount = pt.amount ?? pt.value ?? 1;
      const unit = pt.measureUnit?.name && pt.measureUnit.name !== "undetermined" ? pt.measureUnit.name : "";
      label = [r1(amount), unit, pt.modifier && !/^\d+$/.test(pt.modifier) ? pt.modifier : ""].filter(Boolean).join(" ");
      if (pt.portionDescription && !label.trim()) label = pt.portionDescription;
    }
    label = String(label || "")
      .replace(/\bRACC\b/g, "standard serving") // "Reference Amount Customarily Consumed"
      .replace(/\s+/g, " ")
      .trim();
    if (!label || (SKIP_PORTION.test(label) && label !== "1 typical serving")) continue;
    if (/^\d/.test(label) === false) label = "1 " + label;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([label, r1(g)]);
  }
  // Typical serving first, then the most common household measures; keep it short.
  out.sort((a, b) => (b[0] === "1 typical serving") - (a[0] === "1 typical serving"));
  return out.slice(0, 5);
}

// SR Legacy writes restaurant brands in capitals ("McDONALD'S, BIG MAC"); make them readable.
// Real acronyms (KFC, BBQ) are kept.
const ACRONYMS = new Set(["KFC", "BBQ", "BLT", "USA", "USDA", "NFS", "DHA", "EPA", "TCBY", "IHOP", "PB", "UHT", "MSG", "RTE", "RTF", "NS"]);
function fixCaps(word) {
  if (/^Mc[A-Z']{3,}$/.test(word)) return "Mc" + word[2] + word.slice(3).toLowerCase();
  if (/^[A-Z][A-Z'&-]{2,}$/.test(word) && !ACRONYMS.has(word.replace(/'S$/, ""))) return word[0] + word.slice(1).toLowerCase();
  return word;
}
function cleanName(name) {
  return String(name)
    .replace(/\s*\(Includes foods for [^)]*\)/gi, "")
    .replace(/, NFS\b/g, "")
    .replace(/,(?=\S)/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => w.replace(/^([("]?)(.*?)([),]*)$/, (_, a, core, z) => a + fixCaps(core) + z))
    .join(" ");
}

const rows = new Map(); // lower-cased name -> row (first set wins: Foundation > FNDDS > SR Legacy)
let skipped = 0;
for (const [set, path] of [[0, foundationPath], [1, surveyPath], [2, srPath]]) {
  for (const food of load(path)) {
    const m = macros(food);
    if (!m) {
      skipped++;
      continue;
    }
    const name = cleanName(food.description);
    const key = name.toLowerCase();
    const units = portions(food, set);
    const existing = rows.get(key);
    if (existing) {
      // Same food in another dataset: keep the first one's numbers, borrow extra serving sizes.
      const have = new Set(existing[6].map((u) => u[0].toLowerCase()));
      for (const u of units) if (existing[6].length < 6 && !have.has(u[0].toLowerCase())) existing[6].push(u);
      continue;
    }
    rows.set(key, [food.fdcId, name, ...m, units, set]);
  }
}

const foods = [...rows.values()];
const out = {
  source: "USDA FoodData Central (Foundation, FNDDS 2021-2023, SR Legacy). Public domain. https://fdc.nal.usda.gov",
  generated: new Date().toISOString().slice(0, 10),
  fields: ["fdcId", "name", "kcal", "protein", "carbs", "fat", "portions", "set"],
  foods,
};
mkdirSync("data", { recursive: true });
writeFileSync("data/foods-usda.json", JSON.stringify(out));
const counts = [0, 1, 2].map((s) => foods.filter((f) => f[7] === s).length);
console.log(`Wrote ${foods.length} foods (Foundation ${counts[0]}, FNDDS ${counts[1]}, SR Legacy ${counts[2]}); skipped ${skipped} without energy.`);
