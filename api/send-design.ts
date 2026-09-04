/**
 * Sends a customer one link to their gallery, the concept they just saved, and
 * the code that goes with it.
 *
 * One link, not one per design: a gallery collects everything they ever save,
 * so a mail full of individual links goes stale the moment they make another
 * one. The picture is attached so the mail still shows something to somebody
 * who never clicks through.
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
 *   SITE_URL        — optional; where the gallery link points. Falls back to
 *                     the origin the request arrived on, which is right in
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

export type DesignMail = {
  to: string;
  /** The customer's gallery. Already carries its token — see save-design. */
  gallery: string;
  /** The one design shown in the mail: what they saved, or their latest. */
  code: string;
  /** Where that design's picture can be fetched from, to attach it. */
  imageUrl?: string | null;
  /** How many designs the gallery holds, including the one shown. */
  count: number;
  /** Changes the wording, nothing else. */
  reason: "saved" | "lookup";
};

/* One picture, so the mail shows something to somebody who never clicks
   through. It is Airtable's 768px thumbnail rather than the original — see the
   note in save-design's asFiled — and anything bigger than this is dropped
   rather than sent, because the gallery link is what the mail is really for. */
const MAX_BYTES = 4_000_000;

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

async function fetchImage(code: string, url: string): Promise<Attached | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`send-design: concept ${code} came back ${res.status}, sending without it`);
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) {
      console.warn(`send-design: concept ${code} is ${bytes.length} bytes, sending without it`);
      return null;
    }
    const type = res.headers.get("content-type") || "image/png";
    const ext = type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : "png";
    return {
      filename: `jersey-${code}.${ext}`,
      content: bytes.toString("base64"),
      content_id: `design-${code}`,
    };
  } catch (err) {
    console.warn(`send-design: could not fetch concept ${code}, sending without it`, err);
    return null;
  }
}

/** Exported so the mail can be previewed without sending one. */
export function renderDesignMail(mail: DesignMail, art: Attached | null) {
  const others = Math.max(0, mail.count - 1);
  const opening = mail.reason === "lookup"
    ? `Here's your jersey gallery.`
    : `Here's your jersey design.`;
  const rest = others === 0
    ? `Your gallery keeps every design you save with us, so it will fill up as you go.`
    : others === 1
      ? `There's one more design in your gallery.`
      : `There are ${others} more designs in your gallery.`;

  const text = [
    opening,
    ``,
    `Design code ${mail.code}${art ? ` — the concept is attached.` : ``}`,
    ``,
    rest,
    `See them all, any time: ${mail.gallery}`,
    ``,
    `Keep this link. It is the way back to your designs — anyone who has it can`,
    `see them, so treat it like a private link rather than a password.`,
    ``,
    `Nothing is ordered yet.`,
    ``,
    `Marty's Jerseys`,
  ].join("\n");

  const picture = art
    ? `<tr><td style="padding:20px 28px 0">
        <img src="cid:${art.content_id}" width="464" alt="Your jersey concept" style="display:block;width:100%;max-width:464px;height:auto;border-radius:10px;background:#eceef1">
      </td></tr>`
    : "";

  /* Inline styles and tables, because that is what mail clients render. No web
     fonts, no external stylesheet, nothing that needs loading. */
  const html = `<div style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e3e5e9">
    <tr><td style="padding:28px 28px 0">
      <h1 style="margin:0 0 6px;font-size:19px;line-height:1.3;color:#14161a">${escape(opening)}</h1>
      <p style="margin:0;font-size:15px;line-height:1.5;color:#5b6270">Nothing is ordered yet — this is just so you don't lose it.</p>
    </td></tr>
    ${picture}
    <tr><td style="padding:16px 28px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;border-radius:10px">
        <tr><td style="padding:14px 18px;text-align:center">
          <div style="font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#5b6270">Design code</div>
          <div style="font-size:28px;letter-spacing:.15em;font-weight:700;color:#14161a;padding-top:3px">${escape(mail.code)}</div>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:18px 28px 0">
      <a href="${escape(mail.gallery)}" style="display:block;background:#e4652a;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;text-align:center;padding:13px 20px;border-radius:9px">${others ? "See all your designs" : "Open your gallery"}</a>
    </td></tr>
    <tr><td style="padding:14px 28px 26px">
      <p style="margin:0;font-size:14px;line-height:1.55;color:#5b6270">${escape(rest)}</p>
      <p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:#8b929e">
        Keep this link — it is the way back to your designs. Anyone who has it can see them,
        so treat it like a private link rather than a password.
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
  const began = Date.now();
  const art = mail.imageUrl ? await fetchImage(mail.code, mail.imageUrl) : null;
  const { text, html } = renderDesignMail(mail, art);

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
        subject: mail.count > 1
          ? `Your jersey designs — ${mail.count} saved`
          : `Your jersey design — code ${mail.code}`,
        text,
        html,
        attachments: art ? [art] : undefined,
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
          `code=${mail.code} :: ${message}`,
      );
      return { ok: false, status: res.status, message };
    }

    const sent = await res.json().catch(() => null);
    console.log(
      `send-design OK ${took}s to=${mail.to} reason=${mail.reason} ` +
        `code=${mail.code} gallery=${mail.count} attached=${art ? "yes" : "no"} id=${sent?.id ?? "-"}`,
    );
    return { ok: true };
  } catch (err) {
    const message = String((err as Error)?.message ?? err).replace(/\s+/g, " ").trim();
    console.error(
      `send-design FAIL status=- ${((Date.now() - began) / 1000).toFixed(1)}s ` +
        `to=${mail.to} code=${mail.code} :: ${message}`,
    );
    return { ok: false, status: null, message };
  }
}
