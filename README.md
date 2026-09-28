# mixelpixel

Turn any image into a dot / pixel pattern you can 3D print, cross stitch, or use as a diamond-painting chart.

**Live:** https://mixelorg-arch.github.io/mixelpixel/

- 10 piece shapes: circle, square, rounded, diamond, hexagon, octagon, triangle, star, heart, plus
- Grid size (columns × rows, or fit to a width in mm), shape size and gap in mm, honeycomb stagger
- Color count 2–48 (auto k-means in Lab space), grayscale, or **My filaments** — map to the exact colors you own
- Dithering, rare-color cleanup, background knock-out, brightness / contrast / saturation
- Hand-edit the pattern: paint, erase, pick; merge or recolor any color in the key
- **DIY board kit** (diamond-painting style): a base plate with a pocket for every piece, optional color-guide floors, and loose pieces per color (+ spares) packed onto bed-sized sheets. Boards bigger than the printer bed are split into plates that butt together.
- Exports: multi-material **STL ZIP** (one file per color + base plate), stitch chart PNG with symbol key, preview PNG, SVG in real mm, CSV color list

Runs entirely in the browser. No build step, no dependencies — just `index.html`, `style.css`, `app.js`.
