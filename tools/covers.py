#!/usr/bin/env python3
"""Rebuild the landing page's category covers in preview/cat/.

WHY THIS EXISTS, AND WHAT IT CAN AND CANNOT DO
----------------------------------------------
The masters are gone. Every category's artwork now lives ONLY as the `image`
field of its Firestore `categories/{id}` doc, and the game's own publish path
caps that at a 95 KB JPEG — measured 2026-08-08, the largest is 480x480 and
NOTHING in the catalogue exceeds 480px on either side. So there is no such
thing as "export the covers at a higher resolution": the resolution ceiling is
480px and this script cannot invent detail that was thrown away upstream.

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

  -l  showcase art.  The stage fits the whole image inside a 4/5 frame (no
      crop), about 446x558 CSS on a 1440px window = ~892x1116 on a 2x screen.
      Target: 2x the source, long side capped at 1200.
  -t  grid tile.     Rendered at most 176 CSS wide in a 3/4 tile = 352 device
      px, so 384x512 is already generous. Cropped to 3:4, centre-weighted.

  -s  board headers are NOT touched; they belong to preview/shots/.

Quality: WebP q86 for -l, q84 for -t. Measured against the uncompressed
upscale, q86 lands at 36-41 dB PSNR across the catalogue and q92 only buys
1.5-2 dB for ~25% more bytes — bytes spent re-encoding the source JPEG's own
artefacts, since the source is already lossy.

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
OUT = os.path.join(ROOT, "preview", "cat")
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

L_SCALE, L_CAP = 2.0, 1200         # showcase: 2x the source, capped
T_W, T_H = 384, 512                # grid tile, 3:4
L_Q, T_Q = 86, 84


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


def source_image(cid, fields):
    """The best available original for a category, as (PIL image, where)."""
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

    A plain Lanczos upscale is soft — correct, but soft. The mask is what
    makes 2x look deliberate instead of blurry. Radius grows with the scale
    so the halo stays proportional; percent stays modest so faces and skies
    do not go crunchy.
    """
    if factor <= 1.02:
        return im.filter(ImageFilter.UnsharpMask(radius=0.7, percent=45, threshold=3))
    return im.filter(ImageFilter.UnsharpMask(
        radius=min(1.6, 0.6 * factor), percent=int(min(95, 45 * factor)), threshold=3))


def make_large(src):
    w, h = src.size
    scale = min(L_SCALE, L_CAP / max(w, h))
    scale = max(scale, 1.0)
    out = src.convert("RGB")
    if scale > 1.001:
        out = out.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    return sharpen(out, scale)


def make_tile(src):
    """Centre-crop to 3:4, then scale. Crops toward the TOP third rather than
    the exact centre — these are portraits and posters, and a centre crop of a
    480x270 landscape decapitates the subject."""
    w, h = src.size
    want = T_W / T_H
    if w / h > want:                      # too wide -> trim the sides
        nw = round(h * want)
        left = (w - nw) // 2
        box = (left, 0, left + nw, h)
    else:                                 # too tall -> trim the bottom harder
        nh = round(w / want)
        top = max(0, round((h - nh) * 0.35))
        box = (0, top, w, top + nh)
    cut = src.convert("RGB").crop(box)
    scale = T_W / cut.size[0]
    out = cut.resize((T_W, T_H), Image.LANCZOS)
    return sharpen(out, scale)


def kb(n):
    return f"{n / 1024:.0f} KB"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    only = {s for s in args.only.split(",") if s}

    docs = fetch_categories()
    print(f"{len(docs)} categories\n")
    before = after = 0
    rows = []
    for d in docs:
        cid = d["name"].rsplit("/", 1)[-1]
        if only and cid not in only:
            continue
        nm = (d.get("fields", {}).get("name") or {}).get("stringValue", "")
        src, where = source_image(cid, d.get("fields", {}))
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
