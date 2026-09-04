import { generateObject, jsonSchema } from "ai";

/**
 * POST /api/check-image
 *
 * Looks at a generated concept and answers two questions about it: does it carry
 * a real-world mark — a league shield, a professional team crest, a brand logo —
 * and does it carry any lettering it should not.
 *
 * "Should not" rather than "any", because the back of the jersey is supposed to
 * show a nameplate and a number. Those are asked for as the exact placeholders
 * NAME and 00, which gives this one string to allow and lets it reject
 * everything else — a real name, a wrong number, type on the front or the
 * socks, and a garbled spelling of NAME, which is the failure that actually
 * happens.
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
  "This is a product photograph of a custom ice hockey kit made for a small club: the jersey shown front and back on hangers, with a pair of leg socks alongside.",
  "Answer two questions about it.",
  "First: does it show any real-world mark? That means a sports league logo or shield of any kind (the NHL shield especially), a professional, college or national team crest, or a brand or manufacturer logo such as Bauer, CCM, Nike, Adidas, Reebok or Warrior. Look at the whole kit, including the collar, the back neck, the sleeves, the shoulders, the hem and the socks. An original design invented for this club is fine and is not a real-world mark. Answer found: true only if you can actually see such a mark, and name each one you see in marks.",
  "Second: does it show any lettering it should not?",
  "Exactly one piece of lettering belongs here: on the BACK view of the jersey, a nameplate reading exactly NAME with a large number reading exactly 00 below it. Those two are correct and expected — do not report them.",
  "Everything else is wrong. Report it if you see: any lettering on the front of the jersey, on the sleeves, on the shoulders, on the collar or on the socks; a real or invented player name or team name anywhere; any number other than 00; a nameplate that reads anything other than NAME, including a misspelling of it such as NAMF or NMAE; and any garbled, distorted or unreadable characters anywhere, including on the back.",
  "Judge the back nameplate and number strictly: if the letters do not spell NAME exactly, or the number is not exactly 00, that is wrong lettering and must be reported.",
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
      description: "True if any lettering is visible that is not the back nameplate reading exactly NAME with the number exactly 00. A misspelt nameplate, a wrong number, or any characters on the front, sleeves, collar or socks all count as true.",
    },
    letters: {
      type: "array",
      items: { type: "string" },
      description: "What the wrong lettering says or looks like and where, e.g. \"HARBUOR across the chest\" or \"nameplate reads NAMF\". Empty when lettering is false.",
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
