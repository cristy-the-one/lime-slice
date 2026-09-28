"""Side cross-sections of the support printed in a G-code file.

usage: python tools/support_section.py out.png a.gcode [b.gcode ...]

Each input becomes one row. Each column is a thin Y slab through the part, drawn
in X/Z, so branch thickness under an overhang can be compared by eye.
"""

import re
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.collections import LineCollection  # noqa: E402

WORD = re.compile(r"([XYZEIJ])(-?\d*\.?\d+)")
COLOURS = {"SUPPORT": "#6f8fe8", "SUPPORT-INTERFACE": "#c89ae8"}


def segments(path):
    x = y = z = 0.0
    kind = ""
    out = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("; TYPE:"):
                kind = line[7:].strip().upper()
                continue
            if not line.startswith(("G0", "G1", "G2", "G3")):
                continue
            words = dict(WORD.findall(line.split(";")[0]))
            nx = float(words.get("X", x))
            ny = float(words.get("Y", y))
            z = float(words.get("Z", z))
            if "E" in words and float(words["E"]) > 0 and (nx, ny) != (x, y):
                out.append((kind, x, y, nx, ny, z))
            x, y = nx, ny
    return out


def main():
    out_png, inputs = sys.argv[1], sys.argv[2:]
    runs = [segments(p) for p in inputs]
    ys = [s[2] for s in runs[0] if s[0].startswith("SUPPORT")]
    ys.sort()
    slabs = [ys[int(len(ys) * q)] for q in (0.4, 0.75)] if ys else [0.0]
    fig, axes = plt.subplots(
        len(runs), len(slabs), figsize=(13 * len(slabs), 4.5 * len(runs)), squeeze=False
    )
    for r, (path, segs) in enumerate(zip(inputs, runs)):
        for c, y0 in enumerate(slabs):
            ax = axes[r][c]
            lines, colours = [], []
            for kind, x0, ya, x1, yb, z in segs:
                if abs((ya + yb) * 0.5 - y0) > 0.35:
                    continue
                lines.append([(x0, z), (x1, z)])
                colours.append(COLOURS.get(kind, "#9a9a9a"))
            ax.add_collection(LineCollection(lines, colors=colours, linewidths=0.9))
            ax.autoscale()
            ax.set_title(f"{path.split('/')[-1]}  y {y0:.1f}", fontsize=9)
            ax.set_aspect("equal")
            ax.set_facecolor("#202124")
    fig.tight_layout()
    fig.savefig(out_png, dpi=110)


if __name__ == "__main__":
    main()
