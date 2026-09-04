# Artwork Generation Spec — `generate-concept.ts`

The generator produces **flat artwork only**. The garment comes entirely from
`Base.png` and the four masks. If the generator returns a jersey, the pipeline
is broken — its painted shadows fight the real shading pass and the composite
goes muddy.

---

## Output contract

| | |
|---|---|
| Aspect | 1:1, square |
| Delivered size | 1500 × 1500 (upscale if the model returns smaller) |
| Content | Flat illustrated panel, full bleed |
| Never contains | Garment, folds, shadows, highlights, text, numbers, logos, mockups, hangers, people |

Square matters. The compositor draws the master once across the full 1500 × 1500
canvas and every region clips from that same draw. A 3:4 or 16:9 image has to be
cropped or letterboxed before it can be used, which breaks alignment across the
body/sleeve seam.

---

## Prompt builder

```ts
type ConceptInput = {
  theme: string;          // "tropical beach with palm trees and hibiscus"
  palette: string[];      // ["#F26722", "#2E9BA6", "#E8D5B0"] — 3 to 5
  style?: string;         // defaults to STYLE_DEFAULT
};

const STYLE_DEFAULT =
  "bold flat color fills, clean confident line work, screen-print style, " +
  "high contrast, vector illustration";

const NEGATIVE = [
  "no jersey", "no shirt", "no garment", "no clothing", "no fabric",
  "no folds", "no wrinkles", "no shadows", "no highlights", "no lighting",
  "no 3d render", "no mockup", "no hanger", "no mannequin", "no person",
  "no text", "no letters", "no words", "no numbers", "no logo",
  "no watermark", "no borders", "no margins", "no frame", "no drop shadow",
].join(", ");

function buildPrompt(i: ConceptInput): string {
  return [
    "Flat artwork panel for a sublimated hockey jersey. Square 1:1 composition.",
    `Full-bleed illustrated scene, edge to edge. Subject: ${i.theme}.`,
    `Color palette limited strictly to: ${i.palette.join(", ")}.`,
    i.style ?? STYLE_DEFAULT,
    "Composition symmetric about the vertical center line.",
    "Flat 2D artwork only, as if printed on paper, viewed straight on.",
    NEGATIVE,
  ].join(" ");
}
```

---

## Why each clause is there

**"Flat artwork panel"** — the single most important phrase. Drop it and you get
a jersey. Every time.

**"Square 1:1"** — matches the compositor canvas so no cropping is needed.

**"Full-bleed, edge to edge"** — models default to composing a centered subject
on a background with margins. Margins become bare fabric after clipping.

**Explicit hex palette** — an unconstrained palette produces artwork that can't
be tied to a team's colors, and the whole point is that these are team jerseys.
Three to five values. More than five and the model ignores the constraint.

**"Symmetric about the vertical center"** — the garment is symmetric. Asymmetric
artwork puts the visual weight off-center once it's masked, and the two sleeves
end up mismatched.

**"Flat 2D artwork only, as if printed on paper, viewed straight on"** — this
does more work than the negative list. Models understand "printed on paper"
better than "no shadows."

**The negative list, especially the lighting terms** — `Base.png` supplies all
the shading. Any shadow the model paints is a second, conflicting light source.

---

## Composition guidance, optional

The masks put the shoulder yoke in the top ~25% and the hem in the bottom ~30%.
Adding this to the prompt gives more usable results, though models follow it
inconsistently:

```
"Horizontal band composition: distinct treatment across the top quarter, " +
"main scene through the middle, distinct treatment across the bottom third."
```

Treat that as a nudge, not a guarantee.

---

## What is NOT generated

Crest, nameplate, player numbers, sleeve numbers, and team logo. All of it goes
on as vector in Illustrator after the mockup renders. Image models cannot
produce legible type — every garbled number in earlier attempts came from asking
for it.

The compositor renders the garment and its artwork. Type is a separate layer,
added later, never generated.

---

## Validation before compositing

Cheap checks worth running on the returned image:

1. **Corner alpha / fill.** Sample the four corners. If any is white or
   transparent, the model produced a centered subject with margins rather than
   full bleed. Reject and regenerate.
2. **Palette drift.** Sample ~200 random pixels and check the share landing
   within a tolerance of the requested palette. Below ~60% means it ignored the
   constraint.
3. **Aspect.** Not square → crop center square before use, and flag it.

A "regenerate" button matters more than perfect validation. Expect two or three
attempts per usable panel.

---

## Test theme

Use this for the first end-to-end run, since there's a known-good factory
reference to compare against:

```
theme:   "tropical beach scene with palm trees, hibiscus flowers, sand dunes,
          ocean horizon at sunset"
palette: ["#F26722", "#2E9BA6", "#E8D5B0", "#1F4E5F"]
```

If that comes back as a flat panel and masks cleanly onto the garment, the
pipeline is proven end to end.
