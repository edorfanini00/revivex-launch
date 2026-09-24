#!/bin/bash
# v13: image-led sections (Mos Health style). 4:5 works on desktop cards AND phones natively.
HF=~/.nvm/versions/node/v20.20.2/bin/higgsfield
SITE=/Users/edorfanini/Projects/revivex-appliance-launch/site
REF=$SITE/gen-machine-ref.png
OUT=$SITE/gen-v13
mkdir -p "$OUT"
LOOK="Editorial wellness photography for a premium longevity brand. Cool, calm, desaturated palette: fog gray, soft slate blue-gray, warm off-white linen, pale stone and light oak. Soft natural window daylight, gentle shadows, medium format, shallow depth of field, fine grain, real skin texture, candid and unposed. No text, no logos, no brand names on anything."
MACHINE="The appliance is the exact brushed aluminum countertop machine from the reference image: same boxy shape, same dark screen, same round dial, same open dispensing bay and slotted drip tray. Any drink is completely clear, colorless water in a clear glass."

people () { # name aspect prompt   (no machine reference)
  $HF generate create nano_banana_pro --json --no-color --wait --wait-timeout 10m --aspect_ratio "$2" --resolution 2k --prompt "$3 $LOOK" > "$OUT/$1.json" 2>&1
  URL=$(python3 -c "import json;print(json.load(open('$OUT/$1.json'))[0]['result_url'])" 2>/dev/null)
  [ -n "$URL" ] && curl -s "$URL" -o "$OUT/$1.png" && echo "$1 OK" || { echo "$1 FAIL"; head -c 300 "$OUT/$1.json"; }
}
machine () { # name aspect prompt   (with machine reference)
  $HF generate create nano_banana_pro --json --no-color --wait --wait-timeout 10m --aspect_ratio "$2" --resolution 2k --image "$REF" --prompt "$3 $MACHINE $LOOK" > "$OUT/$1.json" 2>&1
  URL=$(python3 -c "import json;print(json.load(open('$OUT/$1.json'))[0]['result_url'])" 2>/dev/null)
  [ -n "$URL" ] && curl -s "$URL" -o "$OUT/$1.png" && echo "$1 OK" || { echo "$1 FAIL"; head -c 300 "$OUT/$1.json"; }
}

# Problem row
people p-wake 4:5 "A woman in her thirties sitting on the edge of a bed in white linen sheets at dawn, stretching gently, tired but calm, soft cool window light, minimalist bedroom." &
people p-data 4:5 "Close-up of a relaxed hand resting on a pale linen duvet wearing a smooth matte titanium smart ring and a slim fitness band on the wrist, a phone face down beside it, morning light." &
people p-tubs 4:5 "Still life on a pale stone kitchen counter: several plain unlabeled white supplement tubs, a plastic shaker bottle, a weekly pill organizer and loose capsules, slightly messy, muted and quiet, soft window light." &
# Ecosystem row (backgrounds for UI overlays)
#people e-move 4:5 "A man in a neutral gray t-shirt doing a slow stretch on a wooden floor by a large window at dawn, wearing a fitness band and a smart ring, serene, cool light, lots of calm space in the upper half." &
people e-phone 4:5 "A woman in a soft oatmeal knit sweater sitting by a window with a cup nearby, looking down at her phone held low so the screen is not visible, calm morning, cool soft light, calm empty space in the upper half." &
machine e-machine 4:5 "Three-quarter view of the machine on a pale travertine counter beside a small ceramic vase with a single eucalyptus sprig, a full clear glass of water in the bay, soft window light from the left, lots of calm space above." &
# Machine gallery
machine g-hero 16:9 "Wide elegant still life: the machine on a long pale travertine counter in a calm minimalist home, soft diffused window light, a linen towel, a small stack of books and a ceramic bowl with green olives far to the side, a full clear glass of water in the bay. Machine slightly right of center, generous negative space on the left." &
machine g-hero-m 4:5 "Vertical elegant still life: the machine on a pale travertine counter in a calm minimalist home, soft diffused window light, a ceramic vase with eucalyptus beside it, a full clear glass of water in the bay, machine centered in the lower two thirds." &
machine g-side 4:5 "Clean side profile of the machine on a light oak surface against a soft fog-gray wall, a single soft shadow, minimal and sculptural, like a design museum product photo." &
machine g-hand 4:5 "A woman's hand with natural nails lightly touching the round brushed aluminum dial of the machine, the dark screen softly glowing beside it, shallow depth of field, cool daylight." &
wait
echo ALL_DONE
ls "$OUT"/*.png | wc -l
