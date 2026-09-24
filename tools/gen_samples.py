#!/usr/bin/env python3
"""Write the checked-in calibration meshes. Original geometry, not a Benchy copy."""

import math
import struct
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "samples"


def tri_normal(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    length = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1.0
    return (n[0] / length, n[1] / length, n[2] / length)


def write_stl(path: Path, triangles):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        header = b"Blend sample mesh" + b"\0" * (80 - len(b"Blend sample mesh"))
        f.write(header[:80])
        f.write(struct.pack("<I", len(triangles)))
        for a, b, c in triangles:
            n = tri_normal(a, b, c)
            f.write(struct.pack("<3f", *n))
            for v in (a, b, c):
                f.write(struct.pack("<3f", *v))
            f.write(struct.pack("<H", 0))


def cube(size=20.0):
    s = size
    v = [
        (0, 0, 0),
        (s, 0, 0),
        (s, s, 0),
        (0, s, 0),
        (0, 0, s),
        (s, 0, s),
        (s, s, s),
        (0, s, s),
    ]
    faces = [
        (0, 2, 1),
        (0, 3, 2),
        (4, 5, 6),
        (4, 6, 7),
        (0, 1, 5),
        (0, 5, 4),
        (3, 7, 6),
        (3, 6, 2),
        (0, 4, 7),
        (0, 7, 3),
        (1, 2, 6),
        (1, 6, 5),
    ]
    return [(v[i], v[j], v[k]) for i, j, k in faces]


def hull(length=60.0, beam=24.0, height=28.0, n=96, nz=24):
    """Watertight superellipse prism, benchy-scale, centered on X/Y."""
    outline = []
    for i in range(n):
        t = 2 * math.pi * i / n
        # Exponent > 1 pulls the planform toward a rounded rectangle.
        exp = 2.4
        x = (length * 0.5) * math.copysign(abs(math.cos(t)) ** (2 / exp), math.cos(t))
        y = (beam * 0.5) * math.copysign(abs(math.sin(t)) ** (2 / exp), math.sin(t))
        outline.append((x, y))
    rings = []
    for k in range(nz + 1):
        z = height * k / nz
        rings.append([(x, y, z) for x, y in outline])
    tris = []
    for k in range(nz):
        for i in range(n):
            j = (i + 1) % n
            a, b = rings[k][i], rings[k][j]
            c, d = rings[k + 1][j], rings[k + 1][i]
            tris.append((a, b, d))
            tris.append((b, c, d))
    bottom = (0.0, 0.0, 0.0)
    top = (0.0, 0.0, height)
    for i in range(n):
        j = (i + 1) % n
        tris.append((bottom, rings[0][j], rings[0][i]))
        tris.append((top, rings[-1][i], rings[-1][j]))
    return tris


def box(x0, y0, z0, x1, y1, z1):
    v = [
        (x0, y0, z0),
        (x1, y0, z0),
        (x1, y1, z0),
        (x0, y1, z0),
        (x0, y0, z1),
        (x1, y0, z1),
        (x1, y1, z1),
        (x0, y1, z1),
    ]
    faces = [
        (0, 2, 1),
        (0, 3, 2),
        (4, 5, 6),
        (4, 6, 7),
        (0, 1, 5),
        (0, 5, 4),
        (3, 7, 6),
        (3, 6, 2),
        (0, 4, 7),
        (0, 7, 3),
        (1, 2, 6),
        (1, 6, 5),
    ]
    return [(v[i], v[j], v[k]) for i, j, k in faces]


def overhang_ledge():
    """24 mm base with a 24 mm shelf that starts at Z = 12. The shelf is a 90° overhang."""
    return box(0, 0, 0, 24, 24, 12) + box(24, 4, 12, 48, 20, 16)


def slope_ramp():
    """Watertight ramp: vertical walls up to a roof that rises from Z=8 at X=0 to Z=20 at X=40."""
    v = [
        (0.0, 0.0, 0.0),
        (40.0, 0.0, 0.0),
        (40.0, 16.0, 0.0),
        (0.0, 16.0, 0.0),
        (0.0, 0.0, 8.0),
        (0.0, 16.0, 8.0),
        (40.0, 0.0, 20.0),
        (40.0, 16.0, 20.0),
    ]
    faces = [
        (0, 2, 1),
        (0, 3, 2),
        (0, 1, 6),
        (0, 6, 4),
        (3, 5, 7),
        (3, 7, 2),
        (1, 2, 7),
        (1, 7, 6),
        (0, 4, 5),
        (0, 5, 3),
        (4, 6, 7),
        (4, 7, 5),
    ]
    return [(v[i], v[j], v[k]) for i, j, k in faces]


def write_3mf(path: Path, triangles):
    verts = []
    index = {}
    faces = []
    for tri in triangles:
        ids = []
        for v in tri:
            key = tuple(round(c, 5) for c in v)
            if key not in index:
                index[key] = len(verts)
                verts.append(key)
            ids.append(index[key])
        faces.append(ids)
    xml = ['<?xml version="1.0" encoding="UTF-8"?>']
    xml.append(
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
    )
    xml.append("<resources><object id=\"1\" type=\"model\"><mesh><vertices>")
    for x, y, z in verts:
        xml.append(f'<vertex x="{x}" y="{y}" z="{z}"/>')
    xml.append("</vertices><triangles>")
    for a, b, c in faces:
        xml.append(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>')
    xml.append("</triangles></mesh></object></resources>")
    xml.append('<build><item objectid="1"/></build></model>')
    body = "\n".join(xml).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        info = zipfile.ZipInfo("[Content_Types].xml", date_time=(2024, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(
            info,
            """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>""",
        )
        model = zipfile.ZipInfo("3D/3dmodel.model", date_time=(2024, 1, 1, 0, 0, 0))
        model.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(model, body)


def main():
    cube_tris = cube()
    write_stl(ROOT / "calibration_cube_20mm.stl", cube_tris)
    write_3mf(ROOT / "calibration_cube_20mm.3mf", cube_tris)
    hull_tris = hull()
    write_stl(ROOT / "lime_hull.stl", hull_tris)
    ledge = overhang_ledge()
    write_stl(ROOT / "overhang_ledge.stl", ledge)
    ramp = slope_ramp()
    write_stl(ROOT / "slope_ramp.stl", ramp)
    print(f"cube triangles {len(cube_tris)}")
    print(f"hull triangles {len(hull_tris)}")
    print(f"ledge triangles {len(ledge)}")
    print(f"ramp triangles {len(ramp)}")


if __name__ == "__main__":
    main()
