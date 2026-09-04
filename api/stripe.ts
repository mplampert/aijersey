import { createHmac, timingSafeEqual } from "node:crypto";
import { money, type Quote } from "./pricing.js";

/**
 * Stripe, over its REST API.
 *
 * No SDK. These are three form-encoded POSTs and a GET, and the repo already
 * avoids dependencies a serverless function can do without — the Stripe library
 * is a large cold start to buy a fetch wrapper.
 *
 * Nothing here is called at the concept stage. A Checkout Session is minted
 * once the customer has approved their factory proof and not a moment earlier,
 * which is the whole shape of this business: the jersey is redrawn by a human,
 * the customer says yes to what will actually be made, and only then does money
 * move.
 *
 * Env vars required:
 *   STRIPE_SECRET_KEY      — sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET  — whsec_…, from the endpoint you register for
 *                            checkout.session.completed. Without it the webhook
 *                            refuses every delivery, so payment status never
 *                            leaves "Link sent".
 */

const API = "https://api.stripe.com/v1";

/* Pinned. Stripe changes shapes between versions, and a silent upgrade under a
   payment flow is not something to find out about from a customer. */
const API_VERSION = "2024-06-20";

const LOG_LIMIT = 800;
const trim = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > LOG_LIMIT ? `${one.slice(0, LOG_LIMIT)}…` : one;
};

export type StripeReply<T> = { ok: true; data: T } | { ok: false; status: number | null; message: string };

/**
 * One request, both halves logged — the same bargain ghl-contact makes. A
 * payment that did not happen is not something to diagnose from a summary line.
 * The secret key is never printed; the form body is, and it holds an email
 * address and an amount, which is what you need to see when a charge is wrong.
 */
async function call<T>(step: string, path: string, form?: URLSearchParams): Promise<StripeReply<T>> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("stripe: STRIPE_SECRET_KEY is not set — no session can be created");
    return { ok: false, status: null, message: "STRIPE_SECRET_KEY is not set" };
  }
  const began = Date.now();
  const method = form ? "POST" : "GET";
  console.log(
    `stripe → ${step} ${method} ${path} key=${key.slice(0, 7)}…` +
    (form ? ` body=${trim(form.toString())}` : ""),
  );
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Stripe-Version": API_VERSION,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(form ? { body: form.toString() } : {}),
    });
    const body = await res.text().catch(() => "");
    let json: any = null;
    try {
      json = JSON.parse(body);
    } catch {
      // Not JSON — a gateway page.
    }
    const line = `stripe ← ${step} ${res.status} ${((Date.now() - began) / 1000).toFixed(1)}s :: ${trim(body)}`;
    if (res.ok) console.log(line);
    else console.error(line);

    if (!res.ok) {
      const e = json?.error;
      return {
        ok: false,
        status: res.status,
        message: [e?.code, e?.message].filter(Boolean).join(": ") || trim(body) || "(empty body)",
      };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    const message = String((err as any)?.message ?? err);
    console.error(`stripe ← ${step} no-response ${((Date.now() - began) / 1000).toFixed(1)}s :: ${trim(message)}`);
    return { ok: false, status: null, message };
  }
}

export type Session = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number | null;
  expires_at: number;
};

export type Order = {
  quote: Quote;
  /** Airtable record id. Comes back on the webhook, and is how payment is filed. */
  recordId: string;
  /** The design code, for the Stripe dashboard and the customer's own reference. */
  code: string;
  email: string;
  team: string | null;
  /** Where Stripe returns the customer once they have paid, or backed out. */
  origin: string;
};

/**
 * The session the payment link points at.
 *
 * One line item per thing being bought, priced inline rather than against a
 * Stripe Product: the price of a jersey is a number this repo owns, and
 * mirroring the catalogue into Stripe would give it two homes and one of them
 * would go stale. `quantity` is the roster count, so the customer sees "14 ×
 * $49.99" on Stripe's page rather than one opaque total.
 *
 * The record id travels as both client_reference_id and metadata. The webhook
 * reads it to file the payment against the right design, and it shows on the
 * payment in the Stripe dashboard where somebody looking at a charge can find
 * the order it belongs to.
 */
export async function createSession(order: Order): Promise<StripeReply<Session>> {
  const form = new URLSearchParams({
    mode: "payment",
    // Stripe sends them here when they are done; the page reads the code out of
    // the query and says what happened.
    success_url: `${order.origin}/?paid=${encodeURIComponent(order.code)}`,
    cancel_url: `${order.origin}/?payment=cancelled&d=${encodeURIComponent(order.code)}`,
    customer_email: order.email,
    client_reference_id: order.recordId,
    "metadata[record_id]": order.recordId,
    "metadata[design_code]": order.code,
    "payment_intent_data[description]":
      `Jerseys ${order.code}${order.team ? ` — ${order.team}` : ""}`,
  });
  if (order.team) form.set("metadata[team]", order.team.slice(0, 500));

  order.quote.lines.forEach((line, i) => {
    form.set(`line_items[${i}][price_data][currency]`, "usd");
    form.set(`line_items[${i}][price_data][unit_amount]`, String(line.unit));
    form.set(`line_items[${i}][price_data][product_data][name]`, line.label);
    form.set(`line_items[${i}][quantity]`, String(line.qty));
  });

  return call<Session>("createSession", "/checkout/sessions", form);
}

/** One session, by id. Used to see whether a link already sent is still good. */
export async function readSession(id: string): Promise<StripeReply<Session>> {
  return call<Session>("readSession", `/checkout/sessions/${encodeURIComponent(id)}`);
}

/** A session is worth re-sending only while it is open and unexpired. */
export const stillGood = (s: Session) =>
  s.status === "open" && s.url !== null && s.expires_at * 1000 > Date.now();

/** For the email and the log. */
export const total = (q: Quote) => money(q.total);

/* Stripe signs every webhook. A tolerance stops a captured delivery being
   replayed later; five minutes is Stripe's own recommendation. */
const TOLERANCE_S = 300;

/**
 * Whether a webhook really came from Stripe.
 *
 * The signature covers `<timestamp>.<raw body>`, so the body has to be the
 * exact bytes Stripe sent — parse it after this, never before, or a re-
 * serialised object will not match and every delivery will be refused.
 *
 * Returns the reason it failed rather than a bare false, because "the webhook
 * is not firing" and "the webhook is firing and being rejected" look identical
 * from Airtable and want opposite fixes.
 */
export function verifySignature(raw: string, header: string | null): { ok: true } | { ok: false; why: string } {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: false, why: "STRIPE_WEBHOOK_SECRET is not set" };
  if (!header) return { ok: false, why: "no Stripe-Signature header" };

  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  const sent = parts.v1;
  if (!timestamp || !sent) return { ok: false, why: `malformed Stripe-Signature: ${trim(header)}` };

  const age = Math.abs(Date.now() / 1000 - timestamp);
  if (age > TOLERANCE_S) {
    return { ok: false, why: `signature is ${Math.round(age)}s old, past the ${TOLERANCE_S}s tolerance` };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sent, "utf8");
  // Length has to match before timingSafeEqual will look at them at all.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, why: "signature does not match the body" };
  }
  return { ok: true };
}
