# Garment assets — front view

The fixed garment the mockup compositor at `/mockup/` renders artwork onto.
Five files, all 1500 × 1500 PNG with alpha, already registered against each
other.

    Base.png                neutral grey render of the garment — the shading pass
    mask-body-front.png     torso
    mask-shoulders.png      shoulder yoke
    mask-sleeves.png        both sleeves
    mask-collar.png         collar and neck rib

Only the **alpha channel** of the four masks is read. Their RGB is ignored, so
it does not matter what colour the shapes are.

## Measured

Re-measured from the pixels of these exact files, and matching the numbers the
brief arrived with:

    garment bounding box    (234, 97) to (1250, 1397), from Base.png's alpha
    luminance in-garment    p1 16 · p25 123 · p50 144 · p75 162 · p99 190
    neutrality              max channel spread 3, so red alone is the luminance
    coverage                body 647,547 · sleeves 334,089 · shoulders 94,885 · collar 54,617
    mask overlap            12 px body/collar, 108 px shoulders/collar — antialiasing only
    outside the silhouette  0 px, except 1 px of collar

**The mid-tone is 144, not 128.** Overlay and soft-light both pivot at 128, so
`Base.png` is remapped around that before it is used as a shading layer —
`L' = 128 + (L - 144) × contrast`. Skip the remap and every render comes out
washed out.

## Two things the masks do not cover

**The armhole seam.** Down the right armhole the four masks leave a wedge that
belongs to no region — the shaded crease between body and sleeve — up to 27 px
across, 13 at the median, roughly (1051,382)–(1097,567) and (1035,588)–(1055,721).
Around 600 sub-pixel slivers sit along the other shared edges.

The compositor does not dilate anything to close them. It underpaints the whole
silhouette with the body's own source and draws the four regions on top, so what
shows through is the gap and nothing else. Dilating instead would need 14 px to
reach across the wedge, which drags the body mask under the collar and shoulder
seams.

**The neck opening.** (606,148)–(893,240), about 17,883 px of dark mesh inside
the collar. It is deliberately in none of the four masks and no artwork may
reach it, so the compositor cuts that rectangle back out of the underpaint.
Every other pixel of the rectangle is already under the collar or shoulder mask,
which is why a plain rectangle is safe here.

## Replacing these

The compositor reads its constants from the top of `mockup/index.html` —
`CANVAS`, `GARMENT`, `SHADE_PIVOT`, `NECK`. A new render means re-measuring all
four. `Base.png` at any size other than 1500 square is refused rather than
silently misregistered.

There is no back view. It needs its own asset set, and its own set of measured
constants.
