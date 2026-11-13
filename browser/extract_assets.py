"""Extract only runtime media and credits from the user's local OpenSpades release."""
from pathlib import Path, PurePosixPath
import zipfile, json, re, struct, zlib


def tga_to_png(data):
    """Converts an (optionally RLE) true-color or grayscale TGA to an RGBA PNG without third-party modules."""
    id_len, cmap_type, kind = data[0], data[1], data[2]
    width, height, bpp, desc = struct.unpack_from('<HHBB', data, 12)
    if cmap_type or kind not in (2, 3, 10, 11):
        raise ValueError('Unsupported TGA type %d' % kind)
    size = bpp // 8
    pos = 18 + id_len
    count = width * height
    pixels = bytearray()
    if kind in (2, 3):
        pixels = data[pos:pos + count * size]
    else:
        while len(pixels) < count * size:
            header = data[pos]; pos += 1
            n = (header & 127) + 1
            if header & 128:
                pixels += data[pos:pos + size] * n; pos += size
            else:
                pixels += data[pos:pos + n * size]; pos += n * size
    rows = []
    for y in range(height):
        src = y if desc & 0x20 else height - 1 - y
        row = bytearray(b'\x00')
        for x in range(width):
            p = pixels[(src * width + x) * size:(src * width + x + 1) * size]
            if size == 1:
                row += bytes((p[0], p[0], p[0], 255))
            else:
                row += bytes((p[2], p[1], p[0], p[3] if size == 4 else 255))
        rows.append(bytes(row))
    def chunk(tag, body):
        return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', zlib.crc32(tag + body) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b''))


root = Path(__file__).resolve().parent
source = root.parent / 'OpenSpades-0.1.3-Windows' / 'Resources'
destination = root / 'dist' / 'assets'
files = {}
for pak in sorted(source.glob('*.pak')):
    with zipfile.ZipFile(pak) as archive:
        for entry in archive.infolist():
            name = entry.filename.replace('\\', '/')
            weak = name.endswith('.weak')
            if weak:
                name = name[:-5]
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or '_Assets_' in path.parts:
                continue
            if name.endswith('CountryFlags.as'):
                # Flag atlas coordinates from the main menu script, keyed by ISO country code.
                flags = {}
                for code, x, y in re.findall(r'case 0x([0-9a-f]+): x = (\d+); y = (\d+);', archive.read(entry).decode()):
                    n = int(code, 16)
                    flags[chr(n & 255) + chr(n >> 8)] = [int(x), int(y)]
                files['Gfx/UI/Flags.json'] = (json.dumps(flags).encode(), pak.name)
                continue
            ui = name.startswith('Gfx/') and name.endswith(('.png', '.tga', '.ttf'))
            if not (name.endswith(('.kv6', '.opus', '.wav')) or name.startswith('License/') or ui or name == 'Maps/Title.vxl'):
                continue
            if weak and name in files:
                continue
            files[name] = (archive.read(entry), pak.name)
for name in [n for n in files if n.endswith('.tga')]:
    # Browsers cannot decode TGA, so UI textures are stored as PNG under the same base name.
    data, pak = files.pop(name)
    files[name[:-4] + '.png'] = (tga_to_png(data), pak)
# Glyph table for the original "SquareFont" (Sources/Client/FontData.h): [x, y, width, advance].
header = (root.parent / 'openspades' / 'Sources' / 'Client' / 'FontData.h').read_text()
table = header[header.index('SquareFontBigMap'):]
table = table[table.index('{') + 1:table.index('};')].replace('PROP_SPACE_WIDTH', '-2')
glyphs = [list(map(int, g)) for g in re.findall(r'\{\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\}', table)]
assert len(glyphs) == 256, len(glyphs)
files['Gfx/Fonts/SquareFontBig.json'] = (json.dumps(glyphs).encode(), 'FontData.h')
for name, (data, _) in files.items():
    path = destination / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
(destination / 'manifest.json').write_text(json.dumps({n: p for n, (_, p) in files.items()}, indent=2))
print(f'Extracted {len(files)} media/credit files ({sum(len(d) for d, _ in files.values()) / 1e6:.1f} MB)')
