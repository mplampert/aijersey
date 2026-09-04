/**
 * What an order costs. The one place that answers that question.
 *
 * Everything is in cents, and stays in cents until something formats it for a
 * human. $49.99 is not representable in binary floating point, and a twelve-
 * jersey order priced as 12 * 49.99 comes to 599.8799999999999 — which is a
 * rounding bug waiting to be charged to somebody. Integers all the way to
 * Stripe, which wants cents anyway.
 *
 * The page in index.html carries its own copy of these numbers so it can show a
 * running total while the customer types, and that copy is for display only.
 * This module is what the customer is actually charged. If the two ever
 * disagree the page is wrong; change CFG.jerseyPrice and CFG.kit to match, and
 * see the note beside them.
 */

/** Minimum order. Below this the factory won't run the job. */
export const MOQ = 12;

/** The jersey, name and number included — there is no surcharge for either. */
export const JERSEY = 4999;

/* Keyed by the Kit items option name in Airtable, which is what a record
   stores and what the page sends. A kit item priced at nothing here is not
   free, it is unknown: quote() refuses the order rather than discounting it. */
export const KIT: Record<string, number> = {
  "Socks": 2400,
  "Skate soakers": 1900,
  "Player bags": 9900,
};

/** One per player, for every item — a roster of 14 buys 14 of each. */
export type Line = { label: string; unit: number; qty: number; total: number };

export type Quote = {
  lines: Line[];
  /** Cents. What Stripe charges, in full. */
  total: number;
  players: number;
  /** How many more jerseys are needed to reach the minimum, or 0 when it is met. */
  short: number;
  /** Kit names with no price here. Priced blind is worse than not priced. */
  unknownKit: string[];
};

export function quote(players: number, kit: string[] = []): Quote {
  const lines: Line[] = [];
  const unknownKit: string[] = [];

  if (players > 0) {
    lines.push({ label: "Jerseys", unit: JERSEY, qty: players, total: JERSEY * players });
  }
  for (const item of kit) {
    const unit = KIT[item];
    if (unit === undefined) {
      unknownKit.push(item);
      continue;
    }
    lines.push({ label: item, unit, qty: players, total: unit * players });
  }

  return {
    lines,
    total: lines.reduce((sum, l) => sum + l.total, 0),
    players,
    short: Math.max(0, MOQ - players),
    unknownKit,
  };
}

/** Cents to "$599.88". Always two decimals — money with one is a typo. */
export const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/**
 * Why this order cannot be placed, or null when it can.
 *
 * The minimum is the whole of it in practice, and it is said as a number of
 * jerseys still needed rather than as a rule, because "add 3 more" is something
 * a customer can act on and "minimum order 12" is something they have to work out.
 */
export function refuse(q: Quote): string | null {
  if (q.players === 0) return "There's nobody on the roster yet.";
  if (q.short > 0) {
    return `Minimum order is ${MOQ} jerseys. There ${q.players === 1 ? "is" : "are"} ` +
      `${q.players} on this roster, so it needs ${q.short} more.`;
  }
  if (q.unknownKit.length) {
    return `We can't price ${q.unknownKit.join(" or ")} — get in touch and we'll sort it out.`;
  }
  return null;
}
