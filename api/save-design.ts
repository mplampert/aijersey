import { put } from "@vercel/blob";

/**
 * POST /api/save-design
 *
 * Files every concept the moment it is drawn, so a customer who loses theirs
 * can quote a four-character code back to us and we can look it up. The image
 * goes to Vercel Blob; the record goes to Airtable with the blob URL in the
 * Concept attachment field. Each of the three options gets its own code and
 * its own record.
 *
 * Best-effort by design: the page fires this without waiting on it and ignores
 * the outcome, so a failure here costs the customer their code, never their
 * design.
 *
 * Env vars required:
 *   BLOB_READ_WRITE_TOKEN  — created with the Vercel Blob store
 *   AIRTABLE_TOKEN         — personal access token, data.records:write on the base
 *   AIRTABLE_BASE_ID       — base "AI Jersey Designs"
 *   AIRTABLE_TABLE_ID      — table "Designs"
 */

// Written by field id, not name, so renaming a column in Airtable can't break
// the write. Do not add fields here without creating them in the base first.
const FIELD = {
  code: "fldQErtLQMODLkERB",
  prompt: "fldmB5mAbH04AngkG",
  style: "fldeFewvBIGbQQxGu",
  variant: "fldo3bkTmpakMmBx8",
  colors: "fld7YqigCvKMGi2Bs",
  concept: "fldRvuWtY3JtCNAsI",
  logo: "fldm43EXloFFHhhar",
  status: "fldiXTMcs43bi9pd0",
  session: "fldNJ7GYCybw4OAuf",
  created: "fld5rM5os7ZFssjJS",
  email: "fldizSNmZ7eJrsGgL",
} as const;

// Style and Status are single selects. typecast lets Airtable match a plain
// string to an option, but it will also invent a new option for anything else,
// so Style is written only when it is one of the three the base offers.
const STYLE_OPTIONS = ["Laced collar", "V-neck", "Crew"];
const STATUS_ON_SAVE = "Concept";

// Uppercase, with the glyphs people misread removed: no I or 1, no O or 0.
// 32 characters, and 256 divides by 32, so the bytes below map without bias.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length]).join("");
}

type Body = {
  // An address arriving with a recordId attaches to that design instead of
  // filing a new one — by the time the customer asks for a copy, the design
  // is already on record with a code.
  recordId?: string;
  email?: string;
  session?: string;
  prompt?: string;
  style?: string | string[];
  variant?: string;
  colors?: { name: string; hex: string }[];
  image?: string | null;
  logo?: string | null;
};

type Decoded = { buffer: Buffer; mediaType: string; ext: string };

function decodeDataUrl(value: string): Decoded | null {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/is.exec(value);
  if (!m) return null;
  const mediaType = m[1];
  const ext = (mediaType.split("/")[1] || "bin")
    .replace(/\+.*$/, "")
    .replace("jpeg", "jpg");
  return { buffer: Buffer.from(m[2], "base64"), mediaType, ext };
}

async function store(name: string, file: Decoded): Promise<string> {
  const blob = await put(`${name}.${file.ext}`, file.buffer, {
    access: "public",
    contentType: file.mediaType,
    addRandomSuffix: true,
  });
  return blob.url;
}

// Deliberately loose. The real check is whether the mail lands.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function unconfigured(keys: string[]): Response | null {
  const missing = keys.filter((k) => !process.env[k]);
  if (!missing.length) return null;
  console.error("save-design not configured, missing:", missing.join(", "));
  return Response.json({ error: "Design saving isn't configured" }, { status: 503 });
}

const table = () =>
  `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`;

const airtableHeaders = () => ({
  Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
  "Content-Type": "application/json",
});

/**
 * Attaches an address to a design already on file. Patches that one record —
 * the design was saved the moment it was drawn, so creating a second row here
 * would just split one design across two.
 */
async function attachEmail(recordId: string, email: string): Promise<Response> {
  const notReady = unconfigured([
    "AIRTABLE_TOKEN",
    "AIRTABLE_BASE_ID",
    "AIRTABLE_TABLE_ID",
  ]);
  if (notReady) return notReady;

  try {
    const res = await fetch(`${table()}/${encodeURIComponent(recordId)}`, {
      method: "PATCH",
      headers: airtableHeaders(),
      body: JSON.stringify({ fields: { [FIELD.email]: email } }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Airtable ${res.status}: ${detail.slice(0, 300)}`);
    }

    // TODO: send the customer their copy. The design and the code are already
    // on record, so this only needs the transactional mail — attach or link
    // the concept, quote the code, and report a provider failure back to the
    // page, which renders { error }. Until then the page must not tell anyone
    // an email is on its way.

    return Response.json({ ok: true });
  } catch (err) {
    console.error("save-design: attaching email failed", { recordId, err });
    return Response.json(
      { error: "We couldn't save your address against that design" },
      { status: 502 },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  if (body.email !== undefined || body.recordId) {
    const email = (body.email || "").trim();
    if (!EMAIL.test(email)) {
      return Response.json(
        { error: "That doesn't look like an email address — check it and try again." },
        { status: 400 },
      );
    }
    if (!body.recordId) {
      return Response.json(
        { error: "That design isn't on file yet, so there's nothing to attach your address to." },
        { status: 400 },
      );
    }
    return attachEmail(body.recordId, email);
  }

  if (!body.image) {
    return Response.json({ error: "No concept image to save" }, { status: 400 });
  }
  const concept = decodeDataUrl(body.image);
  if (!concept) {
    return Response.json(
      { error: "The concept image wasn't a readable data URL" },
      { status: 400 },
    );
  }

  const notReady = unconfigured([
    "BLOB_READ_WRITE_TOKEN",
    "AIRTABLE_TOKEN",
    "AIRTABLE_BASE_ID",
    "AIRTABLE_TABLE_ID",
  ]);
  if (notReady) return notReady;

  const code = makeCode();
  const session = (body.session || "").trim().slice(0, 60) || "unknown";
  const style = Array.isArray(body.style) ? "" : (body.style || "").trim();
  const variant = (body.variant || "").trim();

  try {
    const conceptUrl = await store(`designs/${session}/${code}-concept`, concept);

    const logo = body.logo ? decodeDataUrl(body.logo) : null;
    const logoUrl = logo
      ? await store(`designs/${session}/${code}-logo`, logo)
      : null;

    // Airtable fetches these URLs and keeps its own copy, so the attachment
    // survives independently of the blob.
    const fields: Record<string, unknown> = {
      [FIELD.code]: code,
      [FIELD.prompt]: (body.prompt || "").trim().slice(0, 2000),
      [FIELD.variant]: variant,
      [FIELD.colors]: (body.colors ?? [])
        .map((c) => `${c.name} ${c.hex}`)
        .join(", "),
      [FIELD.concept]: [{ url: conceptUrl }],
      [FIELD.status]: STATUS_ON_SAVE,
      [FIELD.session]: session,
      [FIELD.created]: new Date().toISOString(),
    };
    if (STYLE_OPTIONS.includes(style)) fields[FIELD.style] = style;
    else if (style) console.warn("save-design: dropping unknown Style", style);
    if (logoUrl) fields[FIELD.logo] = [{ url: logoUrl }];

    const res = await fetch(table(), {
      method: "POST",
      headers: airtableHeaders(),
      // typecast is what lets the single selects accept a plain string.
      body: JSON.stringify({ fields, typecast: true }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Airtable ${res.status}: ${detail.slice(0, 300)}`);
    }

    // The record id comes back to the page so that asking for a copy later
    // patches this row rather than filing a second one.
    const created = await res.json().catch(() => null);
    return Response.json({ code, id: created?.id ?? null });
  } catch (err) {
    // Never the customer's problem: the concept is already on their screen.
    console.error("save-design failed", { code, session, err });
    return Response.json({ error: "Couldn't save that design" }, { status: 502 });
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
