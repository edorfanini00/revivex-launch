#!/bin/bash
# v11: healthrevivex brand palette — cool fog, slate blue-gray, soft overcast daylight, concrete + stone.
HF=~/.nvm/versions/node/v20.20.2/bin/higgsfield
SITE=/Users/edorfanini/Projects/revivex-appliance-launch/site
REF=$SITE/gen-machine-ref.png
OUT=$SITE/gen-v11
mkdir -p "$OUT"
STYLE="Art direction matching the Revivex health brand: cool, calm, desaturated palette of fog gray, soft slate blue-gray and warm off-white; soft overcast daylight from large windows, pale concrete and light stone surfaces, minimalist modern architecture, quiet and premium like a high-end longevity clinic. Photoreal, shot on medium format, gentle depth of field, subtle grain. The machine is the exact same brushed aluminum countertop appliance from the reference image: same shape, same dark screen, same round dial, same open dispensing bay, same slotted drip tray. Any drink is completely clear, colorless water. No added text or logos, no warm pink or beige cast, no orange tint."

run () { # name aspect prompt
  $HF generate create nano_banana_pro --json --no-color --wait --wait-timeout 10m \
    --aspect_ratio "$2" --resolution 2k --image "$REF" --prompt "$3 $STYLE" > "$OUT/$1.json" 2>&1
  URL=$(python3 -c "import json;d=json.load(open('$OUT/$1.json'));print(d[0]['result_url'])" 2>/dev/null)
  [ -n "$URL" ] && curl -s "$URL" -o "$OUT/$1.png" && echo "$1 OK" || { echo "$1 FAIL"; head -c 300 "$OUT/$1.json"; }
}

run hero-start 16:9 "Wide hero shot. The machine stands on a pale honed concrete counter, slightly right of center, straight-on front view at bay height, in a minimalist fog-gray room with a large soft window behind. An empty clear glass tumbler sits in the dispensing bay. Screen shows 'Morning' and 'Ready'. The left 45 percent of the frame is calm empty wall and soft light for headline text." &
run hero-end 16:9 "Identical composition, camera and light to a wide hero shot: the machine on a pale honed concrete counter, slightly right of center, straight-on at bay height, fog-gray room with large soft window behind. The clear glass tumbler in the bay is now full of crystal clear still water, the last thin clear stream ending from the nozzle, faint caustics on the concrete. Screen shows 'Done'. The left 45 percent is calm empty wall." &
run detail-screen 4:5 "Macro close-up of the machine's dark screen and round brushed aluminum dial, shallow depth of field, screen shows minimal white text 'Morning' with a thin progress line. Cool daylight, brushed metal grain visible." &
run detail-pour 4:5 "Macro close-up inside the dispensing bay: a smooth glassy stream of crystal clear water pours from the aluminum nozzle into a clear glass tumbler, light refracting through the water, tiny bubbles, cool overcast light." &
run detail-tank 4:5 "Three-quarter rear view: a hand lifting the removable transparent water tank out of the top rear of the machine to refill it, no hoses, no plumbing, pale concrete counter, cool daylight." &
run lifestyle-kitchen 16:9 "Wide lifestyle: a calm woman in a neutral taupe linen top stands in a minimalist modern kitchen with floor-to-ceiling windows overlooking a soft misty city skyline at dawn. She lifts the glass of clear water from the machine on the concrete counter. Cool blue-gray morning light, serene, her face in soft profile." &
run lifestyle-desk 4:5 "Lifestyle: a man in a neutral gray t-shirt on a concrete terrace at dawn with a misty skyline, holding a clear glass of water, the machine softly out of focus on a stone ledge beside him. Cool, serene, slate blue sky." &
wait
echo ALL_DONE
ls -la "$OUT"
