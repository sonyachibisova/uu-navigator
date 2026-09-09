#!/usr/bin/env python3
"""Сборка модели здания в .glb из CAD-выгрузки и планов помещений.

На входе: bri.obj (выгрузка, плоский список объектов Body###),
data/building.json, data/floors/*.json (координаты помещений и дверей).
На выходе: .glb с иерархией и именами по спецификации модели + отчёт.
"""
import json, sys, os
import numpy as np
import trimesh

if len(sys.argv) < 2:
    sys.exit('использование: build-model.py <выгрузка.obj> [папка данных] [выход.glb]\n'
             'зависимости: numpy, trimesh')
OBJ  = sys.argv[1]
DATA = sys.argv[2] if len(sys.argv) > 2 else 'data'
OUT  = sys.argv[3] if len(sys.argv) > 3 else 'public/models/bhsad.glb'

UNIT = 0.1                       # выгрузка в дециметрах
STRAY = {'Body551'}              # объект вне габарита здания, в модель не идёт
SHELL_OBJ, ROOF_OBJ = 'Body754', 'Body516'
# уровни выгрузки -> уровни по планам (этаж 4: 10.8, этаж 5: 14.4, высота этажа 3.6)
Y_SRC = [0.0,  9.0, 12.0, 13.00, 16.2, 30.0]
Y_DST = [0.0, 10.8, 14.4, 14.55, 18.0, 31.8]

log = []
def say(s=''):
    log.append(s); print(s)

# ── читаем выгрузку ────────────────────────────────────────────────────────
V, F, G, names, cur = [], [], [], [], -1
for line in open(OBJ, errors='ignore'):
    if line.startswith('v '):
        p = line.split(); V.append((float(p[1]), float(p[2]), float(p[3])))
    elif line.startswith('g '):
        names.append(line.split(None, 1)[1].strip()); cur += 1
    elif line.startswith('f '):
        idx = [int(t.split('/')[0]) for t in line.split()[1:]]
        idx = [i - 1 if i > 0 else len(V) + i for i in idx]
        for k in range(1, len(idx) - 1):
            F.append((idx[0], idx[k], idx[k + 1])); G.append(cur)
V = np.array(V) * UNIT; F = np.array(F); G = np.array(G); names = np.array(names)
say(f'выгрузка: {len(names)} объектов, {len(F)} треугольников')

# ── геометрия здания и планы ───────────────────────────────────────────────
bld = json.load(open(f'{DATA}/building.json'))
fp, FH = bld['footprint'], bld['floorHeight']
floors = {}
for f in bld['floors']:
    p = f'{DATA}/{f["file"]}'
    floors[f['level']] = json.load(open(p)) if os.path.exists(p) else {'rooms': []}

# ── приведение координат ───────────────────────────────────────────────────
alive = ~np.isin(names[G], list(STRAY))
P = V[F[alive]].reshape(-1, 3)
xr, zr = (P[:, 0].min(), P[:, 0].max()), (P[:, 2].min(), P[:, 2].max())
say(f'габарит выгрузки: {xr[1]-xr[0]:.2f} x {zr[1]-zr[0]:.2f} м, по планам '
    f'{fp["x1"]-fp["x0"]:.2f} x {fp["z1"]-fp["z0"]:.2f} м')
V[:, 0] = fp['x0'] + (V[:, 0] - xr[0]) / (xr[1] - xr[0]) * (fp['x1'] - fp['x0'])
V[:, 2] = fp['z0'] + (V[:, 2] - zr[0]) / (zr[1] - zr[0]) * (fp['z1'] - fp['z0'])
V[:, 1] = np.interp(V[:, 1], Y_SRC, Y_DST)

C  = V[F].mean(1)
a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
N  = np.cross(b - a, c - a)
N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)

def floor_of(y):
    return int(np.clip(np.floor(y / FH) + 1, 1, 5))

# ── раскладка треугольников по объектам ────────────────────────────────────
buckets = {}
def put(key, tri_idx):
    buckets.setdefault(key, []).append(tri_idx)

nm = names[G]
horiz = np.abs(N[:, 1]) > 0.7
# этаж объекта определяется по объекту целиком, иначе одна перегородка
# разъезжается по двум этажам на границе перекрытия
obj_floor = {}
for gi, o in enumerate(names):
    m = G == gi
    if not m.any(): continue
    ys = C[m, 1]
    obj_floor[o] = floor_of(np.median(ys))
for i in range(len(F)):
    o, y = nm[i], C[i, 1]
    if o in STRAY:
        continue
    if o == ROOF_OBJ or y > 18.0 + 0.05:
        put(('Roof', 'Roof_Slab' if horiz[i] and y < 18.6 else 'Roof_Parapet'), i)
    elif o == SHELL_OBJ:
        if horiz[i]:
            lv = int(np.clip(round(y / FH) + 1, 1, 6))
            put((f'Floor_{lv:02d}', 'Slab') if lv <= 5 else ('Roof', 'Roof_Slab'), i)
        else:
            d = {'West': abs(C[i,0]-fp['x0']), 'East': abs(C[i,0]-fp['x1']),
                 'North': abs(C[i,2]-fp['z0']), 'South': abs(C[i,2]-fp['z1'])}
            side = min(d, key=d.get)
            lv = floor_of(y)
            put(('Shell', f'Wall_{side}_F{lv:02d}'), i)
    else:
        put((f'Floor_{obj_floor[o]:02d}', f'Detail_{o}'), i)

# ── сцена ──────────────────────────────────────────────────────────────────
scene = trimesh.Scene()
ROOT = 'Building_bhsad'
def node(child, parent, T=None):
    scene.graph.update(frame_to=child, frame_from=parent,
                       matrix=np.eye(4) if T is None else T)
node(ROOT, scene.graph.base_frame)
for g in ['Shell', 'Roof', 'Facade', 'Ground'] + [f'Floor_{i:02d}' for i in range(1, 6)]:
    node(g, ROOT)

stats = {}
for (grp, name), tris in buckets.items():
    f = F[tris]
    used = np.unique(f); remap = np.full(len(V), -1); remap[used] = np.arange(len(used))
    mesh = trimesh.Trimesh(vertices=V[used], faces=remap[f], process=False)
    scene.add_geometry(mesh, geom_name=name, node_name=name, parent_node_name=grp)
    stats[(grp, name)] = len(f)

# ── помещения и двери из планов ────────────────────────────────────────────
box = trimesh.creation.box(extents=(1, 1, 1))
made_rooms = made_doors = 0
for lv, fl in floors.items():
    if not fl.get('rooms'):
        continue
    elev = fl.get('elevation', (lv - 1) * FH)
    for r in fl['rooms']:
        bb = r['bounds']
        dx, dz = bb['x1'] - bb['x0'], bb['z1'] - bb['z0']
        T = np.eye(4); T[0, 0], T[1, 1], T[2, 2] = dx, 0.06, dz
        T[:3, 3] = [(bb['x0'] + bb['x1']) / 2, elev + 0.05, (bb['z0'] + bb['z1']) / 2]
        scene.add_geometry(box.copy(), geom_name=f'Room_{r["id"]}',
                           node_name=f'Room_{r["id"]}', parent_node_name=f'Floor_{lv:02d}',
                           transform=T)
        made_rooms += 1
        for k, d in enumerate(r.get('doors', []), 1):
            T = np.eye(4); T[:3, 3] = [d['x'], elev + 1.05, d['z']]
            node(f'Door_{r["id"]}_{k:02d}', f'Floor_{lv:02d}', T)
            made_doors += 1

scene.export(OUT)

# ── отчёт ──────────────────────────────────────────────────────────────────
say()
say('собрано:')
for grp in ['Shell', 'Roof'] + [f'Floor_{i:02d}' for i in range(1, 6)]:
    items = {k[1]: v for k, v in stats.items() if k[0] == grp}
    if not items: continue
    top = sorted(items.items(), key=lambda x: -x[1])[:4]
    say(f'  {grp:9s} объектов {len(items):3d}, треуг. {sum(items.values()):6d}   '
        + ', '.join(f'{n} {t}' for n, t in top))
say(f'  помещений (из планов) {made_rooms}, дверей-пустышек {made_doors}')
tot = sum(stats.values()) + made_rooms * 12
say()
say(f'треугольников всего {tot} (бюджет 300000), объектов {len(stats)+made_rooms}, '
    f'файл {os.path.getsize(OUT)/1e6:.2f} МБ')
walls = [k[1] for k in stats if k[1].startswith('Wall_')]
say(f'фрагментов оболочки {len(walls)}: {", ".join(sorted(walls))}')
miss = [f'Wall_{s}_F{l:02d}' for s in ('North','South','East','West') for l in range(1,6)
        if f'Wall_{s}_F{l:02d}' not in walls]
if miss: say(f'НЕТ фрагментов: {", ".join(miss)}')
open('build-report.txt','w').write('\n'.join(log))
