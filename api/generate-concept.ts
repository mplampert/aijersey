import { experimental_generateImage as generateImage, generateText } from "ai";

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

// Refinement needs the previous concept as an input image, and generateImage()
// has no parameter for one — ImageModelV2CallOptions is prompt-only, for every
// provider, so no image model can edit through it. Editing therefore runs
// through generateText with a multimodal image model, which takes the previous
// concept as a file part and returns the edit in result.files.
const EDIT_MODEL = "google/gemini-2.5-flash-image";

// Screened before spending a call. Crude on purpose — the real gate is the
// human review on every 48-hour proof.
const BLOCKED = [
  "nhl", "nfl", "nba", "mlb", "star wars", "marvel", "disney", "pokemon",
  "bruins", "rangers", "maple leafs", "canadiens", "penguins", "oilers",
  "olympic", "team canada", "team usa hockey", "espn", "nike", "adidas",
  "bauer", "ccm", "warrior hockey",
];

// Collar and silhouette, picked by the customer in step 1 so the garment is
// fixed rather than invented on each call. Keys match CFG.styles in index.html.
const STYLES: Record<string, string> = {
  laced:
    "The collar is a traditional laced collar: a short lace-up placket at the throat, laces visible.",
  vneck:
    "The collar is a modern V-neck: a clean V opening at the throat, no lacing and no placket.",
  crew:
    "The collar is a plain crew neck: a round ribbed collar, no lacing, no placket and no V.",
};
const DEFAULT_STYLE = "laced";

// Three takes on the same brief, so the options the customer picks between
// differ by intent rather than by chance. The brief, the colors and the
// collar are identical across all three — only the treatment moves.
// Keys match CFG.variants in index.html.
const VARIANTS: Record<string, string> = {
  safe:
    "Play this one straight: a conservative, classic team jersey. Restrained striping, a traditional chest crest, nothing experimental.",
  bold:
    "Push this one: a bold, striking take on the same brief. Strong graphic striping or color blocking and high contrast, still unmistakably a hockey jersey.",
  crest:
    "Keep the striping restrained and lead with the mark: a distinctly different chest crest concept — another way to symbolise the same brief — on an otherwise clean sweater.",
};

type Ref = { data: string; mediaType: string };

/**
 * Runs a model call twice before giving up. These calls fail intermittently —
 * two of three variants have come back empty in one run — and each variant is
 * an option the customer would otherwise lose. A call that returns no image at
 * all counts as a failure and is retried the same way.
 */
async function twice<T>(
  label: string,
  call: () => Promise<T | null>,
): Promise<T | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await call();
      if (out) return out;
      if (attempt === 1) console.warn(`generate-concept: ${label} returned no image, retrying`);
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`generate-concept: ${label} failed, retrying`, err);
    }
  }
  return null;
}

/** One multimodal draw: the text plus whatever reference images go with it. */
async function draw(
  content: ({ type: "text"; text: string } | { type: "file"; data: string; mediaType: string })[],
) {
  const { files } = await generateText({
    model: EDIT_MODEL,
    messages: [{ role: "user", content }],
  });
  return files.find((f) => f.mediaType?.startsWith("image/")) ?? null;
}

/** A base64 data URL from the page, or null if it is missing or malformed. */
function readDataUrl(value: string | null | undefined): Ref | null {
  if (!value) return null;
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(value);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

type Body = {
  prompt?: string;
  // One of the keys of VARIANTS. Omitted on a refinement, and for anything
  // unrecognised the brief is drawn straight with no variant steer.
  variant?: string;
  // One of the keys of STYLES. Anything else falls back to DEFAULT_STYLE.
  style?: string;
  colors?: { name: string; hex: string }[];
  logo?: string | null;
  // Data URL of the concept being refined. Absent on the first generation.
  baseImage?: string | null;
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

  // Only data URLs — the browser sends back an image this function produced.
  let base = readDataUrl(body.baseImage);
  if (body.baseImage && !base) {
    return Response.json(
      { error: "That concept couldn't be read. Generate a new one and refine from there." },
      { status: 400 },
    );
  }

  // The customer's own crest. An unreadable one is not worth failing over: the
  // jersey is still drawn, just with an original crest instead.
  const logo = readDataUrl(body.logo);
  if (body.logo && !logo) console.warn("generate-concept: unreadable logo, ignoring it");

  const hit = BLOCKED.find((b) => prompt.toLowerCase().includes(b));
  if (hit) {
    return Response.json(
      {
        error:
          `We can't copy "${hit}" — that team or brand belongs to someone ` +
          `else. Tell us the colors and the feel you're after — bold and ` +
          `modern, old-school, dark and mean — and we'll build something ` +
          `original for you.`,
      },
      { status: 422 },
    );
  }

  // Naming the matched colors constrains the model to the factory's card.
  const colorLine = body.colors?.length
    ? `Use only these colors: ${body.colors
        .map((c) => `${c.name} (${c.hex})`)
        .join(", ")}.`
    : "";

  // Front and back are requested in one image so the two views stay consistent
  // with each other. An uploaded logo is attached as a reference image below.

  // Every rule below holds for an edit too, so a refinement can't quietly
  // reintroduce branding or drift the two views apart.
  const RULES = [
    STYLES[body.style ?? ""] ?? STYLES[DEFAULT_STYLE],
    "Both views are the same physical garment: stripe placement, yoke shape, sleeve design and color blocking must match exactly between the front and the back.",
    "The back must show a nameplate and a large two-digit number.",
    "The nameplate reads exactly NAME and the number is exactly 00 — these are placeholders, never an invented player name or number.",
    "Exactly one number on each sleeve, high on the upper arm. Never two numbers stacked on the same sleeve, and never more than one number per sleeve.",
    "No branding of any kind: no manufacturer logos, brand names or brand marks, no neck or collar tags, no hem tags, anywhere on the garment.",
    "No league logos, league shields, league crests or any real-world sports league marks anywhere on the garment — not on the chest, not on the collar, not on the back neck, not on the hem.",
    "Plain neutral light grey studio background, even lighting, no hanger, no model, no props.",
    "Sharp, high-detail product photography, in focus from edge to edge.",
    "No border, no frame, no vignette and no drop shadow box — the jersey fills the frame.",
  ];

  const instruction = [
    "Product photograph of a custom sublimated ice hockey jersey.",
    "Show the front view and the back view side by side, both flat and squarely front-on.",
    ...RULES,
    colorLine,
    "The brief may be only a few words. Treat it as direction, not as the full specification:",
    "honour everything it does say, and design the rest yourself rather than leaving it plain or literal.",
    "Where the brief is silent on striping, crest, yoke, collar or layout, choose a clean conventional hockey design that suits the colors and mood given.",
    logo
      ? "Always produce a finished, well-composed jersey: balanced striping on the sleeves and hem, the supplied logo as the chest crest, and a design that looks like real teamwear."
      : "Always produce a finished, well-composed jersey: balanced striping on the sleeves and hem, an original team crest or wordmark on the chest, and a design that looks like real teamwear.",
    "Design brief:",
    prompt,
    // After the brief, so it steers the treatment without displacing what the
    // customer actually asked for.
    VARIANTS[body.variant ?? ""] ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const editInstruction = [
    "Edit the attached ice hockey jersey concept.",
    "Make only this change, described by the customer:",
    prompt,
    "Everything else must stay exactly as it is — the same garment, the same layout, the same crest, the same striping and the same colors wherever the requested change does not touch them.",
    "Keep the front view and the back view side by side in the same arrangement as the attached image.",
    ...RULES,
    colorLine,
  ]
    .filter(Boolean)
    .join(" ");

  /* generateImage() takes a prompt and nothing else — ImageModelV2CallOptions
     has no field for an input image, for any provider — so MODEL cannot be
     shown the customer's crest. A generation carrying a logo therefore goes
     through the multimodal model instead, the same one refinements use, with
     the logo attached as a reference image. Without a logo nothing changes. */
  const logoInstruction = [
    instruction,
    "The attached image is the team's own logo, and it is the only crest on this jersey.",
    "Reproduce it on the chest exactly as supplied: do not redraw it, reinterpret it, restyle it, recolor it, crop it, change its proportions or add anything to it.",
    "Do not invent, design or substitute any other crest, wordmark, badge, shield or emblem, anywhere on the garment. The supplied logo is the only mark on it.",
  ].join(" ");

  try {
    if (base) {
      const edited = await twice("edit", () =>
        draw([
          { type: "text", text: editInstruction },
          { type: "file", data: base!.data, mediaType: base!.mediaType },
        ]),
      );
      if (!edited) {
        // The model answered in text instead of returning an image. Say so
        // rather than falling back to a fresh generation, which would throw
        // away the design the customer is refining.
        return Response.json(
          { error: "That change didn't come back as an image. Try describing it differently." },
          { status: 502 },
        );
      }

      return Response.json({
        image: `data:${edited.mediaType};base64,${edited.base64}`,
      });
    }

    if (logo) {
      const drawn = await twice("logo generation", () =>
        draw([
          { type: "text", text: logoInstruction },
          { type: "file", data: logo.data, mediaType: logo.mediaType },
        ]),
      );
      if (!drawn) {
        return Response.json(
          { error: "That didn't come back as an image. Try again in a moment." },
          { status: 502 },
        );
      }

      return Response.json({
        image: `data:${drawn.mediaType};base64,${drawn.base64}`,
      });
    }

    const image = await twice("generation", async () => {
      const { image } = await generateImage({
        model: MODEL,
        prompt: instruction,
        size: "1024x1024",
      });
      return image ?? null;
    });
    if (!image) {
      return Response.json(
        { error: "That didn't come back as an image. Try again in a moment." },
        { status: 502 },
      );
    }

    return Response.json({
      image: `data:${image.mediaType ?? "image/png"};base64,${image.base64}`,
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
