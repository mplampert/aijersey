import { list, put } from "@vercel/blob";
// Compiled output is .js, and the runtime resolves this specifier verbatim.
import { sendDesign } from "../lib/send-design.js";
import { upsertContact } from "../lib/ghl-contact.js";

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
 *   GHL_API_TOKEN          — optional; the CRM row. See ghl-contact.
 *   GHL_LOCATION_ID        — optional; the sub-account the contact belongs to
 */

// Written by field id, not name, so renaming a column in Airtable can't break
// the write. Do not add fields here without creating them in the base first.
export const FIELD = {
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
  gallery: "fldoNMDzarxLKYkwB",
  // The proof half of the base, which nothing wrote to until the order flow
  // did. Proof status is the gate on payment: see approve-proof.
  proofStatus: "fldm6oKZZ53gG6oyY",
  proofApproved: "fldYlfYHss8B5NPuB",
  // Payment. Nothing here is touched at the concept stage — an order is filed
  // Unpaid and only becomes payable once the customer approves the proof.
  payment: "fldiY2sQh2pdYItaP",
  stripeSession: "fldlnkDSvtzx5rAQ8",
  orderTotal: "fldVvSiVh1WvggEQ4",
} as const;

/* The single-select values this code writes, by name. Airtable matches them
   with typecast, and typecast will happily invent an option for a typo, so
   they are named once here rather than spelled out at each call site. */
export const STATUS_ORDERED = "Ordered";
export const PROOF_APPROVED = "Approved";
export const PAY_UNPAID = "Unpaid";
export const PAY_LINK_SENT = "Link sent";
export const PAY_PAID = "Paid";

// Style and Status are single selects. typecast lets Airtable match a plain
// string to an option, but it will also invent a new option for anything else,
// so Style is written only when it is one of the three the base offers.
const STYLE_OPTIONS = ["Laced collar", "V-neck", "Crew"];
const STATUS_ON_SAVE = "Concept";

/* Kit items (fldsqik6ZInUTnwKM) is a multiple select, and the patch below sends
   typecast, which would invent an option for anything the base doesn't already
   offer. These three are what it offers, and they match CFG.kit on the page.

   The base also has a second multiple select called Kit (fldfrtitFh7Xb4van)
   with different options — Matching socks, Pant shells, Practice jerseys,
   Player bags — that nothing writes to and that has no data in any of the 113
   records. It is a leftover. Delete it in Airtable rather than leaving two
   fields for one purpose; this file has never referred to it. */
const KIT_OPTIONS = ["Socks", "Skate soakers", "Player bags"];

// Uppercase, with the glyphs people misread removed: no I or 1, no O or 0.
// 32 characters, and 256 divides by 32, so the bytes below map without bias.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;

function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length]).join("");
}

/* The gallery id, which is not the code and is not meant to be read out loud.
 *
 * It has to be unguessable, because the whole point of it is that the URL is not
 * the email address: /designs?t=<address> would let anyone type in somebody's
 * address and read their designs. 128 random bits, base64url, same unlisted-link
 * model as Share id on the Proofs table.
 */
function makeGalleryId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

// filterByFormula matches on the field's name, not its id, and Code is the
// primary field. Same lookup get-design uses.
const CODE_FIELD_NAME = "Code";
const SESSION_FIELD_NAME = "Session";
const EMAIL_FIELD_NAME = "Email";
const GALLERY_FIELD_NAME = "Gallery id";
export const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export type Body = {
  /* Either identifier reaches the same row. recordId is the one the page is
     handed when a design is filed; code is the one the customer can read off
     their own screen, which is the one that survives a reload, a shared link,
     and a page that lost its record id — and every design that has a code has
     a row, because the code is minted when the row is written. */
  recordId?: string;
  code?: string;
  email?: string;
  /* The person, as opposed to the team. Goes to the CRM as their first and
     last name and nowhere else — the Designs table has no column for it. */
  name?: string;
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
export const rosterText = (roster: Body["roster"]) =>
  (roster ?? [])
    .map((p) =>
      [p.num, p.name, p.size, p.sock, p.goalie ? "G" : ""]
        .map((v) => String(v ?? "").trim() || "-")
        .join(", "),
    )
    .join("\n")
    .slice(0, ROSTER_LIMIT);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Which step of a save went wrong, and what the service said about it.
 *
 * A save crosses two services — the blob store, then Airtable — and until now
 * every way of failing arrived at one catch and one line reading "save-design
 * failed" with a raw error object after it. Blob refusing the write, Airtable
 * refusing a field id, and the whole thing being unconfigured were
 * indistinguishable from the outside, and the page threw the response away
 * without reading it, so nothing reached any console at all. */
type Step = "config" | "blob:concept" | "blob:logo" | "airtable:create" | "airtable:patch" | "airtable:read";
export type Snag = { step: Step; status: number | null; code: string | null; message: string };

/** Airtable answers with { error: { type, message } }; blob and fetch do not. */
async function readSnag(step: Step, res: Response): Promise<Snag> {
  const body = await res.text().catch(() => "");
  let code: string | null = null;
  let message = body.slice(0, 400);
  try {
    const parsed = JSON.parse(body);
    const e = parsed?.error;
    if (typeof e === "string") { code = e; }
    else if (e) { code = e.type ?? null; message = e.message ?? message; }
  } catch {
    // Not JSON — an HTML error page or a proxy's plain text.
  }
  return { step, status: res.status, code, message: message.replace(/\s+/g, " ").trim() };
}

function snagFrom(step: Step, err: unknown): Snag {
  const e = err as any;
  return {
    step,
    status: typeof e?.status === "number" ? e.status : null,
    // @vercel/blob throws BlobAccessError and friends; the name is the useful bit.
    code: typeof e?.name === "string" && e.name !== "Error" ? e.name : null,
    message: String(e?.message ?? err).replace(/\s+/g, " ").trim().slice(0, 400),
  };
}

/** One line per failure, the same shape generate-concept logs. */
function report(snag: Snag, ms: number, note = "") {
  console.error(
    [
      `save-design FAIL ${snag.step}`,
      `status=${snag.status ?? "-"}`,
      `${(ms / 1000).toFixed(1)}s`,
      snag.code ? `code=${snag.code}` : "",
      note,
      `:: ${snag.message}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

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
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Loose on the way in, strict on the way out. Everything but the digits is
 * thrown away, a leading country 1 is dropped, and what is left has to be a
 * dialable NANP number — area code and exchange can't start with 0 or 1 — or
 * it is refused. A number nobody can text is worse than an empty field.
 */
export function normalPhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

function unconfigured(keys: string[]): Response | null {
  const missing = keys.filter((k) => !process.env[k]);
  if (!missing.length) return null;
  const snag: Snag = {
    step: "config",
    status: 503,
    code: "missing-env",
    message: `not set: ${missing.join(", ")}`,
  };
  report(snag, 0);
  return Response.json({ error: "Design saving isn't configured", detail: snag }, { status: 503 });
}

export const table = () =>
  `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`;

export const airtableHeaders = () => ({
  Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
  "Content-Type": "application/json",
});

/**
 * Finds the row a four-character code belongs to. Returns null when there is no
 * such row, which is a real answer and not an error: a code the page is holding
 * from a design that was never filed has nothing to attach to.
 */
export async function findByCode(code: string): Promise<{ id: string | null; snag: Snag | null }> {
  const began = Date.now();
  // The code is matched against CODE before it gets here, so only the 32 safe
  // glyphs ever reach the formula — there is nothing to quote-escape out of.
  const query = new URLSearchParams({
    filterByFormula: `{${CODE_FIELD_NAME}}="${code}"`,
    maxRecords: "1",
  });
  const res = await fetch(`${table()}?${query}`, { headers: airtableHeaders() });
  if (!res.ok) {
    const snag = await readSnag("airtable:read", res);
    report(snag, Date.now() - began, `code=${code}`);
    return { id: null, snag };
  }
  const found = await res.json().catch(() => null);
  return { id: found?.records?.[0]?.id ?? null, snag: null };
}

export type Filed = {
  id: string;
  code: string;
  imageUrl: string | null;
  session: string | null;
  gallery: string | null;
  created: string | null;
  variant: string | null;
};

const asFiled = (rec: any): Filed | null => {
  const code = rec?.fields?.[FIELD.code];
  if (!rec?.id || !code) return null;
  const concept = rec.fields[FIELD.concept];
  const file = Array.isArray(concept) ? concept[0] : null;
  return {
    id: rec.id,
    code,
    /* Airtable's own 768px thumbnail, not the original. A concept is two and a
       half megabytes and a session is three of them; at full size one email
       would be eight megabytes of attachments to show three pictures the width
       of a phone. The large thumbnail is a tenth of that and larger than it
       will ever be displayed. Both URLs expire, which is why the bytes are
       fetched at send time rather than linked. */
    imageUrl: file?.thumbnails?.large?.url ?? file?.url ?? null,
    session: rec.fields[FIELD.session] ?? null,
    gallery: rec.fields[FIELD.gallery] ?? null,
    created: rec.fields[FIELD.created] ?? rec.createdTime ?? null,
    variant: rec.fields[FIELD.variant] ?? null,
  };
};

/** One row, by id. */
async function readDesign(recordId: string): Promise<Filed | null> {
  try {
    const query = new URLSearchParams({ returnFieldsByFieldId: "true" });
    const res = await fetch(`${table()}/${encodeURIComponent(recordId)}?${query}`, {
      headers: airtableHeaders(),
    });
    if (!res.ok) {
      report(await readSnag("airtable:read", res), 0, `record=${recordId}`);
      return null;
    }
    return asFiled(await res.json());
  } catch (err) {
    report(snagFrom("airtable:read", err), 0, `record=${recordId}`);
    return null;
  }
}

/**
 * The concept's own blob URL — the one URL for that picture that doesn't rot.
 *
 * The obvious candidate is Filed.imageUrl, and it is the wrong one: that is
 * Airtable's attachment URL, handed out live because Airtable expires it within
 * hours. It is right for an email that fetches the bytes and attaches them at
 * send time, which is what send-design does, and wrong for anything that stores
 * a link and renders it later. Written into a CRM it would show the customer
 * their jersey this afternoon and a broken image every day after.
 *
 * The blob is the original upload, is public, and stays where save put it. Its
 * pathname is `designs/<session>/<code>-concept-<suffix>`, so the record's own
 * session and code find it — nothing had to be stored to make this work, which
 * is why designs filed before any of this existed resolve too.
 *
 * Best-effort, like everything else this feeds: a picture that can't be found
 * is one field left empty on a contact, and is never worth failing a save over.
 */
async function conceptBlobUrl(design: Filed | null): Promise<string | null> {
  if (!design?.session || !design.code) return null;
  const prefix = `designs/${design.session}/${design.code}-concept`;
  try {
    /* One code is minted per row, so in practice this is one blob. Asking for a
       few and taking the newest costs nothing and settles the tie the same way
       every time, rather than however the store happens to order them. */
    const { blobs } = await list({ prefix, limit: 10 });
    const newest = blobs
      .slice()
      .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0];
    if (!newest) {
      console.warn(`save-design: no concept blob under ${prefix}`);
      return null;
    }
    return newest.url;
  } catch (err) {
    report(snagFrom("blob:concept", err), 0, `prefix=${prefix}`);
    return null;
  }
}

/**
 * Every design filed under one session, newest first.
 *
 * A customer generates three takes at a time and picks one to save, but all
 * three are theirs and all three are on file. Sending back only the selected
 * one throws the other two away at exactly the moment they asked not to lose
 * anything.
 */
export async function readSession(session: string): Promise<Filed[]> {
  try {
    const query = new URLSearchParams({
      // Session is a plain text field the page generates as a UUID, so there is
      // nothing in it to quote-escape out of. Guarded anyway.
      filterByFormula: `{${SESSION_FIELD_NAME}}="${session.replace(/["\\]/g, "")}"`,
      returnFieldsByFieldId: "true",
      maxRecords: "20",
      "sort[0][field]": FIELD.created,
      "sort[0][direction]": "desc",
    });
    const res = await fetch(`${table()}?${query}`, { headers: airtableHeaders() });
    if (!res.ok) {
      report(await readSnag("airtable:read", res), 0, `session=${session}`);
      return [];
    }
    const found = await res.json();
    return (found?.records ?? []).map(asFiled).filter(Boolean) as Filed[];
  } catch (err) {
    report(snagFrom("airtable:read", err), 0, `session=${session}`);
    return [];
  }
}

/**
 * Every design filed under one address, newest first. Used by the lookup, which
 * is the only thing that has ever read the Email column.
 *
 * Matched case-insensitively, because somebody who saved as Captain@… and comes
 * back as captain@… is the same person and should not be told there is nothing
 * on file.
 */
export async function findByEmail(email: string): Promise<Filed[]> {
  try {
    const query = new URLSearchParams({
      // The caller has already refused quotes and backslashes in the address.
      filterByFormula: `LOWER({${EMAIL_FIELD_NAME}})="${email.toLowerCase().replace(/["\\]/g, "")}"`,
      returnFieldsByFieldId: "true",
      maxRecords: "30",
      "sort[0][field]": FIELD.created,
      "sort[0][direction]": "desc",
    });
    const res = await fetch(`${table()}?${query}`, { headers: airtableHeaders() });
    if (!res.ok) {
      report(await readSnag("airtable:read", res), 0, "lookup by email");
      return [];
    }
    const found = await res.json();
    return (found?.records ?? []).map(asFiled).filter(Boolean) as Filed[];
  } catch (err) {
    report(snagFrom("airtable:read", err), 0, "lookup by email");
    return [];
  }
}

/**
 * The gallery id already in use for an address, or null if it has never been
 * given one. Reused rather than reminted, so a customer's link keeps working
 * and every design they save lands in the same gallery.
 */
export async function galleryFor(email: string): Promise<string | null> {
  const found = await findByEmail(email);
  return found.find((d) => d.gallery)?.gallery ?? null;
}

/** Mints a gallery id and writes it across the rows given. Returns the id. */
export async function patchGallery(ids: string[]): Promise<string> {
  const token = makeGalleryId();
  await patchMany(ids, { [FIELD.gallery]: token });
  return token;
}

/** Every design behind one gallery id. This is what the gallery page reads. */
export async function readGallery(token: string): Promise<Filed[]> {
  try {
    const query = new URLSearchParams({
      // Base64url, so letters, digits, hyphen and underscore — nothing that
      // means anything inside an Airtable formula. Stripped anyway.
      filterByFormula: `{${GALLERY_FIELD_NAME}}="${token.replace(/[^A-Za-z0-9_-]/g, "")}"`,
      returnFieldsByFieldId: "true",
      maxRecords: "60",
      "sort[0][field]": FIELD.created,
      "sort[0][direction]": "desc",
    });
    const res = await fetch(`${table()}?${query}`, { headers: airtableHeaders() });
    if (!res.ok) {
      report(await readSnag("airtable:read", res), 0, "gallery");
      return [];
    }
    const found = await res.json();
    return (found?.records ?? []).map(asFiled).filter(Boolean) as Filed[];
  } catch (err) {
    report(snagFrom("airtable:read", err), 0, "gallery");
    return [];
  }
}

/**
 * Writes the same fields onto several rows at once. Airtable takes ten per
 * request, and a session is three, so this is one call in practice.
 *
 * The address goes on every design in the session, not just the one that was
 * on screen when it was typed. Otherwise looking a customer up by their address
 * later finds one of their three designs and silently loses the rest.
 */
async function patchMany(ids: string[], fields: Record<string, unknown>): Promise<number> {
  let written = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    try {
      const res = await fetch(table(), {
        method: "PATCH",
        headers: airtableHeaders(),
        body: JSON.stringify({
          records: batch.map((id) => ({ id, fields })),
          typecast: true,
        }),
      });
      if (!res.ok) {
        report(await readSnag("airtable:patch", res), 0, `records=${batch.length}`);
        continue;
      }
      written += batch.length;
    } catch (err) {
      report(snagFrom("airtable:patch", err), 0, `records=${batch.length}`);
    }
  }
  return written;
}

/**
 * Updates a design already on file. Patches that one row — the design was saved
 * the moment it was drawn, so creating a second row here would split one design
 * across two, which is how Email and Team end up on a record nobody looks at.
 */
async function updateRecord(
  who: { recordId?: string; code?: string },
  fields: Record<string, unknown>,
  /* Set only when the customer has just handed over an address, which is the
     one thing that sends mail. Everything else that patches this row — colours,
     kit, roster — passes nothing here and sends nothing.

     The name rides here rather than in `fields` beside the phone and the team,
     because those two are Airtable columns and this is not one: it exists to
     name the contact in the CRM, and there is nowhere on the Designs table to
     put it. Add a column and it can be written like the rest. */
  mail?: { email: string; name: string | null; origin: string | null },
): Promise<Response> {
  const notReady = unconfigured([
    "AIRTABLE_TOKEN",
    "AIRTABLE_BASE_ID",
    "AIRTABLE_TABLE_ID",
  ]);
  if (notReady) return notReady;

  const began = Date.now();
  try {
    /* Prefer the record id when the page still has one, and fall back to the
       code. The code is what the customer can see, so it is the identifier that
       survives a reload or a shared link — and a page that lost its record id
       is exactly the case that used to fail with nothing written down. */
    let recordId = who.recordId ?? null;
    if (!recordId && who.code) {
      const { id, snag } = await findByCode(who.code);
      if (snag) {
        return Response.json(
          { error: "We couldn't reach the design file just now", detail: snag },
          { status: 502 },
        );
      }
      if (!id) {
        const missing: Snag = {
          step: "airtable:read",
          status: 404,
          code: "no-such-code",
          message: `no design on file with code ${who.code}`,
        };
        report(missing, Date.now() - began);
        return Response.json(
          { error: `We couldn't find design ${who.code} on file.`, detail: missing },
          { status: 404 },
        );
      }
      recordId = id;
      console.log(`save-design: matched code ${who.code} to ${recordId}`);
    }
    if (!recordId) {
      const missing: Snag = {
        step: "airtable:patch",
        status: 400,
        code: "no-identifier",
        message: "neither a record id nor a code was sent",
      };
      report(missing, 0);
      return Response.json(
        { error: "That design isn't on file yet, so there's nothing to attach to it.", detail: missing },
        { status: 400 },
      );
    }

    const res = await fetch(`${table()}/${encodeURIComponent(recordId)}`, {
      method: "PATCH",
      headers: airtableHeaders(),
      // typecast is what lets Kit items accept plain option names.
      body: JSON.stringify({ fields, typecast: true }),
    });

    if (!res.ok) {
      const snag = await readSnag("airtable:patch", res);
      report(snag, Date.now() - began, `record=${recordId} fields=${Object.keys(fields).join("|")}`);
      return Response.json(
        { error: "We couldn't save that against your design", detail: snag },
        { status: 502 },
      );
    }
    console.log(
      `save-design OK patch ${recordId} ${((Date.now() - began) / 1000).toFixed(1)}s ` +
      `fields=${Object.keys(fields).join("|")}`,
    );

    /* The copy the customer asked for. Sent after the write, never before: the
       design and the address are on record either way, so a provider outage
       costs an email and nothing else. The page is told whether it went so it
       can say what actually happened rather than promising mail. */
    let emailed = false;
    let gallery: string | null = null;
    if (mail) {
      const saved = await readDesign(recordId);

      /* One gallery per address, for as long as the address exists. Minted the
         first time and reused after, so a link that has been emailed once keeps
         working and everything later joins the same gallery. */
      const token = (await galleryFor(mail.email)) ?? makeGalleryId();

      /* Stamped across the whole visit, not just the design that was on screen.
         A customer generates three takes and saves one; all three are theirs and
         all three belong in the gallery. Anything generated before the address
         was typed in an earlier visit has no address on it and stays out — the
         gallery starts here and fills up from here. */
      const session = saved?.session ?? null;
      const mine = session ? await readSession(session) : saved ? [saved] : [];
      const stamped = await patchMany(mine.map((d) => d.id), {
        [FIELD.email]: mail.email,
        [FIELD.gallery]: token,
      });
      console.log(
        `save-design: gallery ${token} now covers ${stamped} design(s) from session ${session}`,
      );

      const all = await readGallery(token);
      const shown = all.find((d) => d.id === recordId) ?? saved ?? all[0] ?? null;
      gallery = galleryUrl(token, mail.origin);

      if (!shown) {
        console.error(`save-design: nothing readable on ${recordId}, cannot send a copy`);
      } else {
        const sent = await sendDesign({
          to: mail.email,
          gallery,
          code: shown.code,
          imageUrl: shown.imageUrl,
          count: all.length || 1,
          reason: "saved",
        });
        emailed = sent.ok;
      }

      /* The CRM row for this lead, after the mail rather than before it. It is
         the least time-critical thing a save does and the customer is waiting
         on the response, so it goes last; it reports its own failures and
         returns rather than throwing, because a save must not fail — and a
         customer must not lose their email — over a CRM that is down. */
      await upsertContact({
        email: mail.email,
        // Whatever this save carried, and nothing it didn't: a save that
        // changed only the address sends none of these, and the contact keeps
        // the values already on it.
        name: mail.name,
        phone: (fields[FIELD.phone] as string | undefined) ?? null,
        team: (fields[FIELD.team] as string | undefined) ?? null,
        code: shown?.code ?? null,
        gallery,
        // The blob, not the attachment URL beside it in `shown`. See above.
        image: await conceptBlobUrl(shown),
      });
    }
    return Response.json({ ok: true, emailed, gallery });

  } catch (err) {
    const snag = snagFrom("airtable:patch", err);
    report(snag, Date.now() - began, `record=${who.recordId ?? "-"} code=${who.code ?? "-"}`);
    return Response.json(
      { error: "We couldn't save that against your design", detail: snag },
      { status: 502 },
    );
  }
}

/** The customer's gallery, by token. Never by address — see makeGalleryId. */
export function galleryUrl(token: string, origin: string | null): string {
  const base = (process.env.SITE_URL || origin || "").replace(/\/+$/, "");
  return `${base}/designs/?t=${encodeURIComponent(token)}`;
}

/* Where a link should point. SITE_URL wins when it is set; this is the
   fallback, and it is right unless a proxy rewrites the host. */
function originOf(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  /* An address or a palette arriving with an identifier belongs to a design
     already on file, so it patches that row rather than opening a new one.
     Logged before anything else, because "nothing to attach your address to"
     is answered by knowing what the page actually had in hand. */
  if (body.email !== undefined || body.recordId || body.code) {
    console.log(
      `save-design PATCH recordId=${body.recordId ?? "-"} code=${body.code ?? "-"} ` +
      `fields=${Object.keys(body).filter((k) => k !== "recordId" && k !== "code").join("|") || "-"}`,
    );
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

    const code = (body.code || "").trim().toUpperCase();
    if (code && !CODE.test(code)) {
      return Response.json({ error: "That design code doesn't look right." }, { status: 400 });
    }
    if (!body.recordId && !code) {
      const missing: Snag = {
        step: "airtable:patch",
        status: 400,
        code: "no-identifier",
        message: "the page sent neither a record id nor a design code",
      };
      report(missing, 0);
      return Response.json(
        { error: "That design isn't on file yet, so there's nothing to attach to it.", detail: missing },
        { status: 400 },
      );
    }
    if (!Object.keys(fields).length) {
      return Response.json({ error: "Nothing to update" }, { status: 400 });
    }
    /* Mail only when this save is the one carrying the address. A palette or a
       roster arriving later patches the same row and must not re-send. */
    const sending = body.email !== undefined && typeof fields[FIELD.email] === "string"
      ? {
          email: fields[FIELD.email] as string,
          // Trimmed and capped, never refused: a save must not fail over the
          // shape of somebody's name, and an empty one is a contact without it.
          name: (body.name || "").trim().slice(0, 100) || null,
          origin: originOf(request),
        }
      : undefined;
    return updateRecord({ recordId: body.recordId, code: code || undefined }, fields, sending);
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

/**
 * The record a request means, by whichever identifier it sent.
 *
 * Shared with the order and payment endpoints, which face the same problem
 * updateRecord does: the page holds a record id until it doesn't, and the code
 * is the identifier that survives a reload, a shared link and a mail. Returns
 * null when there is no such row, which is a real answer.
 */
export async function recordIdFor(who: { recordId?: string; code?: string }): Promise<string | null> {
  if (who.recordId) return who.recordId;
  const code = (who.code || "").trim().toUpperCase();
  if (!CODE.test(code)) return null;
  const { id } = await findByCode(code);
  return id;
}

/** One row, every field, by field id. The order endpoints price from this. */
export async function readFields(recordId: string): Promise<Record<string, any> | null> {
  try {
    const query = new URLSearchParams({ returnFieldsByFieldId: "true" });
    const res = await fetch(`${table()}/${encodeURIComponent(recordId)}?${query}`, {
      headers: airtableHeaders(),
    });
    if (!res.ok) {
      report(await readSnag("airtable:read", res), 0, `record=${recordId}`);
      return null;
    }
    return (await res.json())?.fields ?? null;
  } catch (err) {
    report(snagFrom("airtable:read", err), 0, `record=${recordId}`);
    return null;
  }
}

/** Writes fields onto one row. Returns the snag rather than a Response. */
export async function patchFields(
  recordId: string,
  fields: Record<string, unknown>,
): Promise<Snag | null> {
  try {
    const res = await fetch(`${table()}/${encodeURIComponent(recordId)}`, {
      method: "PATCH",
      headers: airtableHeaders(),
      body: JSON.stringify({ fields, typecast: true }),
    });
    if (!res.ok) {
      const snag = await readSnag("airtable:patch", res);
      report(snag, 0, `record=${recordId} fields=${Object.keys(fields).join("|")}`);
      return snag;
    }
    console.log(`save-design OK patch ${recordId} fields=${Object.keys(fields).join("|")}`);
    return null;
  } catch (err) {
    const snag = snagFrom("airtable:patch", err);
    report(snag, 0, `record=${recordId}`);
    return snag;
  }
}
