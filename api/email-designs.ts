// Compiled output is .js, and the runtime resolves this specifier verbatim.
import { findByEmail, galleryFor, galleryUrl, patchGallery } from "./save-design.js";
import { sendDesign } from "../lib/send-design.js";

/**
 * POST /api/email-designs
 *
 * The way back in when the code is gone. A customer types the address they
 * saved with and is emailed a link to their gallery — every design filed under
 * that address, in one place.
 *
 * Until this existed the four-character code was the only route to a design.
 * Nothing read the Email column at all — it was written and never looked at, so
 * a customer who lost the code and the link had lost the design, however
 * carefully they had saved it.
 *
 * The answer is the same either way. Whether or not that address has anything
 * on file, this says it has sent something if there was something to send —
 * because saying "no designs found" turns the endpoint into a way to ask us
 * which of your customers' addresses are real, and the person who actually owns
 * the address finds out in their inbox regardless.
 *
 * Env vars required: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID,
 * RESEND_API_KEY.
 */

// Deliberately loose, then narrowed: quotes and backslashes are refused because
// the address is interpolated into an Airtable formula.
const EMAIL = /^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]{2,}$/;

/* Said whether or not anything was found. */
const SENT = {
  ok: true,
  message: "If we have designs saved under that address, a link to them is on its way.",
};

export async function POST(request: Request): Promise<Response> {
  const began = Date.now();

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const email = (body.email || "").trim().slice(0, 200);
  if (!EMAIL.test(email)) {
    return Response.json(
      { error: "That doesn't look like an email address — check it and try again." },
      { status: 400 },
    );
  }

  const missing = ["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "AIRTABLE_TABLE_ID", "RESEND_API_KEY"]
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`email-designs FAIL config :: not set: ${missing.join(", ")}`);
    return Response.json({ error: "Design lookup isn't configured" }, { status: 503 });
  }

  const designs = await findByEmail(email);
  const took = ((Date.now() - began) / 1000).toFixed(1);

  if (!designs.length) {
    /* Logged, because an address with nothing under it is worth seeing when
       somebody writes in saying they got no email — but not told apart from a
       success in the response. */
    console.log(`email-designs: nothing on file for ${email} ${took}s`);
    return Response.json(SENT);
  }

  /* A customer who saved before galleries existed has designs and no token.
     Mint one and stamp it across everything of theirs, so the link this mail
     carries opens all of it rather than nothing. */
  let token = await galleryFor(email);
  if (!token) {
    token = await patchGallery(designs.map((d) => d.id));
    console.log(`email-designs: minted gallery ${token} for ${email}`);
  }

  const latest = designs[0];
  const sent = await sendDesign({
    to: email,
    gallery: galleryUrl(token, request.headers.get("origin")),
    code: latest.code,
    imageUrl: latest.imageUrl,
    count: designs.length,
    reason: "lookup",
  });

  if (!sent.ok) {
    console.error(`email-designs FAIL send ${took}s to=${email} :: ${sent.message}`);
    return Response.json(
      { error: "We couldn't send that just now — try again in a moment." },
      { status: 502 },
    );
  }

  console.log(`email-designs OK ${took}s to=${email} designs=${designs.length}`);
  return Response.json(SENT);
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
