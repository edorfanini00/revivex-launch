"""Integrate only real v2 exports, after ffmpeg decode. Never falls back to v1."""
from pathlib import Path
import json, subprocess, shutil, hashlib
root=Path(__file__).resolve().parents[1]
source=root.parent/'film-v2/export'
assets=root/'public/assets'
inputs={'loop':('hero-loop.mp4','hero-loop-v2.mp4'),'film':('revivex-appliance-preview-v2.mp4','revivex-film-v2.mp4')}
for original,_ in inputs.values():
    path=source/original
    if not path.is_file() or not path.stat().st_size:
        raise SystemExit(f'V2 export not ready: {path}. Existing still-based page remains unchanged.')
    subprocess.run(['ffmpeg','-v','error','-i',str(path),'-f','null','-'],check=True)
manifest=json.loads((assets/'media-v2.json').read_text())
provenance={}
for key,(original,destination) in inputs.items():
    shutil.copy2(source/original,assets/destination)
    manifest[key]='/assets/'+destination
    provenance[key]={'source':str(source/original),'sha256':hashlib.sha256((assets/destination).read_bytes()).hexdigest()}
(assets/'media-v2.json').write_text(json.dumps(manifest,indent=2)+'\n')
(root/'evidence/media-integration.json').write_text(json.dumps(provenance,indent=2)+'\n')
print('Integrated decoded v2 exports. Run npm run build, npm run qa and node scripts/media-qa.mjs; inspect moving hero desktop/mobile before claiming acceptance.')
