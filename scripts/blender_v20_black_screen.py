import bpy, math, os
from mathutils import Vector
# Blender v20 black metal Revivex concept: screen-led, no manual dial
OUT='/Users/edorfanini/Projects/revivex-appliance-launch/site/gen-v20/blender'
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
scene.render.engine='CYCLES'
scene.cycles.samples=128
scene.render.resolution_x=1800
scene.render.resolution_y=2400
scene.view_settings.view_transform='Filmic'
scene.view_settings.look='Medium High Contrast'
scene.view_settings.exposure=-0.2
scene.view_settings.gamma=1
# World black
scene.world=bpy.data.worlds.new('Black world'); scene.world.color=(0,0,0)
# Materials via diffuse for stability
def mat(name, color, metallic=0, roughness=.4):
    m=bpy.data.materials.new(name)
    m.diffuse_color=color
    try:
        m.use_nodes=True
        bsdf=m.node_tree.nodes.get('Principled BSDF')
        if bsdf:
            bsdf.inputs['Base Color'].default_value=color
            bsdf.inputs['Metallic'].default_value=metallic
            bsdf.inputs['Roughness'].default_value=roughness
    except Exception: pass
    return m
black=mat('anodized graphite black',(0.015,0.016,0.018,1),.7,.24)
dark=mat('black glass',(0.001,0.003,0.006,1),0,.08)
steel=mat('brushed gunmetal',(0.26,0.27,0.28,1),.9,.2)
water=mat('clear water',(0.72,0.9,1.0,.38),0,.02)
white=mat('screen white',(1,1,1,1),0,.18)
blue=mat('screen blue',(0.1,0.48,1.0,1),0,.2)
stone=mat('dark stone',(0.07,0.065,0.06,1),0,.55)
# Helpers
def cube(name, loc, scale, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o=bpy.context.object; o.name=name; o.dimensions=scale; bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(material)
    mod=o.modifiers.new('soft bevel','BEVEL'); mod.width=.045; mod.segments=8
    o.modifiers.new('weighted metal normals','WEIGHTED_NORMAL')
    return o
# Plinth and machine
cube('matte stone plinth',(0,0,-.08),(3.2,1.6,.16),stone)
body=cube('Revivex black metal body',(0,0,.82),(1.12,.62,1.72),black)
# Open bay cut visual, represented by black recess + metal side rails
cube('dispensing bay shadow',(0,-.326,.44),(.72,.035,.75),dark)
cube('left bay rail',(-.41,-.36,.45),(.045,.08,.85),steel)
cube('right bay rail',(.41,-.36,.45),(.045,.08,.85),steel)
cube('top bay lip',(0,-.36,.88),(.86,.08,.055),steel)
cube('drip tray',(0,-.43,.05),(.82,.36,.055),steel)
# Large screen, almost entire top half
screen=cube('large glass touchscreen',(0,-.355,1.28),(1.02,.045,.66),dark)
# Screen UI tiles on front plane
for x,y,w,h,label in [(-.24,1.38,.36,.11,'Sleep'),(.24,1.38,.36,.11,'Recovery'),(-.24,1.18,.36,.11,'Stress'),(.24,1.18,.36,.11,'Blend')]:
    cube('screen tile '+label,(x,-.383,y),(w,.012,h),mat('tile '+label,(0.025,0.04,0.065,1),0,.18))
    bpy.ops.object.text_add(location=(x-.13,-.392,y+.01), rotation=(math.radians(90),0,0))
    t=bpy.context.object; t.name='label '+label; t.data.body=label; t.data.align_x='LEFT'; t.data.align_y='CENTER'; t.data.size=.035; t.data.extrude=.001; t.data.materials.append(white)
# REVIVEX word on metal below screen
bpy.ops.object.text_add(location=(-.31,-.39,.96), rotation=(math.radians(90),0,0))
t=bpy.context.object; t.name='REVIVEX word'; t.data.body='REVIVEX'; t.data.align_x='LEFT'; t.data.align_y='CENTER'; t.data.size=.07; t.data.extrude=.002; t.data.materials.append(white)
# slim slot spout and clear glass, no manual-button/dial read
cube('slim dispensing slot',(0,-.455,.77),(.28,.09,.035),steel)
# clear tumbler is built from transparent rings + faint walls so it never reads as a white cylinder
bpy.ops.mesh.primitive_torus_add(major_radius=.18, minor_radius=.008, major_segments=96, minor_segments=8, location=(0,-.55,.49))
rim=bpy.context.object; rim.name='thin glass rim'; rim.data.materials.append(mat('glass edge',(0.85,0.95,1,.55),0,.02))
bpy.ops.mesh.primitive_torus_add(major_radius=.17, minor_radius=.006, major_segments=96, minor_segments=8, location=(0,-.55,.06))
base=bpy.context.object; base.name='thin glass base'; base.data.materials.append(mat('glass base edge',(0.85,0.95,1,.45),0,.02))
# transparent glass wall as a very thin open cylinder
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=.18, depth=.43, location=(0,-.55,.275))
g=bpy.context.object; g.name='clear tumbler wall'; g.scale.x=1; g.scale.y=1; g.data.materials.append(mat('faint glass wall',(0.8,0.92,1,.10),0,.02))
# water fill volume low tint
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=.162, depth=.24, location=(0,-.55,.18))
w=bpy.context.object; w.name='clear water in glass'; w.data.materials.append(water)

# Lights
bpy.ops.object.light_add(type='AREA', location=(0,-3,3.2)); l=bpy.context.object; l.name='front softbox'; l.data.energy=600; l.data.size=2.4
bpy.ops.object.light_add(type='AREA', location=(2.5,-1.4,2.2)); l=bpy.context.object; l.name='right rim'; l.data.energy=500; l.data.size=.8
bpy.ops.object.light_add(type='AREA', location=(-2.2,-1.0,1.8)); l=bpy.context.object; l.name='left glint'; l.data.energy=120; l.data.size=.5
# Cameras
cameras={
 'hero_front':((0,-4.7,1.05),(math.radians(78),0,0),62),
 'screen_macro':((.16,-2.25,1.24),(math.radians(82),0,math.radians(-3)),88),
 'pour_detail':((.32,-2.35,.38),(math.radians(80),0,math.radians(8)),82),
}
for name,(loc,rot,lens) in cameras.items():
    cam_data=bpy.data.cameras.new(name); cam_data.lens=lens
    cam=bpy.data.objects.new(name,cam_data); scene.collection.objects.link(cam); cam.location=loc; cam.rotation_euler=rot
    scene.camera=cam; scene.render.filepath=os.path.join(OUT,name+'.png'); bpy.ops.render.render(write_still=True)
# save file
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'revivex_black_screen.blend'))
print('DONE', OUT)
