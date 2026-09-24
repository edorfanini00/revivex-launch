#!/bin/bash
# v14: full-bleed cinematic scenes in the healthrevivex style (glass UI is added in HTML, not baked in).
HF=~/.nvm/versions/node/v20.20.2/bin/higgsfield
SITE=/Users/edorfanini/Projects/revivex-appliance-launch/site
REF=$SITE/gen-machine-ref.png
OUT=$SITE/gen-v14
mkdir -p "$OUT"
LOOK="Cinematic editorial photograph, luxury high-rise apartment, floor-to-ceiling windows with a hazy city skyline and soft mountains in the distance, cool blue-gray morning light, desaturated slate and fog tones with warm oak and pale stone accents, soft haze, medium format, natural skin texture, candid, calm, aspirational. No text, no logos, no screens with readable text, no UI overlays."
MACHINE="The appliance is the exact brushed aluminum countertop machine from the reference image: same boxy shape, dark screen, round dial, open dispensing bay and slotted drip tray. Any drink is completely clear colorless water in a clear glass."

gen () { # name aspect useRef prompt
  local ref=(); [ "$3" = "1" ] && ref=(--image "$REF")
  $HF generate create nano_banana_pro --json --no-color --wait --wait-timeout 10m --aspect_ratio "$2" --resolution 2k "${ref[@]}" --prompt "$4" > "$OUT/$1.json" 2>&1
  URL=$(python3 -c "import json;print(json.load(open('$OUT/$1.json'))[0]['result_url'])" 2>/dev/null)
  [ -n "$URL" ] && curl -s "$URL" -o "$OUT/$1.png" && echo "$1 OK" || { echo "$1 FAIL"; head -c 300 "$OUT/$1.json"; }
}

# 1. Connect: athletic man on a terrace, subject right third, open sky left for text
gen s1-connect 16:9 0 "A fit man in his thirties in a gray t-shirt holding a plank on a yoga mat on a high-rise concrete terrace at dawn, wearing a fitness band and a smart ring, city skyline and mountains behind in soft haze, he is on the right third of the frame, open calm sky and space on the left half. $LOOK" &
gen s1-connect-m 9:16 0 "Vertical: a fit man in his thirties in a gray t-shirt holding a plank on a yoga mat on a high-rise concrete terrace at dawn, wearing a fitness band and smart ring, city skyline and mountains in soft haze, the man in the lower half of the frame, open calm sky in the upper half. $LOOK" &
# 2. Routine set: woman with phone in a lounge chair, subject left, space right for a notification card
gen s2-routine 16:9 0 "A woman in her late thirties in a cream linen shirt sitting in a modern lounge chair by the window, looking down at her phone held low so the screen is not visible, relaxed, subject on the left third, calm open space on the right half. $LOOK" &
gen s2-routine-m 9:16 0 "Vertical: a woman in her late thirties in a cream linen shirt sitting in a modern lounge chair by a tall window, looking down at her phone held low so the screen is not visible, subject in the lower half, calm space above. $LOOK" &
# 3. The machine at home: machine on a stone kitchen island, skyline view, woman softly out of focus behind
gen s3-machine 16:9 1 "The machine sits on a pale stone kitchen island on the right third of the frame, a full clear glass of water in its bay, a small ceramic vase with eucalyptus beside it, the window behind shows a hazy skyline and mountains, calm open space on the left half. $MACHINE $LOOK" &
gen s3-machine-m 9:16 1 "Vertical: the machine on a pale stone kitchen island in the lower half of the frame, a full clear glass of water in its bay, a ceramic vase with eucalyptus beside it, the tall window behind shows a hazy skyline and mountains, calm space above. $MACHINE $LOOK" &
wait
echo ALL_DONE; ls "$OUT"/*.png | wc -l
