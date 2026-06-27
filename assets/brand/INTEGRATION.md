# عَزْبَة (Ezbah) — logo integration kit

Everything you need to apply the logo across the whole game — from the favicon
to the **final/results screen**. Copy this `dist/` folder into your game project
(e.g. `public/brand/` for web, `assets/brand/` for Flutter/Unity) and adjust the
paths in the snippets below to match where you put it.

---

## 1. What's in the kit

```
svg/                         Source vectors (scale forever, no font needed)
  Ezbah-Primary.svg          emblem + wordmark + tagline (cream)
  Ezbah-Lockup.svg           horizontal: wordmark · divider · tent (cream)
  Ezbah-Lockup-Transparent   same lockup, no background (for any colour header)
  Ezbah-Mark.svg             tent icon only (transparent)
  Ezbah-Reverse.svg          white-on-red emblem + wordmark
  Ezbah-AppIcon.svg          rounded red app tile
  Ezbah-Icon-Square.svg      full-bleed red square (maskable / Apple touch)
png/
  app-icon/  icon-16…1024.png (rounded), maskable-180…1024.png (full-bleed)
  mark/      mark-128…1024.png (transparent)
  primary/   primary@1x/2x/3x.png (cream)
  lockup/    lockup@1x/2x/3x.png + lockup-transparent@1x/2x/3x.png
  reverse/   reverse@1x/2x/3x.png (red)
  social/    og-image (1200×630), splash-portrait (1536×2048), splash-landscape
favicon.ico                  multi-res 16/32/48/64
manifest.webmanifest         PWA install metadata
brand.css                    colour tokens (CSS variables)
```

**Prefer the SVGs** wherever the platform supports them (web, Flutter via
`flutter_svg`) — they stay razor-sharp at any size. Use the PNGs for favicons,
native app icons, store listings, and anywhere raster is required.

## 2. Brand colours

| Token | Hex | Use |
|-------|-----|-----|
| `--ezbah-cream` | `#F3E1C0` | primary background |
| `--ezbah-cream-light` | `#FBF1DE` | reverse text / stripes |
| `--ezbah-red` | `#9E1C1C` | brand red, theme colour |
| `--ezbah-red-deep` | `#7A1414` | shadows / ridge |
| `--ezbah-ink` | `#2E0707` | deepest brown |
| `--ezbah-olive` | `#6E7B3C` | tagline |
| `--ezbah-gold` | `#E8A93B` | flame |

`@import "brand.css";` to get these as CSS variables.

---

## 3. Web (HTML / React)

### 3a. Favicon + PWA — put in `<head>`
```html
<link rel="icon" href="/brand/favicon.ico" sizes="any">
<link rel="icon" type="image/svg+xml" href="/brand/svg/Ezbah-AppIcon.svg">
<link rel="apple-touch-icon" href="/brand/png/app-icon/maskable-180.png">
<link rel="manifest" href="/brand/manifest.webmanifest">
<meta name="theme-color" content="#9E1C1C">
<!-- social share -->
<meta property="og:image" content="/brand/png/social/og-image.png">
<meta name="twitter:card" content="summary_large_image">
```

### 3b. App header / top bar — the horizontal lockup
```html
<header class="ezbah-header">
  <img src="/brand/svg/Ezbah-Lockup.svg" alt="عَزْبَة" height="56">
</header>
```
```css
.ezbah-header{ display:flex; align-items:center; height:72px;
  padding:0 20px; background:var(--ezbah-cream); }
/* On a red/dark header use the transparent lockup instead: */
/*   src="/brand/svg/Ezbah-Lockup-Transparent.svg"            */
```

### 3c. Splash / loading screen — the primary emblem
```html
<div class="ezbah-splash">
  <img src="/brand/svg/Ezbah-Primary.svg" alt="عَزْبَة" width="320">
</div>
```
```css
.ezbah-splash{ position:fixed; inset:0; display:grid; place-items:center;
  background:var(--ezbah-cream);
  animation:ezbah-fade .4s ease both; }
.ezbah-splash img{ width:min(60vw,360px); height:auto;
  animation:ezbah-rise .6s cubic-bezier(.2,.7,.2,1) both; }
@keyframes ezbah-rise{ from{opacity:0; transform:translateY(12px) scale(.96)} }
@keyframes ezbah-fade{ from{opacity:0} }
```

### 3d. Final / results / “game over” screen
The reverse emblem on the brand red reads as a celebratory end card. Put the
score/winner under it.
```html
<section class="ezbah-final" dir="rtl">
  <img src="/brand/svg/Ezbah-Reverse.svg" alt="عَزْبَة" width="260">
  <h1 class="ezbah-final__title">انتهت اللعبة</h1>
  <p class="ezbah-final__winner">الفائز: <strong>{{winner}}</strong></p>
  <button class="ezbah-btn">العب مرة أخرى</button>
</section>
```
```css
.ezbah-final{ position:fixed; inset:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:18px;
  background:var(--ezbah-red); color:var(--ezbah-cream-light);
  text-align:center; padding:32px; }
.ezbah-final img{ width:min(55vw,280px); height:auto;
  filter:drop-shadow(0 6px 24px rgba(0,0,0,.25));
  animation:ezbah-pop .5s cubic-bezier(.2,.8,.2,1) both; }
.ezbah-final__title{ font-size:clamp(24px,6vw,40px); margin:8px 0 0;
  letter-spacing:.02em; }
.ezbah-final__winner{ font-size:clamp(16px,4vw,22px); opacity:.92; margin:0; }
.ezbah-btn{ margin-top:10px; padding:12px 28px; border:0; border-radius:999px;
  background:var(--ezbah-cream-light); color:var(--ezbah-red);
  font-size:18px; font-weight:700; cursor:pointer; }
.ezbah-btn:hover{ background:#fff; }
@keyframes ezbah-pop{ from{opacity:0; transform:scale(.85)} }
```

### 3e. React — one component for all placements
```jsx
// EzbahLogo.jsx  —  <EzbahLogo variant="reverse" height={260} />
const SRC = {
  primary:   "/brand/svg/Ezbah-Primary.svg",
  lockup:    "/brand/svg/Ezbah-Lockup.svg",
  lockupT:   "/brand/svg/Ezbah-Lockup-Transparent.svg",
  mark:      "/brand/svg/Ezbah-Mark.svg",
  reverse:   "/brand/svg/Ezbah-Reverse.svg",
};
export default function EzbahLogo({ variant = "primary", alt = "عَزْبَة", ...rest }) {
  return <img className="ezbah-logo" src={SRC[variant]} alt={alt} {...rest} />;
}
```
> Want it inline (animatable/themeable via CSS `fill`)? Use `vite-plugin-svgr` /
> `@svgr/webpack` to import the SVG as a component instead of an `<img>`.

---

## 4. Flutter / native mobile

- **App icon:** point `flutter_launcher_icons` at `png/app-icon/icon-1024.png`
  (`adaptive_icon_foreground: maskable-1024.png`, `background_color: "#9E1C1C"`).
  iOS: drop `icon-1024.png` into the AppIcon set.
- **In-app:** add `flutter_svg` and load `svg/Ezbah-Primary.svg` /
  `Ezbah-Reverse.svg` with `SvgPicture.asset(...)`.
- **Splash:** `flutter_native_splash` → `color: "#F3E1C0"`,
  `image: png/primary/primary@3x.png`.

## 5. Unity / game engine

Import the `png/` files as Sprites (no compression, “Sprite (2D and UI)”). Use
`reverse@3x` for the win screen, `primary@3x` for the title, `mark-1024` where
you need just the icon. Match the camera/clear colour to `#F3E1C0` or `#9E1C1C`.

---

## 6. Placement cheat-sheet

| Screen | Asset |
|--------|-------|
| Browser tab / PWA install | `favicon.ico`, `app-icon/*`, `maskable-*` |
| Title / splash / loading | `Ezbah-Primary.svg` (or `primary@3x.png`) |
| In-game header / HUD | `Ezbah-Lockup.svg` (transparent on colour) |
| Small icon / watermark | `Ezbah-Mark.svg` |
| **Final / results / game-over** | `Ezbah-Reverse.svg` on `--ezbah-red` |
| Social / share card | `social/og-image.png` |

All vectors are font-independent (Arabic baked to outlines), so they render
identically with nothing to install. Regenerate any time from
`../_fonts/build_svgs.py` + `../_fonts/export.py`.
