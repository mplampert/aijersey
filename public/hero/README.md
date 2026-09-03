# Jersey renders

`hero-1.png` … `hero-8.png` — real generated concepts, front and back on a pale
studio sweep. The page is dark, so that light ground is what makes each one read
as a lit panel; a render on a dark or transparent ground will disappear into it.

Three places use them:

  hero        hero-1, hero-2, hero-3, named directly in the markup so they load
              with the page. The hero sizes its columns to those three files'
              aspect ratios (3:2, 3:2, 1:1) so the row comes out level — swap
              one for a different shape and that rule wants revisiting.
  gallery     all of them, from CFG.heroImages
  canvas      the same list, rotating as the example until a real concept lands

To add one: drop the file in here and add its name to `CFG.heroImages` in
index.html. Nothing else needs touching.

These are large — 1–3 MB each, about 19 MB for the set. The gallery loads them
lazily, but they are worth re-encoding (WebP, or resized to the widths the page
actually renders) before this sees real traffic.
