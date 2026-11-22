import Anthropic from "@anthropic-ai/sdk";

// JSON schema the model must follow (structured outputs).
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Food name, include cooking method, e.g. 'grilled chicken breast'" },
          grams: { type: "number", description: "Estimated edible weight in grams (ml for drinks)" },
          calories: { type: "number", description: "Total kcal for that weight" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["name", "grams", "calories", "protein_g", "carbs_g", "fat_g", "confidence"],
        additionalProperties: false,
      },
    },
    notes: { type: "string", description: "One or two short sentences on assumptions (oil, sauces, hidden items)" },
  },
  required: ["items", "notes"],
  additionalProperties: false,
};

const SYSTEM = `You are a nutrition analyst inside a personal calorie-tracking app.
Identify every distinct food and drink in the input and estimate its edible weight and nutrition.
- Use USDA FoodData Central reference values per 100 g and scale by your weight estimate.
- Estimate portion sizes from visual cues: plate (~26 cm dinner plate), utensils, hands, packaging, containers.
- Account for cooking oil, butter, dressings and sauces you can see or that are typical for the dish; list them as separate items when significant.
- If the user states a weight or quantity, use it exactly instead of estimating.
- Split mixed dishes into main components when that improves accuracy (e.g. rice, chicken, sauce).
- If nothing edible is visible, return an empty items array and explain in notes.`;

// The only place the API key is ever sent. Hard-coded so nothing can redirect it.
const ANTHROPIC_API = "https://api.anthropic.com";

/** Anthropic API keys look like "sk-ant-api03-…". Reject anything else before saving. */
export function looksLikeAnthropicKey(key) {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
}

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most accurate)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (cheaper, faster)" },
];

/** Resize an image File to a JPEG base64 string (max 1568px on the long side). */
export async function imageToBase64(file, maxSide = 1568) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Could not read that image."));
      i.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Ask Claude to analyze a meal photo and/or a text description.
 * Returns { items: [...], notes: string }.
 */
export async function analyzeMeal({ apiKey, model, imageBase64, description }) {
  if (!apiKey) throw new Error("Add your Anthropic API key in Settings first.");
  // dangerouslyAllowBrowser: this is a single-user app on your own phone, calling
  // Anthropic directly with your own key (see the security notes in README).
  const client = new Anthropic({ apiKey, baseURL: ANTHROPIC_API, dangerouslyAllowBrowser: true, maxRetries: 2 });

  const content = [];
  if (imageBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } });
  }
  content.push({
    type: "text",
    text: imageBase64
      ? `Analyze this meal photo.${description ? ` Extra info from me: ${description}` : ""}`
      : `Estimate the nutrition for: ${description}`,
  });

  let response;
  try {
    response = await client.beta.messages.create({
      model: model || "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: RESULT_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Your API key was rejected. Check it in Settings.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Rate limited by the API. Wait a moment and try again.");
    if (err instanceof Anthropic.BadRequestError) throw new Error("Request rejected: " + (err.message || "bad request"));
    if (err instanceof Anthropic.APIConnectionError) throw new Error("No connection to the AI service. Check your internet.");
    if (err instanceof Anthropic.APIError) throw new Error("AI service error: " + (err.message || err.status));
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new Error("The AI declined to analyze this. Try another photo or description.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("The AI response was cut off. Try again.");
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Could not read the AI response. Try again.");
  }
  data.items = (data.items || []).filter((it) => it && it.grams > 0);
  return data;
}
