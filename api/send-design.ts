/**
 * Sends a customer their own copy of a design: the four-character code, the
 * concept image, and a link that reopens it on the page.
 *
 * Triggered from save-design, when a save carries an email address — which is
 * the moment the customer asked for it, by typing an address into "Don't lose
 * this design" and pressing the button. Nothing else sends mail, and nothing
 * sends unprompted.
 *
 * Best-effort, deliberately: the address and the design are on record before
 * this runs, so a provider outage costs the customer an email and never their
 * design or their place in the flow. The save reports whether the mail went,
 * and the page says only what actually happened.
 *
 * No SDK. This is one POST with a JSON body, and the repo already avoids
 * dependencies it can do without in a serverless function.
 *
 * Env vars required:
 *   RESEND_API_KEY  — https://resend.com/api-keys
 *   SITE_URL        — optional; where the reopen link points. Falls back to the
 *                     origin the save request arrived on, which is right in
 *                     every case except a proxy that rewrites Host.
 */

const ENDPOINT = "https://api.resend.com/emails";

/* The domain has to be verified in Resend or every send is refused. The display
   name is the one the page uses on its own images; the address is fixed. */
const FROM = "Marty's Jerseys <noreply@send.lampertsusa.com>";

/* Nothing is set here on purpose. A reply-to has to be a mailbox somebody
   actually reads, and inventing one sends customer replies into a hole. Set
   REPLY_TO_EMAIL when there is a real inbox for it; until then replies bounce
   off noreply@, which at least tells the customer it did not arrive. */
const REPLY_TO = process.env.REPLY_TO_EMAIL || null;

export type Sent = { ok: true } | { ok: false; status: number | null; message: string };

export type Design = {
  code: string;
  /** Where the concept image can be fetched from, to attach it. */
  imageUrl?: string | null;
};

export type DesignMail = {
  to: string;
  /** Newest first. One session's worth, or everything under an address. */
  designs: Design[];
  /** Origin for the reopen link; SITE_URL wins when it is set. */
  origin?: string | null;
  /** Changes the opening line, nothing else. */
  reason: "saved" | "lookup";
};

/* Thumbnails, not originals — see the note in save-design's asFiled. Even so
   there is a ceiling: Resend caps a message at 40MB, plenty of mail servers
   refuse at 10, and base64 adds a third on top of whatever these weigh.
   Anything past the cap still gets its code and its link, just not its picture. */
const MAX_IMAGES = 8;
const MAX_BYTES = 6_000_000;

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The concepts, as bytes, so they travel with the mail.
 *
 * Linking them instead would be less work and would rot: Airtable's attachment
 * URLs expire within hours, and a customer who opens this next week would find
 * broken images where their jerseys were. Anything that cannot be fetched is
 * skipped — the codes and the links are what the mail is for.
 *
 * Each one carries a content id so the body can show it inline. A client that
 * ignores that still receives it as an ordinary attachment, which is a duller
 * email rather than a broken one.
 */
type Attached = { filename: string; content: string; content_id: string };

async function fetchImages(designs: Design[]): Promise<Map<string, Attached>> {
  const got = new Map<string, Attached>();
  let budget = MAX_BYTES;

  for (const design of designs) {
    if (!design.imageUrl || got.size >= MAX_IMAGES) continue;
    try {
      const res = await fetch(design.imageUrl);
      if (!res.ok) {
        console.warn(`send-design: concept ${design.code} came back ${res.status}, sending without it`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > budget) {
        console.warn(`send-design: no room left for concept ${design.code}, sending without it`);
        continue;
      }
      budget -= bytes.length;
      const type = res.headers.get("content-type") || "image/png";
      const ext = type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : "png";
      got.set(design.code, {
        filename: `jersey-${design.code}.${ext}`,
        content: bytes.toString("base64"),
        content_id: `design-${design.code}`,
      });
    } catch (err) {
      console.warn(`send-design: could not fetch concept ${design.code}, sending without it`, err);
    }
  }
  return got;
}

/** Exported so the mail can be previewed without sending one. */
export function renderDesignMail(
  designs: Design[],
  link: (code: string) => string,
  inline: Map<string, Attached>,
  reason: DesignMail["reason"],
) {
  const many = designs.length > 1;
  const opening = reason === "lookup"
    ? many
      ? `Here are the ${designs.length} designs saved under this address.`
      : `Here's the design saved under this address.`
    : many
      ? `Here are your ${designs.length} jersey designs.`
      : `Here's your jersey design.`;

  const text = [
    opening,
    ``,
    ...designs.flatMap((d) => [`${d.code} — ${link(d.code)}`]),
    ``,
    inline.size ? `The concepts are attached.` : ``,
    `Quote a code to us and we'll pull that design straight up. Nothing is`,
    `ordered yet — this is just so you don't lose them.`,
    ``,
    `Marty's Jerseys`,
  ].join("\n");

  /* Inline styles and tables, because that is what mail clients render. No web
     fonts, no external stylesheet, nothing that needs loading. */
  const rows = designs
    .map((d) => {
      const art = inline.get(d.code);
      const picture = art
        ? `<img src="cid:${art.content_id}" width="150" alt="Jersey design ${escape(d.code)}" style="display:block;width:150px;max-width:150px;height:auto;border-radius:8px;background:#eceef1">`
        : `<div style="width:150px;height:100px;border-radius:8px;background:#eceef1"></div>`;
      return `<tr><td style="padding:0 0 14px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;border-radius:10px">
          <tr>
            <td width="166" style="padding:14px 0 14px 14px;vertical-align:middle">${picture}</td>
            <td style="padding:14px;vertical-align:middle">
              <div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#5b6270">Design code</div>
              <div style="font-size:25px;letter-spacing:.14em;font-weight:700;color:#14161a;padding:2px 0 8px">${escape(d.code)}</div>
              <a href="${escape(link(d.code))}" style="font-size:14px;font-weight:600;color:#c4541f;text-decoration:none">Open this design &rarr;</a>
            </td>
          </tr>
        </table>
      </td></tr>`;
    })
    .join("");

  const html = `<div style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e3e5e9">
    <tr><td style="padding:28px 28px 18px">
      <h1 style="margin:0 0 6px;font-size:19px;line-height:1.3;color:#14161a">${escape(opening)}</h1>
      <p style="margin:0;font-size:15px;line-height:1.5;color:#5b6270">Nothing is ordered yet — this is just so you don't lose ${many ? "them" : "it"}.</p>
    </td></tr>
    <tr><td style="padding:0 28px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table>
    </td></tr>
    <tr><td style="padding:6px 28px 26px">
      <p style="margin:0;font-size:14px;line-height:1.55;color:#5b6270">
        Quote a code to us any time and we'll pull that design straight up.
      </p>
    </td></tr>
  </table>
</div>`;

  return { text, html };
}

/**
 * Sends one mail covering every design it is given. Never throws: the caller has
 * already saved everything that matters and a failed send must not undo that.
 */
export async function sendDesign(mail: DesignMail): Promise<Sent> {
  if (!process.env.RESEND_API_KEY) {
    console.error("send-design: RESEND_API_KEY is not set, no mail sent");
    return { ok: false, status: null, message: "RESEND_API_KEY is not set" };
  }
  if (!mail.designs.length) {
    return { ok: false, status: null, message: "no designs to send" };
  }

  const base = (process.env.SITE_URL || mail.origin || "").replace(/\/+$/, "");
  const link = (code: string) => `${base}/?d=${encodeURIComponent(code)}`;
  const began = Date.now();

  const inline = await fetchImages(mail.designs);
  const { text, html } = renderDesignMail(mail.designs, link, inline, mail.reason);
  const codes = mail.designs.map((d) => d.code);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [mail.to],
        ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
        subject: codes.length > 1
          ? `Your jersey designs — ${codes.length} saved`
          : `Your jersey design — code ${codes[0]}`,
        text,
        html,
        attachments: inline.size ? [...inline.values()] : undefined,
      }),
    });

    const took = ((Date.now() - began) / 1000).toFixed(1);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      let message = detail.slice(0, 300);
      try {
        const parsed = JSON.parse(detail);
        message = parsed?.message ?? parsed?.error?.message ?? message;
      } catch {
        // Not JSON.
      }
      message = message.replace(/\s+/g, " ").trim();
      console.error(
        `send-design FAIL status=${res.status} ${took}s to=${mail.to} ` +
          `codes=${codes.join("|")} :: ${message}`,
      );
      return { ok: false, status: res.status, message };
    }

    const sent = await res.json().catch(() => null);
    console.log(
      `send-design OK ${took}s to=${mail.to} reason=${mail.reason} ` +
        `codes=${codes.join("|")} images=${inline.size}/${codes.length} id=${sent?.id ?? "-"}`,
    );
    return { ok: true };
  } catch (err) {
    const message = String((err as Error)?.message ?? err).replace(/\s+/g, " ").trim();
    console.error(
      `send-design FAIL status=- ${((Date.now() - began) / 1000).toFixed(1)}s ` +
        `to=${mail.to} codes=${codes.join("|")} :: ${message}`,
    );
    return { ok: false, status: null, message };
  }
}
