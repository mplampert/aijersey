# Jersey order page

One-page mobile-first flow: design → colours → roster → order.

## Deploy

```
npm i -g netlify-cli      # if you don't have it
netlify deploy --prod
```

Set the env var, then redeploy — Netlify env changes don't reach functions
until a new deploy:

```
netlify env:set GEMINI_API_KEY <key>
netlify deploy --prod
```

Local: `netlify dev` for the order page, which needs its functions.
`npm run dev` serves the repo as static files — enough for `/mockup/`, which
has no backend at all.

## The two halves

**`/` — the order page.** The customer flow: design, colours, roster, order.

**`/mockup/` — the mockup compositor.** Takes a flat artwork panel and renders
it onto a real jersey: a fixed 3D render in `public/mockup/front/`, clipped
through four region masks with the render's own shading laid back over the top.
No build, no dependencies, no backend. `public/mockup/front/README.md` covers
the assets.

The render itself is `mockup/render.js`, and both halves import it. The order
page shows a customer the same jersey the compositor does, off the same code —
two copies of this would drift, and drift would show up as two different
garments.

That inverts what the generator is for. It used to be asked for "a hockey
jersey" and returned a different garment every time; now the garment is fixed
and it supplies artwork only. `/api/generate-concept` produces flat panels to
match — square, full bleed, no garment, no folds, no shadows, no type.

## What's wired

- **Design** — prompt + idea chips + logo upload. Posts to `/api/generate-concept`,
  and renders the panel that comes back onto the garment.
- **Crest** — its own layer, laid on after the render at a measured chest
  position: the uploaded logo untouched, or the team name set as a wordmark,
  outlined against whatever it lands on. Never drawn into the artwork.
- **Colours** — factory colour card, multi-select. Passed into the prompt as the
  panel's palette, capped at five: past that a model treats the list as a
  suggestion.
- **Artwork checks** — every generated panel is read for blank margins and for
  a palette it ignored, and one bad read buys one redraw. `api/check-panel.ts`,
  no dependencies.
- **Compositor** — unified or per-region artwork, shading contrast, overlay or
  soft-light, and a 1500 × 1500 transparent PNG export.
- **Roster** — type, paste, or CSV. Parses `12 Sullivan L` and `31 Tremblay L G`.
  Validates duplicate numbers, missing number/name/size, and the minimum.
- **Order** — live total, kit add-ons priced per player, account fields.

## What isn't

- **The wordmark is a placeholder.** A customer without a logo gets their team
  name set in bold italic, fitted to the chest and outlined for contrast. It is
  legible on any artwork and it is not a crest. Real ones are drawn, arced,
  layered — this is one line of canvas text standing in for that.
- **A shared design refines from its mockup.** Opening a saved design by code
  puts the finished jersey in both `src` and `raw`, so refining it sends the
  model a picture of a garment — the one thing the pipeline exists to stop. The
  panel needs saving alongside the mockup for that path to work.
- **Only the front.** `Base.png` is a front view. The back needs its own asset
  set, its own masks and its own measured constants.
- **Checkout.** Button logs the order payload to the console. Point it at
  Stripe Checkout or a Shopify draft order.
- **Accounts.** Fields collect, nothing persists. Needs a backend.
- **Roster delivery.** Payload needs to go somewhere — email, GHL, or Blobs.

## Change these first

Everything tunable is in the `CFG` object at the top of the script in
`index.html`: minimum order, jersey price, add-ons and their prices, sizes,
and the colour card. Replace the colour card with your factory-matched
swatches — the twenty in there now are plausible placeholders, not real.

`MODEL` in the function is `gemini-2.5-flash-image`. Check for a newer image
model before launch; also confirm your Gemini API tier allows image output.

The `BLOCKED` list in the function screens obvious trademark requests. It's a
crude keyword filter, not a substitute for reviewing every proof.
