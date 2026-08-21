#!/usr/bin/env python3
"""Build the app-store icon and splash sources from the brand master.

    python3 tools/appicons.py            # write mobile/assets/
    python3 tools/appicons.py --check    # verify without writing

Outputs `mobile/assets/icon.png` (1024x1024) and `mobile/assets/splash.png`
(2732x2732), the two files `@capacitor/assets` expands into every iOS and
Android size:

    cd mobile && npx @capacitor/assets generate

⚠️ NO ALPHA, EVER, in the 1024 icon. Apple rejects an App Store icon with an
alpha channel, and it is the kind of rejection that costs a whole review cycle
for a one-line fix. The master happens to be RGB already, but this script
flattens onto BG regardless so a future master with transparency cannot
reintroduce it silently.

⚠️ NO ROUNDED CORNERS, and no drop shadow. Both platforms apply their own mask;
baking one in gives a visibly double-rounded icon.

⚠️ The master is 1254px, so the icon is a DOWNscale — good. If the master is
ever replaced with something smaller than 1024 this script refuses rather than
upscaling: an App Store icon is the single most-scrutinised image in the
listing, and a soft one reads as amateur at a glance.
"""
import sys, os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MASTER = os.path.join(ROOT, "assets", "brand", "izzbah-logo-src.png")
OUTDIR = os.path.join(ROOT, "mobile", "assets")

# The app's own background — `background_color` in the manifest, and what the
# master's own corners already sit at, so the composite is seamless.
BG = (0x3A, 0x0A, 0x0D)

ICON = 1024          # App Store / Play listing icon
SPLASH = 2732        # @capacitor/assets' square source for every launch screen
SPLASH_LOGO = 1000   # the mark's size within it; the rest is background


def load_master():
    im = Image.open(MASTER)
    if min(im.size) < ICON:
        sys.exit(f"appicons: master is {im.size[0]}x{im.size[1]}, smaller than "
                 f"{ICON}px — refusing to upscale the App Store icon.")
    return im


def flatten(im):
    """RGB on BG. A no-op for today's master; the guard is for tomorrow's."""
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        base = Image.new("RGB", im.size, BG)
        base.paste(im, mask=im.getchannel("A"))
        return base
    return im.convert("RGB")


def build():
    src = flatten(load_master())
    icon = src.resize((ICON, ICON), Image.LANCZOS)
    splash = Image.new("RGB", (SPLASH, SPLASH), BG)
    mark = src.resize((SPLASH_LOGO, SPLASH_LOGO), Image.LANCZOS)
    off = (SPLASH - SPLASH_LOGO) // 2
    splash.paste(mark, (off, off))
    return icon, splash


def main():
    check = "--check" in sys.argv
    icon, splash = build()
    for name, im in (("icon.png", icon), ("splash.png", splash)):
        path = os.path.join(OUTDIR, name)
        if check:
            if not os.path.exists(path):
                sys.exit(f"appicons: {name} is missing — run without --check")
            have = Image.open(path)
            if have.size != im.size or have.mode != "RGB":
                sys.exit(f"appicons: {name} is {have.size} {have.mode}, "
                         f"expected {im.size} RGB")
            print(f"ok  {name}  {have.size[0]}x{have.size[1]} {have.mode}")
            continue
        os.makedirs(OUTDIR, exist_ok=True)
        im.save(path, "PNG", optimize=True)
        kb = os.path.getsize(path) // 1024
        print(f"wrote mobile/assets/{name}  {im.size[0]}x{im.size[1]} {im.mode}  {kb} KB")


if __name__ == "__main__":
    main()
