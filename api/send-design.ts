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

export type DesignMail = {
  to: string;
  code: string;
  /** Where the concept image can be fetched from, to attach it. */
  imageUrl?: string | null;
  /** Origin for the reopen link; SITE_URL wins when it is set. */
  origin?: string | null;
};

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The concept, as bytes, so it travels with the mail.
 *
 * Linking it instead would be less work and would rot: Airtable's attachment
 * URLs expire within hours, and a customer who opens this next week would find
 * a broken image where their jersey was. Anything that cannot be fetched is
 * skipped — the code and the link are what the mail is for.
 */
async function fetchImage(url: string): Promise<{ filename: string; content: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`send-design: concept image ${res.status}, sending without it`);
      return null;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // Resend caps a message at 40MB; a concept is one or two.
    if (bytes.length > 15_000_000) {
      console.warn(`send-design: concept image is ${bytes.length} bytes, sending without it`);
      return null;
    }
    const type = res.headers.get("content-type") || "image/png";
    const ext = type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : "png";
    return { filename: `jersey-concept.${ext}`, content: bytes.toString("base64") };
  } catch (err) {
    console.warn("send-design: could not fetch the concept image, sending without it", err);
    return null;
  }
}

/** Exported so the mail can be previewed without sending one. */
export function renderDesignMail(code: string, link: string, hasImage: boolean) {
  const text = [
    `Here's your jersey design.`,
    ``,
    `Your design code is ${code}.`,
    ``,
    `Reopen it any time: ${link}`,
    ``,
    hasImage ? `The concept is attached.` : ``,
    `Quote the code to us and we'll pull it straight up. Nothing is ordered yet —`,
    `this is just so you don't lose it.`,
    ``,
    `Marty's Jerseys`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  /* Inline styles and a table, because that is what mail clients render. No
     web fonts, no external stylesheet, nothing that needs loading. */
  const html = `<div style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e3e5e9">
    <tr><td style="padding:28px 28px 4px">
      <h1 style="margin:0 0 6px;font-size:19px;line-height:1.3;color:#14161a">Here's your jersey design</h1>
      <p style="margin:0;font-size:15px;line-height:1.5;color:#5b6270">Nothing is ordered yet — this is just so you don't lose it.</p>
    </td></tr>
    <tr><td style="padding:20px 28px 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;border-radius:10px">
        <tr><td style="padding:16px 18px;text-align:center">
          <div style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#5b6270">Your design code</div>
          <div style="font-size:34px;letter-spacing:.16em;font-weight:700;color:#14161a;padding-top:4px">${escape(code)}</div>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:20px 28px 0">
      <a href="${escape(link)}" style="display:block;background:#e4652a;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;text-align:center;padding:13px 20px;border-radius:9px">Open your design</a>
    </td></tr>
    <tr><td style="padding:16px 28px 26px">
      <p style="margin:0;font-size:14px;line-height:1.55;color:#5b6270">
        ${hasImage ? "The concept is attached to this email. " : ""}Quote your code to us any time and we'll pull it straight up.
      </p>
      <p style="margin:14px 0 0;font-size:13px;line-height:1.5;color:#8b929e">
        Or paste this in: <a href="${escape(link)}" style="color:#8b929e">${escape(link)}</a>
      </p>
    </td></tr>
  </table>
</div>`;

  return { text, html };
}

/**
 * Sends one design copy. Never throws: the caller has already saved everything
 * that matters and a failed send must not undo that.
 */
export async function sendDesign(mail: DesignMail): Promise<Sent> {
  if (!process.env.RESEND_API_KEY) {
    console.error("send-design: RESEND_API_KEY is not set, no mail sent");
    return { ok: false, status: null, message: "RESEND_API_KEY is not set" };
  }

  const base = (process.env.SITE_URL || mail.origin || "").replace(/\/+$/, "");
  const link = `${base}/?d=${encodeURIComponent(mail.code)}`;
  const began = Date.now();

  const image = mail.imageUrl ? await fetchImage(mail.imageUrl) : null;
  const { text, html } = renderDesignMail(mail.code, link, !!image);

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
        subject: `Your jersey design — code ${mail.code}`,
        text,
        html,
        attachments: image ? [image] : undefined,
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
        `send-design FAIL status=${res.status} ${took}s to=${mail.to} code=${mail.code} :: ${message}`,
      );
      return { ok: false, status: res.status, message };
    }

    const sent = await res.json().catch(() => null);
    console.log(
      `send-design OK ${took}s to=${mail.to} code=${mail.code} ` +
        `id=${sent?.id ?? "-"} attachment=${image ? "yes" : "no"}`,
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
