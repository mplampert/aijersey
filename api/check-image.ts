import { generateObject, jsonSchema } from "ai";

/**
 * POST /api/check-image
 *
 * Looks at a generated artwork panel and answers two questions about it: does
 * it carry a real-world mark — a league shield, a professional team crest, a
 * brand logo — and does it carry any lettering at all.
 *
 * Both are things image models do however firmly the prompt forbids them. They
 * are trained on real hockey imagery, which is covered in league marks and in
 * type, and prompting alone has not held: eleven panels in a row came back with
 * words on them.
 *
 * The lettering question rides along on the call the mark check was already
 * making, so it costs nothing. It is also the half that can actually read: the
 * pixel-side detector in check-panel.ts is free and caches nothing, but it can
 * only see that something is shaped like a word, and a row of trees is shaped
 * like a word too.
 *
 * Exported as a function so generate-concept can call it directly rather than
 * paying a second network hop, and as an endpoint so a suspect image can be
 * checked by hand.
 *
 * Env var required: AI_GATEWAY_API_KEY
 */

// Image understanding, not generation: the cheapest vision model on the
// gateway is plenty for a yes/no. $0.10 per 1M input tokens, $0.40 per 1M
// output. A 1024x1024 image is about 1,032 input tokens under Gemini's 768px
// tiling, so a check runs around $0.00013 — roughly a hundredth of a cent.
export const CHECK_MODEL = "google/gemini-2.5-flash-lite";

const QUESTION = [
  "This is a flat artwork panel drawn to be printed onto an ice hockey jersey for a small club. It is artwork only — there is no garment in it.",
  "Answer two questions about it.",
  "First: does it show any real-world mark? That means a sports league logo or shield of any kind (the NHL shield especially), a professional, college or national team crest, or a brand or manufacturer logo such as Bauer, CCM, Nike, Adidas, Reebok or Warrior. An original design invented for this club is fine and is not a real-world mark. Answer found: true only if you can actually see such a mark, and name each one you see in marks.",
  "Second: does it show any lettering at all? That means letters, words, numbers, initials, a monogram, a wordmark, a signature or a date — in any language, any script, at any size, however stylised, decorative or garbled, and including lettering that is only part of the illustration or too distorted to read.",
  "Shapes that merely resemble letters — a row of trees, a skyline, a repeated motif — are not lettering. Answer lettering: true only if these are actually characters, and quote or describe what you see in letters.",
].join(" ");

export type Verdict = {
  found: boolean;
  marks: string[];
  lettering: boolean;
  letters: string[];
  /** False when the check could not be made, so a caller can weigh it. */
  ok: boolean;
};

type Answer = Omit<Verdict, "ok">;

const VERDICT = jsonSchema<Answer>({
  type: "object",
  properties: {
    found: {
      type: "boolean",
      description: "True only if a real-world league, team, brand or manufacturer mark is visible.",
    },
    marks: {
      type: "array",
      items: { type: "string" },
      description: "What was seen, e.g. \"NHL shield, centred\". Empty when found is false.",
    },
    lettering: {
      type: "boolean",
      description: "True if any letters, words, numbers or characters are visible anywhere in the artwork, however stylised or garbled.",
    },
    letters: {
      type: "array",
      items: { type: "string" },
      description: "What the lettering says or looks like, e.g. \"HARBUOR across the middle\". Empty when lettering is false.",
    },
  },
  required: ["found", "marks", "lettering", "letters"],
  additionalProperties: false,
});

/**
 * Returns what the checker saw. A checker that is down or confused fails open,
 * with ok:false so the caller knows to lean on the pixel checks instead: a
 * concept the customer is waiting on should not be lost because the
 * verification step broke, and the human proof is still the real gate.
 */
export async function checkImage(image: {
  data: string;
  mediaType: string;
}): Promise<Verdict> {
  try {
    const { object } = await generateObject({
      model: CHECK_MODEL,
      schema: VERDICT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: QUESTION },
            { type: "file", data: image.data, mediaType: image.mediaType },
          ],
        },
      ],
    });
    return {
      found: !!object.found,
      marks: object.marks ?? [],
      lettering: !!object.lettering,
      letters: object.letters ?? [],
      ok: true,
    };
  } catch (err) {
    console.error("check-image: check failed, letting the image through", err);
    return { found: false, marks: [], lettering: false, letters: [], ok: false };
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    return Response.json({ error: "AI_GATEWAY_API_KEY is not set" }, { status: 500 });
  }

  let body: { image?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(body.image || "");
  if (!m) {
    return Response.json({ error: "Send image as a base64 data URL" }, { status: 400 });
  }

  const verdict = await checkImage({ mediaType: m[1], data: m[2] });
  return Response.json({ model: CHECK_MODEL, ...verdict });
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
