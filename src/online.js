// Online food lookups: USDA FoodData Central (generic foods) and
// Open Food Facts (packaged / branded foods + barcodes). Both are free.

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- USDA FoodData Central ----------
const NUTR = { kcal: [1008, 2047, 2048], p: [1003], c: [1005], f: [1004] };

function pickNutrient(list, ids) {
  for (const id of ids) {
    const n = list.find((x) => x.nutrientId === id && x.value != null);
    if (n) return n.value;
  }
  return null;
}

function usdaToFood(f, branded) {
  const list = f.foodNutrients || [];
  const kcal = pickNutrient(list, NUTR.kcal);
  if (kcal == null) return null;
  const units = [];
  const unit = String(f.servingSizeUnit || "").toLowerCase();
  if (branded && f.servingSize > 0 && (unit === "g" || unit === "grm" || unit === "ml" || unit === "mlt")) {
    units.push({ label: `1 serving${f.householdServingFullText ? ` (${f.householdServingFullText})` : ""}`, g: round1(f.servingSize) });
  }
  return {
    id: "usda" + f.fdcId,
    name: titleCase(f.description),
    brand: branded ? titleCase(f.brandName || f.brandOwner || "") : "",
    barcode: f.gtinUpc || "",
    kcal: round1(kcal),
    p: round1(pickNutrient(list, NUTR.p)),
    c: round1(pickNutrient(list, NUTR.c)),
    f: round1(pickNutrient(list, NUTR.f)),
    units,
    source: branded ? "off" : "usda", // "off" = packaged/branded in the UI
  };
}

async function usdaSearch(query, apiKey, dataType, pageSize) {
  const key = apiKey || "DEMO_KEY";
  const url =
    `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(key)}` +
    `&query=${encodeURIComponent(query)}&dataType=${encodeURIComponent(dataType)}&pageSize=${pageSize}`;
  const data = await fetchJson(url);
  const branded = dataType === "Branded";
  return (data.foods || []).map((f) => usdaToFood(f, branded)).filter(Boolean);
}

/** Generic foods (USDA Foundation + SR Legacy), values per 100 g. */
export const searchUSDA = (query, apiKey) => usdaSearch(query, apiKey, "Foundation,SR Legacy", 25);

/** Packaged / branded foods from manufacturer labels (USDA Branded Foods), per 100 g. */
export const searchBranded = (query, apiKey) => usdaSearch(query, apiKey, "Branded", 25);

function titleCase(s) {
  s = String(s || "").toLowerCase().trim();
  // Some branded records repeat the description twice ("a, b, a, b") — keep one copy.
  const parts = s.split(", ");
  if (parts.length % 2 === 0) {
    const half = parts.length / 2;
    if (parts.slice(0, half).join(", ") === parts.slice(half).join(", ")) s = parts.slice(0, half).join(", ");
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Open Food Facts ----------
const OFF_FIELDS = "code,product_name,brands,nutriments,serving_quantity,serving_size,quantity";

function offToFood(p) {
  const n = p.nutriments || {};
  let kcal = n["energy-kcal_100g"];
  if (kcal == null && n["energy_100g"] != null) kcal = n["energy_100g"] / 4.184; // kJ -> kcal
  if (kcal == null || !p.product_name) return null;
  const units = [];
  const sq = parseFloat(p.serving_quantity);
  if (sq > 0) units.push({ label: `1 serving${p.serving_size ? ` (${p.serving_size})` : ""}`, g: sq });
  return {
    id: "off" + p.code,
    name: p.product_name.trim(),
    brand: (p.brands || "").split(",")[0].trim(),
    barcode: p.code,
    kcal: round1(kcal),
    p: round1(n["proteins_100g"]),
    c: round1(n["carbohydrates_100g"]),
    f: round1(n["fat_100g"]),
    units,
    source: "off",
  };
}

export async function searchOFF(query) {
  const url =
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}` +
    `&search_simple=1&action=process&json=1&page_size=25&fields=${OFF_FIELDS}`;
  const data = await fetchJson(url, 15000);
  return (data.products || []).map(offToFood).filter(Boolean);
}

/** Barcode -> food. Tries Open Food Facts first, then USDA Branded Foods (UPC). */
export async function lookupBarcode(code, usdaKey) {
  let offError = null;
  try {
    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${OFF_FIELDS}`;
    const data = await fetchJson(url);
    if (data.status === 1 && data.product) {
      const food = offToFood({ ...data.product, code: data.product.code || code });
      if (food) return food;
    }
  } catch (e) {
    if (!String(e.message).includes("404")) offError = e;
  }
  try {
    const hits = await searchBranded(code, usdaKey);
    const strip = (s) => String(s || "").replace(/^0+/, "");
    const match = hits.find((f) => strip(f.barcode) === strip(code));
    if (match) return match;
  } catch (e) {
    if (offError) throw offError;
  }
  return null;
}

// ---------- Barcode scanning (camera) ----------
let zxingModule = null;
async function getZxing() {
  if (!zxingModule) zxingModule = await import("@zxing/browser");
  return zxingModule;
}

/** Start live scanning into a <video>. Calls onCode(text) once. Returns a stop() function. */
export async function startBarcodeScan(videoEl, onCode) {
  const { BrowserMultiFormatReader } = await getZxing();
  const reader = new BrowserMultiFormatReader();
  let done = false;
  const controls = await reader.decodeFromConstraints(
    { video: { facingMode: { ideal: "environment" } } },
    videoEl,
    (result, _err, ctrl) => {
      if (result && !done) {
        done = true;
        ctrl.stop();
        onCode(result.getText());
      }
    }
  );
  return () => {
    done = true;
    controls.stop();
  };
}

/** Decode a barcode from a still photo (fallback when live camera isn't available). */
export async function decodeBarcodeFromFile(file) {
  const { BrowserMultiFormatReader } = await getZxing();
  const reader = new BrowserMultiFormatReader();
  const url = URL.createObjectURL(file);
  try {
    const result = await reader.decodeFromImageUrl(url);
    return result.getText();
  } finally {
    URL.revokeObjectURL(url);
  }
}
