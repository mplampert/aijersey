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
  phone: "flduSOZr6r0zh1gu1",
  kit: "fldsqik6ZInUTnwKM",
  roster: "fldySSOUbQIBBObQQ",
  rosterCount: "fldXNT5mBgEYudtYW",
  team: "fldaEQKn1znas35Rt",
} as const;

// Style and Status are single selects. typecast lets Airtable match a plain
// string to an option, but it will also invent a new option for anything else,
// so Style is written only when it is one of the three the base offers.
const STYLE_OPTIONS = ["Laced collar", "V-neck", "Crew"];
const STATUS_ON_SAVE = "Concept";

// Kit items is a multiple select, and the patch below sends typecast, which
// would invent an option for anything the base doesn't already offer. These
// three are what it offers, so anything else is dropped here instead.
const KIT_OPTIONS = ["Socks", "Skate soakers", "Player bags"];

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
  // Optional, and stored E.164. Sent from the design step's capture and from
  // the account details at checkout; both patch the same record by id.
  phone?: string;
  // The matching kit the customer said yes to, by Airtable option name. None
  // of these is previewed — they are confirmed on the factory proof.
  kit?: string[];
  // Sent on every change, so a roster that never reaches checkout is still on
  // record. Sock size is only asked for when socks were said yes to.
  roster?: {
    num?: string;
    name?: string;
    size?: string;
    sock?: string;
    goalie?: boolean;
  }[];
  team?: string;
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

const colorText = (colors: Body["colors"]) =>
  (colors ?? []).map((c) => `${c.name} ${c.hex}`).join(", ");

// One player per line, always the same five columns, so a half-filled roster
// still lines up when someone reads the cell. A dash holds a column with no
// answer — no sock size asked for, or not a goalie.
const ROSTER_LIMIT = 100_000;   // Airtable's ceiling on a long text field
const rosterText = (roster: Body["roster"]) =>
  (roster ?? [])
    .map((p) =>
      [p.num, p.name, p.size, p.sock, p.goalie ? "G" : ""]
        .map((v) => String(v ?? "").trim() || "-")
        .join(", "),
    )
    .join("\n")
    .slice(0, ROSTER_LIMIT);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Airtable fetches attachment URLs itself, a moment after the record is
 * written, and a blob that is not readable yet comes back as a broken
 * attachment. Wait for the upload to actually be public before handing over
 * the URL. Usually true on the first try, so this normally costs nothing.
 */
async function waitUntilReadable(url: string, tries = 4): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) return true;
    } catch {
      // not serving yet
    }
    await sleep(150 * 2 ** i);
  }
  console.error("save-design: blob never became readable", url);
  return false;
}

/**
 * Reads the record back and re-sends any attachment Airtable failed to pick
 * up. One of a batch coming back broken while its siblings worked is exactly
 * what this catches.
 */
async function retryAttachments(
  recordId: string,
  urls: { field: string; url: string }[],
): Promise<void> {
  await sleep(1200);
  try {
    const res = await fetch(`${table()}/${encodeURIComponent(recordId)}`, {
      headers: airtableHeaders(),
    });
    if (!res.ok) return;
    const rec = await res.json();
    const missing = urls.filter((u) => {
      const cell = rec?.fields?.[u.field];
      return !Array.isArray(cell) || cell.length === 0;
    });
    if (!missing.length) return;

    console.warn("save-design: re-sending attachments", {
      recordId,
      fields: missing.map((m) => m.field),
    });
    const fields = Object.fromEntries(missing.map((m) => [m.field, [{ url: m.url }]]));
    await fetch(`${table()}/${encodeURIComponent(recordId)}`, {
      method: "PATCH",
      headers: airtableHeaders(),
      body: JSON.stringify({ fields }),
    });
  } catch (err) {
    // The record itself is already saved; a broken thumbnail is not worth
    // failing the save over.
    console.error("save-design: attachment retry failed", { recordId, err });
  }
}

// Deliberately loose. The real check is whether the mail lands.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Loose on the way in, strict on the way out. Everything but the digits is
 * thrown away, a leading country 1 is dropped, and what is left has to be a
 * dialable NANP number — area code and exchange can't start with 0 or 1 — or
 * it is refused. A number nobody can text is worse than an empty field.
 */
function normalPhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

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
 * Updates a design already on file. Patches that one record — the design was
 * saved the moment it was drawn, so creating a second row here would just
 * split one design across two.
 */
async function updateRecord(
  recordId: string,
  fields: Record<string, unknown>,
): Promise<Response> {
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
      // typecast is what lets Kit items accept plain option names.
      body: JSON.stringify({ fields, typecast: true }),
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
    console.error("save-design: updating the record failed", { recordId, err });
    return Response.json(
      { error: "We couldn't save that against your design" },
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

  // An address or a palette arriving with a recordId belongs to a design
  // already on file, so it patches that row rather than opening a new one.
  if (body.email !== undefined || body.recordId) {
    const fields: Record<string, unknown> = {};

    if (body.email !== undefined) {
      const email = (body.email || "").trim();
      if (!EMAIL.test(email)) {
        return Response.json(
          { error: "That doesn't look like an email address — check it and try again." },
          { status: 400 },
        );
      }
      fields[FIELD.email] = email;
    }
    if (body.phone !== undefined) {
      const typed = (body.phone || "").trim();
      const phone = normalPhone(typed);
      if (typed && !phone) {
        return Response.json(
          { error: "That doesn't look like a US phone number — check it, or leave it blank." },
          { status: 400 },
        );
      }
      // A blank box shouldn't wipe a number already on record, same as Team.
      if (phone) fields[FIELD.phone] = phone;
    }
    // The page sends the palette back through here whenever it changes, so a
    // record written before the customer settled on their colors still ends
    // up with the right ones.
    if (body.colors !== undefined) fields[FIELD.colors] = colorText(body.colors);
    // Sent whenever a kit answer changes. An empty array is a real answer: it
    // clears the field for a customer who said yes and then changed their mind.
    if (body.kit !== undefined) {
      const kit = body.kit ?? [];
      const unknown = kit.filter((k) => !KIT_OPTIONS.includes(k));
      if (unknown.length) console.warn("save-design: dropping unknown Kit", unknown);
      fields[FIELD.kit] = kit.filter((k) => KIT_OPTIONS.includes(k));
    }
    // The roster lives in the browser until this writes it down, so the page
    // sends it on every change. An empty roster is a real answer: it clears
    // the cell for someone who deleted every row.
    if (body.roster !== undefined) {
      const roster = body.roster ?? [];
      fields[FIELD.roster] = rosterText(roster);
      fields[FIELD.rosterCount] = roster.length;
    }
    // Only once there is something to write — a blank box shouldn't wipe a
    // team name already on record.
    if (body.team !== undefined) {
      const team = body.team.trim();
      if (team) fields[FIELD.team] = team.slice(0, 200);
    }

    if (!body.recordId) {
      return Response.json(
        { error: "That design isn't on file yet, so there's nothing to attach to it." },
        { status: 400 },
      );
    }
    if (!Object.keys(fields).length) {
      return Response.json({ error: "Nothing to update" }, { status: 400 });
    }
    return updateRecord(body.recordId, fields);
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

    // Both URLs must be serving before Airtable is told about them.
    await Promise.all(
      [conceptUrl, logoUrl].filter(Boolean).map((u) => waitUntilReadable(u as string)),
    );

    // Airtable fetches these URLs and keeps its own copy, so the attachment
    // survives independently of the blob.
    const fields: Record<string, unknown> = {
      [FIELD.code]: code,
      [FIELD.prompt]: (body.prompt || "").trim().slice(0, 2000),
      [FIELD.variant]: variant,
      [FIELD.colors]: colorText(body.colors),
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
    const id: string | null = created?.id ?? null;

    if (id) {
      const attachments = [{ field: FIELD.concept as string, url: conceptUrl }];
      if (logoUrl) attachments.push({ field: FIELD.logo as string, url: logoUrl });
      await retryAttachments(id, attachments);
    }

    return Response.json({ code, id });
  } catch (err) {
    // Never the customer's problem: the concept is already on their screen.
    console.error("save-design failed", { code, session, err });
    return Response.json({ error: "Couldn't save that design" }, { status: 502 });
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
