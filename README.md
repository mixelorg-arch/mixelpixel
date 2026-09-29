# mixelpixel

Turn any image into a dot / pixel pattern you can 3D print, cross stitch, or use as a diamond-painting chart.

**Live:** https://mixelorg-arch.github.io/mixelpixel/

- **Cartoonize first** (on by default): edge-preserving Kuwahara smoothing scaled to the grid, color pop, most-common-color sampling per cell, and one-cell ink outlines on light/dark borders, so photos stay readable as pixels
- 10 piece shapes: circle, square, rounded, diamond, hexagon, octagon, triangle, star, heart, plus
- Grid size (columns × rows, or fit to a width in mm), shape size and gap in mm, honeycomb stagger
- Color count 2–48 (auto k-means in Lab space), grayscale, or **My filaments** — map to the exact colors you own
- Dithering, rare-color cleanup, background knock-out, brightness / contrast / saturation
- Hand-edit the pattern: paint, erase, pick; merge or recolor any color in the key
- **DIY board kit** (diamond-painting style): a single-color base plate with through holes (or closed pockets), pieces exported as one folder per color (exact count + spares, or full bed sheets for stock), and a printable packing list per design. Boards bigger than the printer bed are split into plates that butt together.
- Exports: multi-material **STL ZIP** (one file per color + base plate), stitch chart PNG with symbol key, preview PNG, SVG in real mm, CSV color list

Runs entirely in the browser. No build step, no dependencies — just `index.html`, `style.css`, `app.js`.
