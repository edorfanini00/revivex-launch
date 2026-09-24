#!/bin/bash
# v11 mobile set: native portrait compositions so phones never upscale a crop of desktop art.
HF=~/.nvm/versions/node/v20.20.2/bin/higgsfield
SITE=/Users/edorfanini/Projects/revivex-appliance-launch/site
REF=$SITE/gen-machine-ref.png
OUT=$SITE/gen-v11m
mkdir -p "$OUT"
STYLE="Art direction matching the Revivex health brand: cool, calm, desaturated palette of fog gray, soft slate blue-gray and warm off-white; soft overcast daylight, pale honed concrete and light stone, minimalist modern architecture, quiet and premium like a high-end longevity clinic. Photoreal, medium format, crisp detail, gentle depth of field. The machine is the exact same brushed aluminum countertop appliance from the reference image: same shape, same dark screen, same round dial, same open dispensing bay, same slotted drip tray. Any drink is completely clear, colorless water. No added text or logos, no warm pink or beige cast."

run () { # name aspect prompt
  $HF generate create nano_banana_pro --json --no-color --wait --wait-timeout 10m \
    --aspect_ratio "$2" --resolution 2k --image "$REF" --prompt "$3 $STYLE" > "$OUT/$1.json" 2>&1
  URL=$(python3 -c "import json;d=json.load(open('$OUT/$1.json'));print(d[0]['result_url'])" 2>/dev/null)
  [ -n "$URL" ] && curl -s "$URL" -o "$OUT/$1.png" && echo "$1 OK" || { echo "$1 FAIL"; head -c 300 "$OUT/$1.json"; }
}

run hero-start-m 9:16 "Vertical phone-format hero. The machine stands centered in the upper-middle of the frame on a pale honed concrete counter, straight-on front view at bay height, filling about 60 percent of the frame width, in a minimalist fog-gray room with a tall soft window behind. An empty clear glass tumbler sits in the dispensing bay. Screen shows 'Morning' and 'Ready'. The bottom 35 percent of the frame is calm concrete counter front and soft shadow, empty, for text overlay. The top 12 percent is plain soft wall." &
run hero-end-m 9:16 "Identical vertical composition, camera and light: the machine centered in the upper-middle on a pale honed concrete counter, straight-on at bay height, filling about 60 percent of the frame width, fog-gray room with tall soft window behind. The clear glass tumbler in the bay is now full of crystal clear still water, faint caustics on the concrete. Screen shows 'Done'. Bottom 35 percent calm empty concrete counter front for text. Top 12 percent plain soft wall." &
run lifestyle-kitchen-m 2:3 "Vertical lifestyle portrait: a calm woman in a neutral taupe linen top in a minimalist modern kitchen with floor-to-ceiling windows and a soft misty city skyline at dawn, lifting a glass of clear water from the machine on the concrete counter. Cool blue-gray morning light, serene, face in soft profile. Lower third of frame is calm and darker for text." &
run lifestyle-desk-m 2:3 "Vertical lifestyle portrait: a man in a neutral gray t-shirt on a concrete terrace at dawn with a misty skyline, holding a clear glass of water, the machine softly out of focus on a stone ledge beside him. Cool slate blue sky. Lower third calm for text." &
wait
echo ALL_DONE
ls -la "$OUT"
