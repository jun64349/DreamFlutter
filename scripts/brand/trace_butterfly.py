r"""1:1 vector trace of the user's butterfly icon (docs/design/assets/butterfly-icon-original.png).

Writes docs/design/assets/butterfly.svg (the master) and butterfly-trace-check.png (original | trace | difference),
and prints how far the trace is from the original. See docs/design/brand.md, section 二.1.

Run (PowerShell, from the repository root; the venv lives outside the repo):

    core\bin\uv.exe venv --python core\python\cpython-3.13.18-windows-x86_64-none\python.exe $env:TEMP\bf-trace
    core\bin\uv.exe pip install --python $env:TEMP\bf-trace\Scripts\python.exe numpy pillow scipy potracer resvg-py
    & $env:TEMP\bf-trace\Scripts\python.exe scripts\brand\trace_butterfly.py

How it works:
  * The original is enlarged 4x (bicubic) and split into layers by colour: the dark lines (four pieces: two wing
    outlines, two antennae), the six wing areas they enclose, and in each area the light core and the coloured band.
  * A dark pixel counts as line where it is darker than halfway between the line colour and its light neighbour,
    so the line keeps its true width on both the orange and the cream side.
  * Every colour area is extended under the lines up to their middle (each line pixel takes the nearest area), so
    the layers stack without seams and still make sense with the outline removed.
  * The peach core of the right forewing fades into its band on the body side; there its edge is taken from the
    mirror image of the left forewing's core, which matches its visible edge to within a pixel.
  * Each layer is smoothed by 1 px (at 1x) and traced with potrace; colours are measured from the original:
    flat where the area is flat, a linear gradient fitted along its main direction otherwise.
"""
import io
import json
import sys
from pathlib import Path

import numpy as np
import potrace
import resvg_py
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "docs" / "design" / "assets"
ORIGINAL = ASSETS / "butterfly-icon-original.png"
F = 4            # working scale
SMOOTH = 1.0     # px at 1x
LINE = 58.0      # luminance of the line colour

# Theme roles and the original's values for them (the themed mode of the SVG falls back to these).
DEFAULTS = dict(bg="#EEE7D7", line="#3F3B34", core="#F3F0E4", wing="#CA704D", glow="#E8CCB0")


def bbox(m):
    ys, xs = np.where(m)
    return xs.min(), xs.max(), ys.min(), ys.max()


def trace(mask):
    mask = ndi.gaussian_filter(mask.astype(np.float32), SMOOTH * F) > 0.5
    x0, x1, y0, y1 = bbox(mask)
    x0, y0 = max(x0 - 4, 0), max(y0 - 4, 0)
    x1, y1 = min(x1 + 4, mask.shape[1] - 1), min(y1 + 4, mask.shape[0] - 1)
    curves = potrace.Bitmap(~mask[y0:y1 + 1, x0:x1 + 1]).trace(
        turdsize=4 * F * F, alphamax=1.2, opticurve=True, opttolerance=0.2)

    def p(pt):
        return "%.2f %.2f" % ((pt.x + x0) / F, (pt.y + y0) / F)

    d = []
    for c in curves:
        d.append("M" + p(c.start_point))
        for s in c:
            d.append("L" + p(s.c) + "L" + p(s.end_point) if s.is_corner
                     else "C" + p(s.c1) + " " + p(s.c2) + " " + p(s.end_point))
        d.append("Z")
    return "".join(d)


def segment(src):
    im = np.array(src.resize((1024 * F, 1024 * F), Image.BICUBIC)).astype(float)
    lum = im.mean(-1)
    mx, mn = im.max(-1), im.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1)
    white = mn > 247                      # outside the rounded square
    solid_dark = lum < 100
    near = ndi.distance_transform_edt(~solid_dark) <= 2 * F
    lmax = ndi.maximum_filter(lum, size=8 * F + 1)
    dark = solid_dark | ((lum < (lmax + LINE) / 2) & (sat < 0.22) & near)
    dl, n = ndi.label(dark)
    sizes = ndi.sum(dark, dl, range(1, n + 1))
    comps = [int(i) + 1 for i in np.argsort(-sizes)[:4]]
    dark = np.isin(dl, comps)
    wings = sorted(comps[:2], key=lambda c: bbox(dl == c)[0])
    ants = sorted(comps[2:], key=lambda c: bbox(dl == c)[0])

    ll, _ = ndi.label(~dark)
    ext = (ll == ll[512 * F, 40 * F]) | white
    interior = ~dark & ~ext
    rl, rn = ndi.label(interior)
    rs = ndi.sum(interior, rl, range(1, rn + 1))
    names = {}
    for r in range(1, rn + 1):
        if rs[r - 1] < 500 * F * F:
            continue
        x0, x1, y0, _ = bbox(rl == r)
        side = "l" if (x0 + x1) / 2 / F < 512 else "r"
        part = "upper-a" if y0 / F < 300 else ("upper-b" if y0 / F < 400 else "lower")
        names[r] = side + "-" + part
    inv = {v: k for k, v in names.items()}
    assert sorted(names.values()) == sorted(
        s + "-" + p for s in "lr" for p in ("upper-a", "upper-b", "lower")), names

    core = interior & (sat < 0.22) & (lum > 200)
    ra, la = rl == inv["r-upper-a"], rl == inv["l-upper-a"]
    tint = ndi.binary_opening(ra & (sat >= 0.14) & (sat < 0.30) & (lum > 195), iterations=F)
    mirror = (la & core)[:, ::-1]          # mirror axis x = 511.5
    core = (core & ~ra) | (ra & (tint | mirror))

    lab = np.zeros(lum.shape, np.int16)
    lab[ext & ~white] = 1
    lab[white] = 2
    for r in names:
        lab[rl == r] = 10 + r
        lab[(rl == r) & core] = 20 + r
    idx = ndi.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
    nearest = lab[idx[0], idx[1]]

    paths = {
        "background": trace(~white),
        "outline-left": trace(dl == wings[0]), "outline-right": trace(dl == wings[1]),
        "antenna-left": trace(dl == ants[0]), "antenna-right": trace(dl == ants[1]),
    }
    for r, nm in names.items():
        paths["band-" + nm] = trace((nearest == 10 + r) | (nearest == 20 + r))
        paths["core-" + nm] = trace(nearest == 20 + r)
    masks = {"background": lab == 1, "outline": dark}
    for r, nm in names.items():
        masks["band-" + nm] = lab == 10 + r
        masks["core-" + nm] = lab == 20 + r
    return paths, masks


def measure(im1, masks):
    yy, xx = np.mgrid[0:1024, 0:1024].astype(float)

    def down(m):
        return m.reshape(1024, F, 1024, F).all(axis=(1, 3))

    def fit(m, nst):
        m = ndi.binary_erosion(m, iterations=3)
        X = np.stack([np.ones(m.sum()), xx[m], yy[m]], 1)
        Y = im1[m]
        coef = np.linalg.lstsq(X, Y, rcond=None)[0]
        G = coef[1:].T
        d = np.linalg.svd(G)[2][0]
        t = xx[m] * d[0] + yy[m] * d[1]
        lo, hi = np.percentile(t, 1), np.percentile(t, 99)
        stops = []
        for k in range(nst):
            a = lo + (hi - lo) * k / (nst - 1)
            sel = np.abs(t - a) < (hi - lo) / (2 * (nst - 1)) + 1
            stops.append([round(k / (nst - 1), 3), np.median(Y[sel], 0).round().astype(int).tolist()])
        cx, cy = xx[m].mean(), yy[m].mean()
        c0 = cx * d[0] + cy * d[1]
        return dict(flat=np.median(Y, 0).round().astype(int).tolist(),
                    span=float(np.abs(G @ d).max() * (hi - lo)), stops=stops,
                    p1=[round(float(cx + (lo - c0) * d[0]), 1), round(float(cy + (lo - c0) * d[1]), 1)],
                    p2=[round(float(cx + (hi - c0) * d[0]), 1), round(float(cy + (hi - c0) * d[1]), 1)])

    fits = {}
    for k, m in masks.items():
        if k == "outline":
            dk = down(m)
            fits[k] = dict(flat=np.median(im1[ndi.binary_erosion(dk, iterations=4)], 0).round().astype(int).tolist())
        else:
            fits[k] = fit(down(m), 7 if k.startswith("band") else 5)
    return fits


def hexc(c):
    return "#%02X%02X%02X" % tuple(int(round(v)) for v in c)


def rgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)


def build_svg(paths, fits, palette=None):
    """The master SVG; with a palette, every colour resolved for that palette (for previews)."""
    W, G = rgb(DEFAULTS["wing"]), rgb(DEFAULTS["glow"])

    def tmix(c):
        v = G - W
        return float(np.clip(np.dot(np.array(c, float) - W, v) / np.dot(v, v), 0, 1))

    def col(role, literal, t=None):
        if palette is None:
            return literal
        if role == "mix":
            return hexc(rgb(palette["wing"]) * (1 - t) + rgb(palette["glow"]) * t)
        return palette[role]

    role_of = {"band": "wing", "core": "core"}
    part_name = {"upper-a": "forewing-outer", "upper-b": "forewing-inner", "lower": "hindwing"}
    defs = []

    def piece(key):
        cls, side, part = key.split("-", 2)
        f = fits[key]
        eid = "%s-%s-%s" % (cls, "left" if side == "l" else "right", part_name[part])
        if f["span"] < 8:
            paint = 'class="%s" fill="%s"' % (role_of[cls], col(role_of[cls], hexc(f["flat"])))
        else:
            stops = "".join('<stop offset="%g" stop-color="%s" class="mix" style="--t:%d%%"/>'
                            % (o, col("mix", hexc(c), tmix(c)), round(tmix(c) * 100)) for o, c in f["stops"])
            defs.append('<linearGradient id="grad-%s" gradientUnits="userSpaceOnUse" x1="%s" y1="%s" x2="%s" y2="%s">%s'
                        '</linearGradient>' % (eid, *f["p1"], *f["p2"], stops))
            paint = 'fill="url(#grad-%s)"' % eid
        return '<path id="%s" %s d="%s"/>' % (eid, paint, paths[key])

    body = ['<g id="background"><path class="bg" fill="%s" d="%s"/></g>'
            % (col("bg", hexc(fits["background"]["flat"])), paths["background"])]
    for gid, cls, side in (("wing-band-left", "band", "l"), ("wing-band-right", "band", "r"),
                           ("wing-core-left", "core", "l"), ("wing-core-right", "core", "r")):
        body.append('<g id="%s">%s</g>' % (gid, "".join(piece("%s-%s-%s" % (cls, side, p)) for p in part_name)))
    line = col("line", hexc(fits["outline"]["flat"]))
    body.append('<g id="antennae" class="line" fill="%s"><path id="antenna-left" d="%s"/><path id="antenna-right" d="%s"/></g>'
                % (line, paths["antenna-left"], paths["antenna-right"]))
    body.append('<g id="outline" class="line" fill="%s" fill-rule="evenodd"><path id="outline-left" d="%s"/>'
                '<path id="outline-right" d="%s"/></g>' % (line, paths["outline-left"], paths["outline-right"]))
    style = ("<style>"
             ".themed .bg{fill:var(--bf-bg,%(bg)s)}"
             ".themed .line{fill:var(--bf-line,%(line)s)}"
             ".themed .core{fill:var(--bf-core,%(core)s)}"
             ".themed .wing{fill:var(--bf-wing,%(wing)s)}"
             ".themed .mix{stop-color:color-mix(in srgb,var(--bf-wing,%(wing)s),var(--bf-glow,%(glow)s) var(--t))}"
             "</style>") % DEFAULTS
    head = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n'
            "<title>DreamFlutter butterfly</title>\n"
            "<desc>1:1 vector trace of docs/design/assets/butterfly-icon-original.png (scripts/brand/trace_butterfly.py). "
            "Default colours are the original's, measured. Add class=\"themed\" to the svg element to recolour with "
            "--bf-bg, --bf-line, --bf-core, --bf-wing, --bf-glow (gradient stops mix --bf-wing and --bf-glow by --t). "
            "See docs/design/brand.md.</desc>\n")
    return head + "<defs>" + style + "\n" + "\n".join(defs) + "</defs>\n" + "\n".join(body) + "\n</svg>\n"


def render(svg, size=1024):
    png = bytes(resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size, background="#ffffff"))
    return np.array(Image.open(io.BytesIO(png)).convert("RGB")).astype(float)


def main():
    src = Image.open(ORIGINAL).convert("RGB")
    im1 = np.array(src).astype(float)
    paths, masks = segment(src)
    fits = measure(im1, masks)
    svg = build_svg(paths, fits)
    (ASSETS / "butterfly.svg").write_text(svg, encoding="utf-8")

    r = render(svg)
    d = np.abs(r - im1).mean(-1)
    do, dr = im1.mean(-1) < 100, r.mean(-1) < 100
    print("butterfly.svg: %d bytes, %d path segments" % (len(svg), sum(v.count("C") + v.count("L") for v in paths.values())))
    print("difference from the original (0-255 per pixel): mean %.2f, 99th percentile %.1f, "
          "over 40: %.3f%% of pixels, over 80: %d pixels; dark-line overlap %.4f"
          % (d.mean(), np.percentile(d, 99), 100 * (d > 40).mean(), (d > 80).sum(), (do & dr).sum() / (do | dr).sum()))

    # check sheet: original | trace | difference x4, then the right forewing enlarged 2.4x (original | trace)
    s = 512
    o_img, r_img = src, Image.fromarray(r.astype(np.uint8))
    diff = Image.fromarray(np.clip(d * 4, 0, 255).astype(np.uint8)).convert("RGB")
    sheet = Image.new("RGB", (3 * s + 40, s + 20 + 672 + 10), "white")
    for i, im in enumerate((o_img, r_img, diff)):
        sheet.paste(im.resize((s, s), Image.LANCZOS), (10 + i * (s + 10), 10))
    box = (515, 275, 835, 555)
    for i, im in enumerate((o_img, r_img)):
        sheet.paste(im.crop(box).resize((768, 672), Image.NEAREST), (10 + i * (768 + 10), s + 20))
    sheet.save(ASSETS / "butterfly-trace-check.png", optimize=True)


if __name__ == "__main__":
    sys.exit(main())
