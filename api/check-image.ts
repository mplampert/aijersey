import { generateObject, jsonSchema } from "ai";

/**
 * POST /api/check-image
 *
 * Looks at a generated concept and says whether it carries any real-world
 * mark — a league shield, a professional team crest, a brand or manufacturer
 * logo. Image models are trained on real hockey photography, so they reach for
 * these however firmly the prompt forbids them; prompting alone has not held.
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
  "This is a product photograph of a custom ice hockey jersey drawn for a small club.",
  "Does it show any real-world mark? That means: a sports league logo or shield of any kind (the NHL shield especially), a professional, college or national team crest, or a brand or manufacturer logo such as Bauer, CCM, Nike, Adidas, Reebok or Warrior.",
  "Look at the whole garment, including the collar, the back neck, the sleeves, the shoulders, the hem and the socks if any are shown.",
  "An original crest invented for this club is fine and is not a real-world mark.",
  "Placeholder lettering reading NAME, and a placeholder number 00, are fine and are not marks.",
  "Answer found: true only if you can actually see such a mark, and name each one you see in marks.",
].join(" ");

export type Verdict = { found: boolean; marks: string[] };

const VERDICT = jsonSchema<Verdict>({
  type: "object",
  properties: {
    found: {
      type: "boolean",
      description: "True only if a real-world league, team, brand or manufacturer mark is visible.",
    },
    marks: {
      type: "array",
      items: { type: "string" },
      description: "What was seen, e.g. \"NHL shield on the collar\". Empty when found is false.",
    },
  },
  required: ["found", "marks"],
  additionalProperties: false,
});

/**
 * Returns what the checker saw. A checker that is down or confused fails open:
 * a concept the customer is waiting on should not be lost because the
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
    return { found: !!object.found, marks: object.marks ?? [] };
  } catch (err) {
    console.error("check-image: check failed, letting the image through", err);
    return { found: false, marks: [] };
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
