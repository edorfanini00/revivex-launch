#!/bin/bash
HF=~/.nvm/versions/node/v20.20.2/bin/higgsfield
SITE=/Users/edorfanini/Projects/revivex-appliance-launch/site
OUT=$SITE/gen-v20/higgs
mkdir -p "$OUT"
REF1=$SITE/gen-v20/blender/hero_front.png
REF2=$SITE/gen-v20/blender/screen_macro.png
BASE="Use the reference as exact product geometry: a black graphite metal countertop supplement blending machine with a large glass touchscreen, open dispensing bay, slim horizontal dispensing slot, metal frame, and clear glass tumbler. No manual dial, no knobs, no colored drink, no green liquid. The drink is clear water only. Premium black-on-black product photography like Linc: dark studio, hard softbox spotlight, brushed metal highlights, cinematic contrast, clean modern Fortune 500 wellness technology, photoreal, no extra text except simple screen UI."
run(){
  name=$1; aspect=$2; prompt=$3; shift 3
  $HF generate create nano_banana_pro --json --no-color --wait --wait-timeout 10m --aspect_ratio "$aspect" --resolution 2k --image "$REF1" --image "$REF2" --prompt "$prompt $BASE" > "$OUT/$name.json" 2>&1
  url=$(python3 -c "import json;print(json.load(open('$OUT/$name.json'))[0]['result_url'])" 2>/dev/null)
  if [ -n "$url" ]; then curl -s "$url" -o "$OUT/$name.png" && echo "$name OK"; else echo "$name FAIL"; head -c 500 "$OUT/$name.json"; fi
}
run hero-dark 16:9 "Hero product shot: the full machine centered on a black stone plinth, frontal view, screen glowing softly with four minimal tiles: Sleep, Recovery, Stress, Blend. Clear tumbler in the bay with transparent glass and clear water, not white opaque. Lots of negative black space for website headline on the left." &
run hero-dark-m 9:16 "Vertical phone hero: the full machine centered lower half on a black stone plinth, large touchscreen glowing, clear transparent tumbler in the bay with clear water, dramatic black background and spotlight, clean space above and lower left for text." &
run screen-close 4:5 "Macro close-up of the large glass touchscreen and dispensing bay, premium metal edges and screen reflections, minimal screen tiles: Sleep, Recovery, Stress, Blend. The screen is the hero, no physical buttons." &
run pour-close 4:5 "Close-up of the slim horizontal dispensing slot pouring a clear water stream into a transparent glass tumbler inside the black metal bay. Clear colorless water only. No opaque white cup." &
run lifestyle-dark 16:9 "Elegant kitchen/living room at night with black stone counter and city lights out of focus. The black metal machine sits on the counter as a luxury appliance, screen softly glowing, clear glass in bay, cinematic premium." &
run lifestyle-dark-m 9:16 "Vertical elegant kitchen/living room at night with black stone counter and city lights out of focus. The black metal machine sits in lower half as a luxury appliance, screen softly glowing, clear glass in bay, cinematic premium." &
wait
echo ALL_DONE
ls "$OUT"/*.png | wc -l
