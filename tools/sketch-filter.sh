#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# sketch-filter.sh — the black-and-white "ink sketch" look: solid black
# contour lines on clean white, no greys, no colour.
#
#   ./sketch-filter.sh input.mp4 [output.mp4] [options]
#
# How it works: an eXtended Difference-of-Gaussians. The frame is blurred at
# two radii and one is subtracted from the other, which cancels out flat areas
# (grass, sky, walls stay pure white) and leaves a strong signal only where
# the image actually changes — edges. That signal is then hard-thresholded to
# ink.
#
# The frame is processed at 2× and scaled back down, so the lines come out
# anti-aliased instead of jagged. That is the difference between "looks like a
# filter" and "looks like a pen".
#
# Line weight is scaled from the video's own width, so a 4K clip and a phone
# clip come out looking the same rather than the 4K one turning into lace.
#
# Options:
#   -t, --thickness N   line weight, default 1.0. 0.6 = fine pen, 2.0 = marker
#   -d, --detail N      how much fine texture becomes ink, default 1.0.
#                       Lower = only bold outlines. Higher = crowds, foliage
#                       and fabric fill in with scribble.
#   -i, --invert        white lines on black instead
#   -q, --quality N     x264 CRF, default 18 (lower = better, 23 = smaller)
#       --fast          skip 2× supersampling (quicker, slightly harder edges)
#   -h, --help
#
# Audio is copied through untouched. Requires ffmpeg + ffprobe.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

THICK=1.0; DETAIL=1.0; INVERT=0; CRF=18; SUPERSAMPLE=2
IN=""; OUT=""

die() { printf 'sketch-filter: %s\n' "$1" >&2; exit 1; }
usage() { sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    -t|--thickness) THICK="${2:?}"; shift 2 ;;
    -d|--detail)    DETAIL="${2:?}"; shift 2 ;;
    -q|--quality)   CRF="${2:?}"; shift 2 ;;
    -i|--invert)    INVERT=1; shift ;;
    --fast)         SUPERSAMPLE=1; shift ;;
    -h|--help)      usage ;;
    -*)             die "unknown option: $1 (try --help)" ;;
    *)              if [ -z "$IN" ]; then IN="$1"; elif [ -z "$OUT" ]; then OUT="$1"; else die "too many arguments"; fi; shift ;;
  esac
done

[ -n "$IN" ] || usage
[ -f "$IN" ] || die "no such file: $IN"
command -v ffmpeg  >/dev/null || die "ffmpeg not found"
command -v ffprobe >/dev/null || die "ffprobe not found"

if [ -z "$OUT" ]; then
  case "$IN" in
    *.*) OUT="${IN%.*}-sketch.${IN##*.}" ;;
    *)   OUT="$IN-sketch.mp4" ;;
  esac
fi
[ "$IN" != "$OUT" ] || die "input and output must differ"

W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$IN" | tr -d '\r\n,')
[ -n "$W" ] && [ "$W" -gt 0 ] 2>/dev/null || die "could not read video width from $IN"

HAS_AUDIO=$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$IN" | head -1)

# Line weight relative to frame width: 0.0075 × width reproduces the reference
# at its native 478px, and holds up at any resolution. Multiplied by the
# supersample factor because the blur happens at the larger size.
SIGMA=$(awk -v w="$W" -v t="$THICK" -v s="$SUPERSAMPLE" 'BEGIN{ v=w*0.0075*t*s; if(v<0.6)v=0.6; printf "%.3f", v }')
SIGMA2=$(awk -v s="$SIGMA" 'BEGIN{ printf "%.3f", s*1.6 }')   # DoG ratio k=1.6
# Threshold on the DoG response, in 0-255 units. More negative = only the
# strongest edges survive, so raising --detail moves it toward zero.
EPS=$(awk -v d="$DETAIL" 'BEGIN{ if(d<=0)d=0.01; printf "%.3f", -1.5/d }')

SS_UP=""; SS_DOWN=""
if [ "$SUPERSAMPLE" -gt 1 ]; then
  SS_UP="scale=iw*${SUPERSAMPLE}:ih*${SUPERSAMPLE}:flags=bicubic,"
  SS_DOWN=",scale=iw/${SUPERSAMPLE}:ih/${SUPERSAMPLE}:flags=bilinear"
fi

# if(gte(A - 0.985*B, EPS), white, black) — the 0.985 keeps flat regions just
# under the line so they resolve to paper rather than noise.
EXPR="if(gte(A-0.985*B,${EPS}),255,0)"
[ "$INVERT" -eq 1 ] && EXPR="if(gte(A-0.985*B,${EPS}),0,255)"

# h264 + yuv420p cannot encode odd dimensions, and some sources (mjpeg, gif,
# screen captures) genuinely are odd — crop the stray row/column rather than
# letting the encode fail at the very end of a long render.
VF="${SS_UP}format=gray,split[a][b];[a]gblur=sigma=${SIGMA}[x];[b]gblur=sigma=${SIGMA2}[y];[x][y]blend=all_expr='${EXPR}'${SS_DOWN},crop=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"

printf 'sketch-filter: %s  (%spx wide, sigma %s, threshold %s%s)\n' \
  "$(basename "$IN")" "$W" "$SIGMA" "$EPS" "$([ "$SUPERSAMPLE" -gt 1 ] && echo ', 2x supersampled')"

set -- -v warning -stats -i "$IN" -vf "$VF" -c:v libx264 -crf "$CRF" -preset medium -pix_fmt yuv420p
if [ -n "$HAS_AUDIO" ]; then set -- "$@" -c:a copy; else set -- "$@" -an; fi
ffmpeg "$@" -movflags +faststart "$OUT" -y

printf 'sketch-filter: wrote %s\n' "$OUT"
