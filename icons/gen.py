"""Generate Clear Eyes icons (16/48/128) — pure stdlib, no PIL.

Dark slate rounded square, white almond eye, blue iris, dark pupil.
Rerun with: python3 icons/gen.py
"""
import struct, zlib, math, os

def render(size, ss=4):
    S = size * ss
    px = bytearray()
    bg = (21, 32, 43)
    sclera = (245, 248, 250)
    iris = (29, 155, 240)
    pupil = (15, 20, 25)
    corner = 0.22 * S
    cx = cy = S / 2
    d, R = 0.33 * S, 0.55 * S
    r_iris, r_pupil = 0.16 * S, 0.07 * S

    def inside_rounded(x, y):
        rx = min(x, S - 1 - x)
        ry = min(y, S - 1 - y)
        if rx >= corner or ry >= corner:
            return True
        return (rx - corner) ** 2 + (ry - corner) ** 2 <= corner ** 2

    rows = []
    for Y in range(S):
        row = []
        for X in range(S):
            if not inside_rounded(X, Y):
                row.append((0, 0, 0, 0))
                continue
            c = bg
            d1 = math.hypot(X - cx, Y - (cy - d))
            d2 = math.hypot(X - cx, Y - (cy + d))
            if d1 < R and d2 < R:
                c = sclera
                dc = math.hypot(X - cx, Y - cy)
                if dc < r_iris:
                    c = iris
                if dc < r_pupil:
                    c = pupil
            row.append((c[0], c[1], c[2], 255))
        rows.append(row)

    # downsample ss x ss
    out = bytearray()
    for y in range(size):
        out.append(0)  # filter: none
        for x in range(size):
            acc = [0, 0, 0, 0]
            for dy in range(ss):
                for dx in range(ss):
                    p = rows[y * ss + dy][x * ss + dx]
                    for i in range(4):
                        acc[i] += p[i]
            out.extend(v // (ss * ss) for v in acc)
    return bytes(out)

def png(size, path):
    raw = render(size)
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    body = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(body)
    print(path)

here = os.path.dirname(os.path.abspath(__file__))
for s in (16, 48, 128):
    png(s, os.path.join(here, f"icon{s}.png"))
