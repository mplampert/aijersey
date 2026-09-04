// Compiled output is .js, and the runtime resolves this specifier verbatim.
import { readGallery } from "./save-design.js";

/**
 * GET /api/gallery?t=<token>
 *
 * Every design saved under one customer's address, newest first, for the
 * gallery page to render.
 *
 * The token is the only way in. It is not the email address and cannot be
 * derived from one: /designs?t=someone@gmail.com would let anybody type an
 * address and read that person's designs, which is the whole reason this takes
 * a random id instead. Same unlisted-link model as Share id on the Proofs
 * table — anyone holding the link can see the gallery, so it is unlisted rather
 * than private, and it is never shown anywhere but in that customer's own mail.
 *
 * Attachment URLs are handed out live rather than stored, because Airtable
 * expires them within hours. Each load of the page gets fresh ones.
 *
 * Env vars required: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID.
 */

// Base64url, which is what makeGalleryId produces. Long enough that guessing is
// not a strategy, and refused rather than trimmed if it is any other shape.
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

const NOT_FOUND = {
  error: "That gallery link isn't valid. Check it came through unbroken, or ask us for a new one.",
};

export async function GET(request: Request): Promise<Response> {
  const began = Date.now();
  const token = (new URL(request.url).searchParams.get("t") || "").trim();

  if (!TOKEN.test(token)) {
    return Response.json(NOT_FOUND, { status: 400 });
  }

  const missing = ["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "AIRTABLE_TABLE_ID"]
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`gallery FAIL config :: not set: ${missing.join(", ")}`);
    return Response.json({ error: "The gallery isn't configured" }, { status: 503 });
  }

  const found = await readGallery(token);
  const took = ((Date.now() - began) / 1000).toFixed(1);

  if (!found.length) {
    console.log(`gallery: nothing behind ${token.slice(0, 6)}… ${took}s`);
    return Response.json(NOT_FOUND, { status: 404 });
  }

  console.log(`gallery OK ${took}s ${token.slice(0, 6)}… designs=${found.length}`);
  /* Codes, dates and pictures. Not the email, not the session, not the record
     id — none of it is needed to draw the page, and a link that leaks the
     address it belongs to would undo the point of the token. */
  return Response.json({
    designs: found.map((d) => ({
      code: d.code,
      created: d.created,
      variant: d.variant,
      image: d.imageUrl,
    })),
  });
}

export async function POST(): Promise<Response> {
  return Response.json({ error: "Use GET" }, { status: 405 });
}
