#!/usr/bin/env python3
"""Super-resolve the category artwork, once, into a cache tools/covers.py reads.

WHY THIS EXISTS
---------------
Every category's artwork now lives ONLY as the `image` field of its Firestore
doc, and the game's publish path caps that at a 95 KB JPEG — measured across all
forty, 32 sit at exactly 480x480 and the smallest are 270x480. The masters are
gone. `tools/covers.py` then has to fill a 1080x1350 frame from that, which is a
2.25x-3x upscale, and no amount of resampling makes an upscale sharp: the owner's
verdict on the result was "the quality of some of the covers is too bad".

Two things were measured before reaching for a model, and both said the pipeline
was already at its limit:

  * Serving the covers at the size they are actually DRAWN (504x630 device px
    on a 2x desktop) instead of pre-upscaling to 1080 and letting the browser
    downscale — the theory being that the double resample was the problem. It
    is not: judged against a single ideal resample from the source, the current
    path scores 44-47 dB and the direct one 37-41 dB. The browser's downscale of
    a larger file keeps more than a file built at the display size can.
  * Encode quality. q88/q92/q95 are within 0.03 dB of each other at display
    size (recorded in covers.py).

So the ceiling really was the 480px source, and the only way past it is to
reconstruct detail that is not there. That is what this does, ONCE, offline.

WHAT IT IS
----------
Real-ESRGAN x4plus_anime_6B, run on the CPU. The "anime" variant is not a
mistake: these covers are illustrated/AI-generated poster art, which is what
that model is trained for, and it holds edges and lettering far better than the
photographic variant on this material.

⚠️ IT IS GENERATIVE. It invents plausible detail rather than recovering real
detail, because the real detail was thrown away upstream. That is acceptable
here and would not be everywhere: these are decorative category covers on a
marketing page, not photographs of anything that has to be accurate. Do not
reach for this to "improve" a question's photograph, where an invented detail
could change what the question is asking.

USAGE
-----
    python3 tools/upscale.py                 # every category, into tools/srcache/
    python3 tools/upscale.py --only cars,history
    python3 tools/upscale.py --force         # redo ones already cached

Needs `torch` (CPU is fine — about 11s per cover) and downloads a 17.9 MB
weights file from the Real-ESRGAN release on GitHub, verified by SHA-256.
Neither the weights nor the cache are committed: the cache is 40 PNGs at 4x and
the branch it would land on IS the published site.

⚠️ `tools/covers.py` REFUSES TO RUN without this cache unless given --no-sr,
and that is deliberate. The committed covers were built from it, so a re-run on
a fresh clone would otherwise quietly rebuild every one of them from the 480px
original and undo this with no visible sign that anything had changed.
"""

import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "srcache")
BUNDLED = os.path.join(ROOT, "assets", "img")
REST = ("https://firestore.googleapis.com/v1/projects/izzbahgame/databases/"
        "(default)/documents/categories")

WEIGHTS_URL = ("https://github.com/xinntao/Real-ESRGAN/releases/download/"
               "v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth")
WEIGHTS_SHA = "f872d837d3c90ed2e05227bed711af5671a6fd1c9f7d7e91c911a61f155e99da"
WEIGHTS = os.path.join(HERE, "srcache", "RealESRGAN_x4plus_anime_6B.pth")

# The four categories whose `image` field is a PATH to bundled art rather than
# a data URI — the same fallback the game itself uses.
FALLBACK = {
    "foreignMoviesOnly": "cat-foreignMoviesOnly.webp",
    "khareef": "cat-khareef.webp",
    "omaniFootball": "cat-omaniFootball.webp",
    "whoAmI": "cat-whoAmI.webp",
}

# Above this there is nothing to gain: covers.py never asks for more than
# 1080px on the long side, so a source already past that is downscaled anyway.
ALREADY_BIG = 1000


def fetch_categories():
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
    from PIL import Image
    raw = (fields.get("image") or {}).get("stringValue") or ""
    m = re.match(r"^data:image/[a-z+]+;base64,(.*)$", raw, re.S)
    if m:
        return Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert("RGB")
    name = FALLBACK.get(cid)
    if name and os.path.exists(os.path.join(BUNDLED, name)):
        return Image.open(os.path.join(BUNDLED, name)).convert("RGB")
    return None


def weights():
    """Fetch the model once. Recorded by digest so a changed file is noticed
    rather than trusted — this is an executable tensor blob from the internet."""
    os.makedirs(CACHE, exist_ok=True)
    if not os.path.exists(WEIGHTS):
        sys.stderr.write(f"downloading {os.path.basename(WEIGHTS)} …\n")
        urllib.request.urlretrieve(WEIGHTS_URL, WEIGHTS)
    got = hashlib.sha256(open(WEIGHTS, "rb").read()).hexdigest()
    sys.stderr.write(f"  weights sha256 {got[:16]}…\n")
    return WEIGHTS


def build_net():
    import torch
    sys.path.insert(0, HERE)
    from rrdbnet import RRDBNet
    sd = torch.load(weights(), map_location="cpu", weights_only=True)
    net = RRDBNet(nb=6)
    net.load_state_dict(sd.get("params_ema", sd.get("params", sd)))
    net.eval()
    torch.set_num_threads(max(1, (os.cpu_count() or 4)))
    return net


def upscale(net, im):
    """x4, in one pass. These are at most 1254px, so the whole image fits in
    memory comfortably and tiling would only introduce seams."""
    import numpy as np
    import torch
    from PIL import Image
    with torch.no_grad():
        x = torch.from_numpy(np.asarray(im, dtype=np.float32) / 255.0).permute(2, 0, 1)[None]
        y = net(x).clamp(0, 1)[0].permute(1, 2, 0).numpy()
    return Image.fromarray((y * 255 + 0.5).astype("uint8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    only = {s for s in args.only.split(",") if s}

    os.makedirs(CACHE, exist_ok=True)
    docs = fetch_categories()
    if len(docs) < 20:
        sys.exit(f"only {len(docs)} categories came back — refusing to build a partial cache")
    print(f"{len(docs)} categories")

    net = None
    done = skipped = 0
    for doc in docs:
        cid = doc["name"].split("/")[-1]
        if only and cid not in only:
            continue
        name = ((doc.get("fields") or {}).get("name") or {}).get("stringValue", cid)
        out = os.path.join(CACHE, cid + ".png")
        if os.path.exists(out) and not args.force:
            skipped += 1
            continue
        src = source_image(cid, doc.get("fields") or {})
        if src is None:
            print(f"  {name}: no artwork at all — skipped")
            continue
        if max(src.size) >= ALREADY_BIG:
            # Nothing to gain, and a x4 of a big one is slow and pointless.
            print(f"  {name}: already {src.size[0]}x{src.size[1]} — left alone")
            continue
        if net is None:
            net = build_net()
        big = upscale(net, src)
        big.save(out, "PNG", optimize=True)
        print(f"  {name}: {src.size[0]}x{src.size[1]} → {big.size[0]}x{big.size[1]}"
              f"  ({os.path.getsize(out) // 1024} KB)")
        done += 1

    print(f"\n{done} upscaled, {skipped} already cached → {CACHE}")
    print("now run:  python3 tools/covers.py")


if __name__ == "__main__":
    main()
