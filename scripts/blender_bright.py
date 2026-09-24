"""Bright wellness studio renders of the real Revivex CAD. Never saves the .blend.
Root cause of dark/brown look: brushed metal reflecting a black world. Fix = bright blush world + big softboxes."""
import bpy, os, math
SRC = "/Users/edorfanini/Projects/revivex-appliance-launch/film-v2/source/rejected-v1-archive/revivex-appliance-film.blend"
OUT = "/Users/edorfanini/Projects/revivex-appliance-launch/site/gen-v10/blender"
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=SRC)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'GPU'
sc.cycles.samples = 160
sc.cycles.use_denoising = True
sc.view_settings.view_transform = 'AgX'
sc.view_settings.look = 'AgX - Base Contrast' if 'AgX - Base Contrast' in [l for l in ['AgX - Base Contrast']] else 'None'
sc.view_settings.exposure = 0.35
sc.frame_set(1)

def rgb(h):
    h = h.lstrip('#'); c = [int(h[i:i+2], 16)/255 for i in (0, 2, 4)]
    return tuple(((x+0.055)/1.055)**2.4 if x > 0.04045 else x/12.92 for x in c) + (1.0,)
BLUSH = rgb('F3E6E1')

# World: bright blush so metal reflects warm light, not black
w = bpy.data.worlds.new("BlushWorld"); w.use_nodes = True
bg = w.node_tree.nodes['Background']; bg.inputs[0].default_value = BLUSH; bg.inputs[1].default_value = 1.1
sc.world = w

def principled(name, col, metal=0.0, rough=0.5, trans=0.0, ior=1.45):
    m = bpy.data.materials.new(name); m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = col
    p.inputs['Metallic'].default_value = metal
    p.inputs['Roughness'].default_value = rough
    if 'Transmission Weight' in p.inputs: p.inputs['Transmission Weight'].default_value = trans
    p.inputs['IOR'].default_value = ior
    return m

alum = principled("Alu", rgb('D9D8D6'), 1.0, 0.22)
# anisotropic brushed look if available
p = alum.node_tree.nodes['Principled BSDF']
if 'Anisotropic' in p.inputs: p.inputs['Anisotropic'].default_value = 0.6
glass = bpy.data.materials.new("Glass"); glass.use_nodes = True
nt = glass.node_tree; nt.nodes.clear()
o = nt.nodes.new('ShaderNodeOutputMaterial'); g = nt.nodes.new('ShaderNodeBsdfGlass')
g.inputs['Color'].default_value = (1, 1, 1, 1); g.inputs['Roughness'].default_value = 0.0; g.inputs['IOR'].default_value = 1.5
nt.links.new(g.outputs[0], o.inputs[0])
screen = bpy.data.materials.new("Screen"); screen.use_nodes = True
sp = screen.node_tree.nodes['Principled BSDF']
sp.inputs['Base Color'].default_value = rgb('141414'); sp.inputs['Roughness'].default_value = 0.08
floor_m = principled("Floor", BLUSH, 0.0, 0.85)

HIDE_KW = ['graphite', 'inner cheek', 'rear vent', 'motor', 'pump', 'valve', 'tube', 'wire', 'hopper', 'funnel',
           'ingredient', 'auger', 'gasket', 'internal', 'agitator', 'bracket', 'fitting', 'connector', 'saddle',
           'aperture', 'stud', 'nut', 'yoke', 'spring', 'captive', 'occupancy', 'hold', 'tank support', 'armature',
           'slide guide', 'carrier', 'push tip', 'blade', 'dispensing outlet', 'downspout', 'hatch', 'studio ground',
           'beverage volume', 'handle', 'ceramic']
for ob in bpy.data.objects:
    n = ob.name.lower()
    if ob.type in ('LIGHT',):
        ob.hide_render = True; continue
    if any(k in n for k in HIDE_KW):
        ob.hide_render = True; continue
    if ob.type != 'MESH' or ob.hide_render: continue
    if 'compact touch display' in n: mat = screen
    elif 'passive cup' in n or 'd74 h130' in n: mat = glass
    else: mat = alum
    ob.data.materials.clear(); ob.data.materials.append(mat)

# Floor sweep
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
fl = bpy.context.active_object; fl.data.materials.append(floor_m)
# lowest visible point → put floor there
zs = [ (ob.matrix_world @ v.co).z for ob in bpy.data.objects if ob.type=='MESH' and not ob.hide_render and ob != fl for v in ob.data.vertices[:2000] ]
fl.location.z = min(zs) - 0.0005 if zs else 0

# Softboxes
def area(name, loc, rot, size, energy, col=(1, 0.97, 0.94)):
    d = bpy.data.lights.new(name, 'AREA'); d.size = size; d.energy = energy; d.color = col
    ob = bpy.data.objects.new(name, d); ob.location = loc; ob.rotation_euler = rot
    sc.collection.objects.link(ob); return ob
# scale energy to scene size
import mathutils
pts = [ob.matrix_world @ mathutils.Vector(c) for ob in bpy.data.objects if ob.type=='MESH' and not ob.hide_render and ob!=fl for c in ob.bound_box]
mn = mathutils.Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
mx = mathutils.Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
ctr = (mn+mx)/2; S = max(mx-mn)
print("BBOX", mn, mx, "S", S)
def aim(ob, target):
    ob.rotation_euler = (target - ob.location).to_track_quat('-Z', 'Y').to_euler()
k = area("Key", ctr + mathutils.Vector((-2.2*S, -1.6*S, 1.4*S)), (0,0,0), 2.0*S, 900*S*S)
aim(k, ctr)
f = area("Fill", ctr + mathutils.Vector((2.4*S, -1.8*S, 0.6*S)), (0,0,0), 2.5*S, 300*S*S)
aim(f, ctr)
t = area("Top", ctr + mathutils.Vector((0, 0.3*S, 2.5*S)), (0,0,0), 2.0*S, 500*S*S)
aim(t, ctr)
r = area("Rim", ctr + mathutils.Vector((1.2*S, 2.2*S, 1.0*S)), (0,0,0), 1.2*S, 450*S*S)
aim(r, ctr)

shots = [("front", 'Camera | authority front', 1920, 1080),
         ("exterior", 'Camera | exterior', 1600, 2000),
         ("control", 'Camera | control detail', 1600, 2000)]
for tag, camname, rx, ry in shots:
    cam = bpy.data.objects.get(camname)
    if not cam: print("NO CAM", camname); continue
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = rx, ry
    sc.render.filepath = f"{OUT}/{tag}.png"
    bpy.ops.render.render(write_still=True)
    print("SAVED", sc.render.filepath)
