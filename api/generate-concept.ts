import { experimental_generateImage as generateImage } from "ai";

/**
 * POST /api/generate-concept
 *
 * Generates the customer-facing CONCEPT image only. Not a production file —
 * the factory redraws from this, and the customer approves the factory's
 * 48-hour proof, never this image.
 *
 * Routed through Vercel AI Gateway, so one key covers every provider and
 * swapping models is a string change below.
 *
 * Env var required: AI_GATEWAY_API_KEY
 */

// Confirm the exact slug in your Vercel AI Gateway model list before launch —
// these move. Candidates: "openai/gpt-image-2" (best prompt adherence),
// "google/gemini-2.5-flash-image" (cheapest), "black-forest-labs/flux-2-pro".
const MODEL = "openai/gpt-image-2";

// Screened before spending a call. Crude on purpose — the real gate is the
// human review on every 48-hour proof.
const BLOCKED = [
  "nhl", "nfl", "nba", "mlb", "star wars", "marvel", "disney", "pokemon",
  "bruins", "rangers", "maple leafs", "canadiens", "penguins", "oilers",
  "olympic", "team canada", "team usa hockey", "espn", "nike", "adidas",
  "bauer", "ccm", "warrior hockey",
];

type Body = {
  prompt?: string;
  colors?: { name: string; hex: string }[];
  logo?: string | null;
};

export async function POST(request: Request): Promise<Response> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    return Response.json(
      { error: "AI_GATEWAY_API_KEY is not set" },
      { status: 500 },
    );
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const prompt = (body.prompt || "").trim().slice(0, 600);
  if (!prompt) {
    return Response.json(
      { error: "Describe the jersey first" },
      { status: 400 },
    );
  }

  const hit = BLOCKED.find((b) => prompt.toLowerCase().includes(b));
  if (hit) {
    return Response.json(
      {
        error:
          `We can't build designs using "${hit}" — it's someone else's ` +
          `trademark. Describe the look you want and we'll draw something original.`,
      },
      { status: 422 },
    );
  }

  // Naming the matched colours constrains the model to the factory's card.
  const colorLine = body.colors?.length
    ? `Use only these colours: ${body.colors
        .map((c) => `${c.name} (${c.hex})`)
        .join(", ")}.`
    : "";

  // NOTE: the page uploads a logo, but reference-image conditioning is
  // model-specific and not wired yet. Front and back are requested in one
  // image so the two views stay consistent with each other.
  const instruction = [
    "Product photograph of a custom sublimated ice hockey jersey.",
    "Show the front view and the back view side by side, both flat and squarely front-on.",
    "Both views are the same physical garment: stripe placement, yoke shape, sleeve design and colour blocking must match exactly between the front and the back.",
    "The back must show a nameplate and a large two-digit number.",
    "The nameplate reads exactly NAME and the number is exactly 00 — these are placeholders, never an invented player name or number.",
    "No branding of any kind: no manufacturer logos, brand names or brand marks, no neck or collar tags, no hem tags, anywhere on the jersey.",
    "Plain neutral light grey studio background, even lighting, no hanger, no model, no props.",
    colorLine,
    "Design brief:",
    prompt,
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const { image } = await generateImage({
      model: MODEL,
      prompt: instruction,
      size: "1024x1024",
    });

    return Response.json({
      image: `data:${image.mimeType ?? "image/png"};base64,${image.base64}`,
    });
  } catch (err) {
    console.error("generate-concept failed", err);
    return Response.json(
      { error: "Couldn't generate that concept. Try describing it differently." },
      { status: 502 },
    );
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
