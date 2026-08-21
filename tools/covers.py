#!/usr/bin/env python3
"""Rebuild the landing page's category covers in about/cat/.

WHY THIS EXISTS, AND WHAT IT CAN AND CANNOT DO
----------------------------------------------
The masters are gone. Every category's artwork now lives ONLY as the `image`
field of its Firestore `categories/{id}` doc, and the game's own publish path
caps that at a 95 KB JPEG. Re-measured 2026-08-19 by decoding all forty: the
median is 480x480 and 32 of them sit exactly there, so for almost the whole
catalogue the resolution ceiling really is 480px and this script cannot invent
detail that was thrown away upstream.
⚠️ TWO ARE NOT — charadesArabic and charadesSeries are 1254x1254. The earlier
note here said nothing exceeded 480px, which was wrong, and it mattered: it is
the reason to keep reading the ORIGINAL bytes and to let the target be a
DOWNSCALE where the source allows one, rather than assuming every output is an
upscale of a 480px file.

⚠️ SINCE 2026-08-19 THE SOURCE IS NO LONGER THE 480px ORIGINAL. `tools/upscale.py`
super-resolves each cover x4 into `tools/srcache/` and `source_image()` prefers
that, which turns every branch below from an upscale into a DOWNSCALE — the case
the measurements here say is the good one. The owner's report was "the quality of
some of the covers is too bad", and neither resampling strategy nor encode
quality moved it, because the ceiling was the source. That cache is gitignored
and `main()` REFUSES to run without it unless given --no-sr, so a re-run cannot
quietly rebuild all forty from the small originals again.

What it CAN fix, and what was actually wrong with the old files:

  * They were re-encodes of re-encodes. The old preview covers were built from
    already-resized WebPs, so each one carried two generations of lossy
    artefacts. This reads the ORIGINAL Firestore JPEG bytes every time.
  * They were blown up past the source and left soft. Fourteen `-l` files were
    819x1024 or bigger — up to 1000x1250 — from a 480px original, at up to
    202 KB apiece. A 2x Lanczos with an unsharp mask is a far better upscale
    than the browser's default filter, and it is the most that is honest here.
  * Five were smaller than the source (252x315 from a 349px original), so they
    threw away pixels that existed.
  * They were encoded at whatever quality the old run used, and inconsistently
    — the same nominal size ranged from 7 KB to 202 KB.

Four categories have no Firestore artwork at all (foreignMoviesOnly, khareef,
omaniFootball, whoAmI); for those the bundled assets/img/cat-*.webp is the
source, which is what the game itself falls back to.

  -l  showcase art.  Built for the 4/5 frame it is DRAWN into, not for the
      source's own shape — see the note on L_W/L_H below, which is the bug the
      first version of this script shipped. 1080x1350, or the source's own
      aspect at the same render width for the wide ones the page shows whole.
  -t  grid tile.     Cropped to 3:4 at 420x560. The tile renders at most 176
      CSS wide = 352 device px, so this is a clean downscale.

  -s  board headers are NOT touched; they belong to about/shots/.

Quality: WebP q95 for -l, q90 for -t, method 6 — the owner asked for as high
as it goes (2026-08-08). Against the uncompressed upscale that is 41-46 dB
PSNR. q92 would save about 20% of the bytes for roughly 1 dB if the 8.5 MB of
showcase art ever needs trimming; the grid tiles are downscaled to 352px on
screen, so anything above q90 there is invisible.

Usage:  python3 tools/covers.py [--dry-run] [--only id,id]
"""

import argparse
import base64
import io
import json
import os
import re
import sys
import urllib.request

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "about", "cat")
BUNDLED = os.path.join(ROOT, "assets", "img")
REST = ("https://firestore.googleapis.com/v1/projects/izzbahgame/databases/"
        "(default)/documents/categories")

# Categories with no artwork in Firestore -> the bundled file the game uses.
FALLBACK = {
    "foreignMoviesOnly": "cat-foreignMoviesOnly.webp",
    "khareef": "cat-khareef.webp",
    "omaniFootball": "cat-omaniFootball.webp",
    "whoAmI": "cat-whoAmI.webp",
}

# The showcase frame is 4/5. Its biggest real render is the ~552 CSS px column
# at `max-height: 62svh` on a tall desktop = 552x690, which is 1104x1380 device
# pixels at 2x. Store a shade under that and let the browser DOWNSCALE, which
# is clean, instead of upscaling, which is not.
#
# Getting this wrong is what made the covers worse on 2026-08-08: the rebuild
# preserved each source's own aspect ratio (a 480x480 cover became 960x960),
# but the page draws them with `object-fit: cover`, so the browser then had to
# crop to 4/5 AND stretch 960 -> 1116. The files it replaced were already 4/5
# (819x1024, 1000x1250) and needed no browser scaling at all. A file must be
# built for the box it is drawn into, not for its own proportions.
# Showcase target, 4/5.
# ⚠️ DO NOT "RIGHT-SIZE" THIS TO THE DISPLAY BOX. It looks wrong — the rail caps
# a cover at 252 CSS px, so 1080 is four times what a 2x screen asks for, and
# delivering 512 would mean the browser downscales an upscale instead of two
# resamples becoming one. Tried it on 2026-08-19 and MEASURED the result on
# screen, pressed card, three different covers:
#
#     card A   old 1080px  detail 14.59   new 512px  12.83   -12.1%
#     card B   old 1080px  detail 11.44   new 512px   9.73   -14.9%
#     card C   old 1080px  detail 10.48   new 512px  10.25    -2.2%
#
# Every one got SOFTER. Handing the browser more pixels than it needs is worth
# something after all: it downsamples with a good filter and the extra detail
# survives into the result, which a file built at exactly the display size has
# nothing left to give. The 5 MB saved was real and the picture was worse, so
# the trade was refused. Revisit only with a measurement, not with reasoning.
L_W, L_H = 1080, 1350
L_MAX_SCALE = 3.0                  # never stretch a source further than this
T_W, T_H = 420, 560                # grid tile, 3:4
# ⚠️ Encode quality is not the lever it looks like. Measured at the rail's
# display size, q88 / q92 / q95 scored 24.58 / 24.57 / 24.55 — indistinguishable
# — while q95 cost 43% more bytes than q88. It is kept high anyway because the
# supersampling above is what carries the sharpness, and this is where those
# extra pixels either survive the encoder or do not.
L_Q, T_Q = 95, 90

# Mirrors the CSS in about/index.html: a wide (or very tall) cover is drawn
# whole over a blur of itself rather than cropped, so it is NOT pre-cropped to
# the frame — it is sized so the CONTAINED render is 1:1.
FRAME = L_W / L_H                  # 0.8


def fits_whole(ar):
    keep = FRAME / ar if ar > FRAME else ar / FRAME
    return keep < 0.7


def fetch_categories():
    """Every category doc, following nextPageToken.

    The REST API caps the RESPONSE SIZE, not the page count, so a big
    pageSize silently truncates once the base64 artwork is in the mask.
    Twenty at a time is safe; the token is what actually ends the loop.
    """
    docs, token = [], ""
    while True:
        url = (REST + "?pageSize=20&mask.fieldPaths=image&mask.fieldPaths=name"
               + ("&pageToken=" + token if token else ""))
        with urllib.request.urlopen(url, timeout=60) as r:
            page = json.load(r)
        if "error" in page:
            sys.exit("Firestore: " + page["error"].get("message", "?"))
        docs += page.get("documents", [])
        token = page.get("nextPageToken", "")
        if not token:
            return docs


SRCACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "srcache")


def source_image(cid, fields, use_sr=True):
    """The best available original for a category, as (PIL image, where).

    ⚠️ THE SUPER-RESOLVED COPY WINS WHEN IT EXISTS. `tools/upscale.py` writes
    `srcache/{id}.png` at 4x, and with it every branch below turns from an
    upscale into a DOWNSCALE — which is the case this file's own measurements
    say is the good one. Without it a 480px original has to be stretched to
    1080 and the result is the softness the owner reported.
    The cache is gitignored (40 PNGs at 4x, on the branch that IS the site), so
    `main()` refuses to run when it is missing rather than quietly rebuilding
    every cover from the small original again."""
    if use_sr:
        sr = os.path.join(SRCACHE, cid + ".png")
        if os.path.exists(sr):
            return Image.open(sr), "super-res"
    raw = (fields.get("image") or {}).get("stringValue") or ""
    m = re.match(r"^data:image/[a-z+]+;base64,(.*)$", raw, re.S)
    if m:
        return Image.open(io.BytesIO(base64.b64decode(m.group(1)))), "firestore"
    name = FALLBACK.get(cid)
    if name and os.path.exists(os.path.join(BUNDLED, name)):
        return Image.open(os.path.join(BUNDLED, name)), "bundled " + name
    return None, None


def sharpen(im, factor):
    """Unsharp mask scaled to how hard we just stretched the pixels.

    A plain Lanczos upscale is soft — correct, but soft. The mask is what makes
    2x look deliberate instead of blurry.

    Radius grows with the scale so the halo stays proportional; percent stays
    modest so faces and skies do not go crunchy.

    ⚠️ "Modest" is deliberate and was re-tested. On a near-1:1 output, pushing
    the mask from 48% to 75% raises Laplacian detail from 24.6 to 28.3 and to
    31.9 at 100% — but that metric REWARDS HALOS. Side by side on faces and
    fabric, 75% is genuinely crisper and 100% looks etched. None of it shipped:
    at the sizes this actually builds (see L_W) the upscale branch is the one
    that runs, and it was already tuned.
    """
    if factor <= 1.02:
        return im.filter(ImageFilter.UnsharpMask(radius=0.7, percent=45, threshold=3))
    return im.filter(ImageFilter.UnsharpMask(
        radius=min(1.6, 0.6 * factor), percent=int(min(95, 45 * factor)), threshold=3))


def crop_to(src, ar, bias=0.5):
    w, h = src.size
    if w / h > ar:
        nw = round(h * ar)
        left = round((w - nw) * 0.5)
        return src.crop((left, 0, left + nw, h))
    nh = round(w / ar)
    top = max(0, round((h - nh) * bias))
    return src.crop((0, top, w, top + nh))


def make_large(src):
    """Sized for how the page actually draws it.

    Covers that fill the frame are pre-cropped to 4/5 and delivered at the
    frame's device resolution, so the browser scales nothing. Wide ones are
    drawn whole (`object-fit: contain`) over a blur of themselves, so they keep
    their own shape and are sized so the CONTAINED render is 1:1 — for those
    the limiting dimension is width, or height for the very tall ones.
    """
    src = src.convert("RGB")
    w, h = src.size
    ar = w / h
    if fits_whole(ar):
        target = (L_W, round(L_W / ar)) if ar > FRAME else (round(L_H * ar), L_H)
        cut = src
    else:
        target, cut = (L_W, L_H), crop_to(src, FRAME, 0.4)

    scale = min(target[0] / cut.size[0], L_MAX_SCALE)
    if scale < 1.0:                        # source already bigger: downscale to fit
        target = (round(cut.size[0] * min(1.0, target[0] / cut.size[0])),
                  round(cut.size[1] * min(1.0, target[1] / cut.size[1])))
    elif scale < target[0] / cut.size[0] - 1e-6:
        target = (round(cut.size[0] * scale), round(cut.size[1] * scale))

    out = cut.resize(target, Image.LANCZOS)
    return sharpen(out, target[0] / cut.size[0])


def make_tile(src):
    """Crop to 3:4, then scale. Trims toward the TOP rather than the exact
    centre — these are portraits and posters, and a centre crop of a 480x270
    landscape decapitates the subject."""
    cut = crop_to(src.convert("RGB"), T_W / T_H, 0.35)
    out = cut.resize((T_W, T_H), Image.LANCZOS)
    return sharpen(out, T_W / cut.size[0])


def kb(n):
    return f"{n / 1024:.0f} KB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--no-sr", action="store_true",
                    help="build from the small Firestore originals, without the "
                         "super-resolved cache. Makes every cover softer.")
    args = ap.parse_args()
    only = {s for s in args.only.split(",") if s}

    # ⚠️ Refuse rather than silently downgrade. The committed covers were built
    # from the super-resolved cache; that cache is gitignored (40 PNGs at 4x, on
    # the branch that IS the published site), so on a fresh clone this would
    # otherwise rebuild all forty from the 480px originals and look like it had
    # worked. `--no-sr` is the way to ask for that on purpose.
    cached = len([f for f in os.listdir(SRCACHE) if f.endswith(".png")]) \
        if os.path.isdir(SRCACHE) else 0
    if not args.no_sr and cached < 2:
        sys.exit("tools/srcache/ has no upscaled covers, and the ones committed here "
                 "were built from it.\n"
                 "Run:  python3 tools/upscale.py\n"
                 "…or pass --no-sr to rebuild from the small originals on purpose.")
    if args.no_sr:
        print("⚠️  --no-sr: building from the small originals — every cover will be softer\n")

    docs = fetch_categories()
    print(f"{len(docs)} categories\n")
    before = after = 0
    rows = []
    for d in docs:
        cid = d["name"].rsplit("/", 1)[-1]
        if only and cid not in only:
            continue
        nm = (d.get("fields", {}).get("name") or {}).get("stringValue", "")
        src, where = source_image(cid, d.get("fields", {}), use_sr=not args.no_sr)
        if src is None:
            print(f"  !! {cid} ({nm}) — no artwork anywhere, left alone")
            continue

        for suffix, build, q in (("l", make_large, L_Q), ("t", make_tile, T_Q)):
            path = os.path.join(OUT, f"{cid}-{suffix}.webp")
            old = os.path.getsize(path) if os.path.exists(path) else 0
            oldsz = Image.open(path).size if old else (0, 0)
            im = build(src)
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=q, method=6)
            data = buf.getvalue()
            before += old
            after += len(data)
            rows.append((cid, suffix, oldsz, old, im.size, len(data), where))
            if not args.dry_run:
                with open(path, "wb") as f:
                    f.write(data)

    w = max((len(r[0]) for r in rows), default=10)
    for cid, sfx, osz, ob, nsz, nb, where in rows:
        print(f"  {cid:{w}} -{sfx}  {osz[0]}x{osz[1]} {kb(ob):>8}"
              f"  ->  {nsz[0]}x{nsz[1]} {kb(nb):>8}   ({where})")
    print(f"\ntotal {kb(before)} -> {kb(after)}"
          + ("   [dry run, nothing written]" if args.dry_run else ""))


if __name__ == "__main__":
    main()
