import { experimental_generateImage as generateImage, generateText } from "ai";
// Compiled output is .js, and the runtime resolves this specifier verbatim —
// so it names the built file, not the source. A ".ts" here type-checks fine
// locally and then 500s in production.
import { checkImage } from "./check-image.js";

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
// collar are identical across all three — what moves is how hard each one
// leans on the print. None of them is a plain sweater: the quiet one is quiet
// across the whole garment, not bare. Keys match CFG.variants in index.html.
const VARIANTS: Record<string, string> = {
  safe:
    "Play this one restrained. The artwork still covers the whole garment, but keep it quiet: a subtle allover texture, a soft gradient through the body, or a single motif carried over the shoulders and down the sleeves. Understated is the brief here — plain is not.",
  scene:
    "Push this one as far as the process goes: a fully illustrated garment. Build a scene or an environment that wraps the front, the back, both sleeves and the shoulders as one continuous picture, with a background, a foreground and painted depth. This take should be obviously printed and impossible to sew.",
  bold:
    "Make this one graphic. Large-scale shapes, hard-edged color blocking, oversized motifs or angular forms running off the edges of the garment at full bleed, printed right through the sleeves and hem. High contrast and poster-like, still unmistakably a hockey jersey.",
};

/* The concept is two views side by side, so a square frame spends most of its
   pixels on air above and below the jerseys and hands the customer two small
   ones. Landscape first, square only if the model refuses the size — a size a
   slug does not happen to accept must not be able to take generation down. */
const SIZES = ["1536x1024", "1024x1024"] as const;

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

type Made = { base64: string; mediaType: string };

/**
 * Draws, then has the image checked for real-world marks. Prompting alone does
 * not stop image models putting an NHL shield on a collar — they are trained on
 * real hockey photography — so a positive verdict buys one redraw that names
 * what was seen. If the redraw is dirty too the variant is dropped: better one
 * option short than a jersey we cannot sell.
 *
 * Every rejection is logged so the rate and the repeat offenders are visible.
 */
async function drawClean(
  what: string,
  make: (extra: string) => Promise<Made | null>,
): Promise<Made | null | "dropped"> {
  const first = await make("");
  if (!first) return null;

  const verdict = await checkImage({ data: first.base64, mediaType: first.mediaType });
  if (!verdict.found) return first;

  const seen = verdict.marks.join(", ") || "a real-world mark";
  console.warn("image-check: rejected, redrawing", { what, marks: verdict.marks });

  const second = await make(
    `A previous attempt showed ${seen}. Do not include ${seen}, or any other real-world league, team, brand or manufacturer mark, anywhere on the garment or its collar.`,
  );
  if (!second) return null;

  const after = await checkImage({ data: second.base64, mediaType: second.mediaType });
  if (!after.found) return second;

  console.warn("image-check: dropped after redraw", { what, marks: after.marks });
  return "dropped";
}

const DROPPED = {
  error:
    "One take kept coming back with a real team's logo on it, so we left it out. Try again for another.",
};

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
  // Whether the customer has their own crest. The file itself never comes
  // here: it is composited onto the finished jersey in the browser.
  ownCrest?: boolean;
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

  /* The customer's crest never reaches the model. It came back mirrored,
     redrawn, or replaced with an invention of the model's own, so the chest is
     drawn empty here and the real file is composited onto it in the browser.
     Only the fact of a crest travels, never the file. */
  const ownCrest = !!body.ownCrest;

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
  // Shades and blends are allowed through deliberately: sublimation prints
  // gradients for free, and "use only these colors" reads to a model as a
  // flat-fill instruction, which is half of why the concepts came back looking
  // sewn. The constraint that matters is the hue, not the number of tones.
  const colorLine = body.colors?.length
    ? `Build the design from these colors: ${body.colors
        .map((c) => `${c.name} (${c.hex})`)
        .join(", ")}. Tints, shades, blends and gradients between them are ` +
      `encouraged; do not introduce a hue that is not on this list.`
    : "";

  // Front and back are requested in one image so the two views stay consistent
  // with each other.

  // Every rule below holds for an edit too, so a refinement can't quietly
  // reintroduce branding or drift the two views apart.
  const RULES = [
    STYLES[body.style ?? ""] ?? STYLES[DEFAULT_STYLE],
    "This is a fully sublimated garment: its artwork is printed into the fabric and may cover any part of it. Printed detail, gradients, illustration and edge-to-edge graphics are correct for this process and must never be flattened into plain panels or stitched-looking stripes.",
    "Both views are the same physical garment: stripe placement, yoke shape, sleeve design and color blocking must match exactly between the front and the back.",
    "The back must show a nameplate and a large two-digit number.",
    "The nameplate reads exactly NAME and the number is exactly 00 — these are placeholders, never an invented player name or number.",
    "The nameplate and the number must stay clearly legible against whatever artwork sits behind them.",
    "Exactly one number on each sleeve, high on the upper arm. Never two numbers stacked on the same sleeve, and never more than one number per sleeve.",
    "No branding of any kind: no manufacturer logos, brand names or brand marks, no neck or collar tags, no hem tags, anywhere on the garment.",
    "No league logos, league shields, league crests or any real-world sports league marks anywhere on the garment — not on the chest, not on the collar, not on the back neck, not on the hem.",
    "Plain neutral light grey studio background, even lighting, no hanger, no model, no props.",
    "Sharp, high-detail product photography, in focus from edge to edge.",
    "No border, no frame, no vignette and no drop shadow box — the jersey fills the frame.",
  ];

  /* Generation only, never an edit — an edit is told to change one thing, and
     these lines would have it redesign the garment instead.

     Image models are trained on photographs of real hockey sweaters, which are
     overwhelmingly sewn twill: a solid body, a stitched stripe set, an appliqué
     crest. Left alone the model reproduces that, which is the one thing this
     process is not. Full-body artwork is the reason a customer picks
     sublimation, so the brief has to say so in as many words. */
  const SUBLIMATION = [
    "The artwork is printed into the fabric across the entire garment. There are no sewn panels, no appliqué and no stitched stripes to design around, and no part of the jersey is off limits to the print.",
    "Treat the whole garment as one continuous canvas: the design runs edge to edge across the chest and the back, over both sleeves, across the shoulders and the yoke, around the sides and through the hem. Do not treat the body as a plain field with a crest sitting on it.",
    "Illustrated scenes, environments, allover patterns, gradients, fades, textures and large graphic elements that wrap around the garment are all available, and the design should use them wherever the brief suits it.",
    "This process has no color limit and no separation cost, so smooth gradients, blends and photographic detail are free. Use them rather than flattening the design into flat blocks of solid color.",
    "The finished design must be impossible to produce in sewn twill. If it could be built from a solid body, a few stitched stripes and an appliqué patch, it is wrong — redesign it with artwork that carries the whole garment.",
  ];

  const instruction = [
    "Product photograph of a custom sublimated ice hockey jersey.",
    "Show the front view and the back view side by side, both flat and squarely front-on.",
    ...SUBLIMATION,
    ...RULES,
    colorLine,
    "The brief may be only a few words. Treat it as direction, not as the full specification:",
    "honour everything it does say, and design the rest yourself rather than leaving it plain or literal.",
    "Where the brief is silent on subject, pattern, layout or striping, invent something that suits the colors and the mood it does give, and carry it across the whole garment. Silence is room to design, not a reason to leave the jersey plain.",
    ownCrest
      ? "Leave the centre chest clear for the team's own crest, which is added afterwards: no crest, no logo, no wordmark, no monogram, no graphic element and no lettering of any kind there. The artwork still covers the rest of the garment, but it must settle into a calm, uncluttered area at the centre chest so a crest can sit on top of it and still read."
      : "Always produce a finished, well-composed jersey: artwork that carries the whole garment and reads from across the rink, an original team crest or wordmark on the chest, and something that still reads unmistakably as real teamwear.",
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

  try {
    if (base) {
      const edited = await drawClean("refinement", (extra) =>
        twice("edit", () =>
          draw([
            { type: "text", text: extra ? `${editInstruction} ${extra}` : editInstruction },
            { type: "file", data: base!.data, mediaType: base!.mediaType },
          ]),
        ),
      );
      if (edited === "dropped") return Response.json(DROPPED, { status: 422 });
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

    const image = await drawClean(body.variant ?? "generation", (extra) =>
      twice("generation", async () => {
        const text = extra ? `${instruction} ${extra}` : instruction;
        for (const size of SIZES) {
          try {
            const { image } = await generateImage({ model: MODEL, prompt: text, size });
            if (image) return image;
          } catch (err) {
            if (size === SIZES[SIZES.length - 1]) throw err;
            console.warn(`generate-concept: ${MODEL} refused ${size}, falling back`, err);
          }
        }
        return null;
      }),
    );
    if (image === "dropped") return Response.json(DROPPED, { status: 422 });
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
