#!/bin/bash
# v10 art direction: one machine, warm blush daylight, clear water only.
HF=~/.nvm/versions/node/v20.20.2/bin/higgsfield
REF=/Users/edorfanini/Projects/revivex-appliance-launch/site/gen-machine-ref.png
OUT=/Users/edorfanini/Projects/revivex-appliance-launch/site/gen-v10
mkdir -p "$OUT"
STYLE="Art direction: warm blush sand seamless studio sweep, color #EFE3DE to #F6EDEA, soft diffused north window daylight from the left, gentle long soft shadow, subtle film grain, shot on Hasselblad 80mm, calm Scandinavian wellness brand campaign like Aesop or Seed. The machine is the exact same brushed aluminum appliance from the reference image: same shape, same dark OLED screen, same round dial, same open dispensing bay, same slotted drip tray. The drink is always completely clear transparent water, never colored, no green, no yellow, no milk. No text other than what is on the screen, no logos added, no people unless described."

run () { # name aspect prompt
  $HF generate create nano_banana_pro --json --no-color --wait --wait-timeout 10m \
    --aspect_ratio "$2" --resolution 2k --image "$REF" --prompt "$3 $STYLE" > "$OUT/$1.json" 2>&1
  URL=$(python3 -c "import json;d=json.load(open('$OUT/$1.json'));print(d[0]['result_url'])" 2>/dev/null)
  [ -n "$URL" ] && curl -s "$URL" -o "$OUT/$1.png" && echo "$1 OK" || echo "$1 FAIL"
}

run hero-start 16:9 "Wide product shot. The machine stands slightly right of center on a pale travertine plinth, straight-on front view, camera at bay height. An empty clear glass tumbler sits in the dispensing bay. Screen shows 'Morning' and 'Ready'. Generous empty space on the left third for headline text." &
run hero-end 16:9 "Identical composition, camera and lighting to a straight-on wide product shot: the machine stands slightly right of center on a pale travertine plinth, camera at bay height. The clear glass tumbler in the bay is now full of crystal clear still water, the final thin clear stream just ending from the nozzle, a few light caustics on the plinth. Screen shows 'Done'. Generous empty space on the left third." &
run detail-screen 4:5 "Macro close-up of the machine's dark OLED screen and round brushed aluminum dial, shallow depth of field, screen shows minimal white text 'Morning' with a thin progress line. Brushed metal grain visible." &
run detail-pour 4:5 "Macro close-up inside the dispensing bay: a smooth glassy stream of crystal clear water pours from the aluminum nozzle into a clear glass tumbler, light refracting through the water, tiny bubbles, drip tray slots soft in foreground." &
run lifestyle-counter 4:5 "Lifestyle: the machine on a light oak kitchen counter in a calm sunlit home kitchen, morning sun raking across the counter, a woman's hand (no face) lifting the glass of clear water from the bay, linen sleeve, soft plant shadow on the wall. Background softly out of focus, warm blush wall." &
run detail-tank 4:5 "Three-quarter rear view: a hand lifting the removable clear water tank out of the top rear of the machine to refill it, no hoses, no plumbing, clean countertop, tank is transparent with clear water inside." &
wait
echo ALL_DONE
ls -la "$OUT"
