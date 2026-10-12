#!/usr/bin/env python3
# Makes the small photo and video fixtures scripts/photos-check.ts reads (they are committed, so
# the check needs none of these tools). The EXIF is written by Pillow, ImageMagick and ffmpeg, and
# one segment by hand (big-endian), so the parser in server/exif.ts is checked against writers it
# shares no code with.
#
#   python3 scripts/fixtures/photos/make.py      (Pillow, exiv2, ImageMagick with HEIC, ffmpeg)

import os
import struct
import subprocess
from PIL.TiffImagePlugin import IFDRational as Fraction

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
out = lambda name: os.path.join(HERE, name)


def picture(w, h, colour):
    img = Image.new('RGB', (w, h), colour)
    # A diagonal so a rotation would show.
    for i in range(min(w, h)):
        img.putpixel((i, i), (255, 255, 255))
    return img


def full_exif():
    exif = Image.Exif()
    exif[0x010F] = 'Canon'
    exif[0x0110] = 'Canon EOS R6'
    exif[0x0112] = 1
    exif[0x0132] = '2023:07:15 09:00:00'
    ifd = exif.get_ifd(0x8769)
    ifd[0x9003] = '2023:07:14 18:32:05'
    ifd[0x9011] = '+02:00'
    ifd[0x829A] = Fraction(1, 250)
    ifd[0x829D] = Fraction(28, 10)
    ifd[0x8827] = 200
    ifd[0x920A] = Fraction(35, 1)
    ifd[0xA434] = 'RF35mm F1.8 MACRO IS STM'
    ifd[0xA002] = 64
    ifd[0xA003] = 48
    gps = exif.get_ifd(0x8825)
    gps[1] = 'N'
    gps[2] = (Fraction(52), Fraction(22), Fraction(1234, 100))
    gps[3] = 'E'
    gps[4] = (Fraction(4), Fraction(53), Fraction(3006, 100))
    gps[5] = b'\x00'
    gps[6] = Fraction(12, 1)
    return exif


# A JPEG with everything the info panel shows (Pillow writes it little-endian, "II").
picture(64, 48, (200, 80, 40)).save(out('canon.jpg'), quality=80, exif=full_exif())

# The same with the small preview cameras embed (IFD1), as an encrypted library's photo has to
# show it: Seafile makes no thumbnails there.
picture(64, 48, (90, 40, 200)).save(out('vault.jpg'), quality=80, exif=full_exif())
picture(16, 12, (90, 40, 200)).save(out('vault-thumb.jpg'), quality=60)
subprocess.run(['exiv2', '-i', 't', out('vault.jpg')], check=True)
os.remove(out('vault-thumb.jpg'))

# No EXIF at all: the date comes from the file's mtime.
picture(40, 30, (40, 120, 200)).save(out('plain.jpg'), quality=80)

# PNG and WebP carry the same EXIF (PNG's eXIf chunk, WebP's EXIF chunk).
picture(32, 24, (60, 160, 90)).save(out('photo.png'), exif=full_exif())
picture(32, 24, (160, 60, 160)).save(out('photo.webp'), exif=full_exif(), quality=80)

# HEIC, as a phone makes it: ImageMagick carries the JPEG's EXIF over into an Exif item.
subprocess.run(['magick', out('canon.jpg'), '-quality', '50', out('photo.heic')], check=True)


def tiff_be(entries_ifd0, entries_exif, entries_gps):
    """A big-endian ("MM") TIFF block, laid out by hand: IFD0, then the Exif and GPS IFDs, then values."""
    def ifd_size(n):
        return 2 + 12 * n + 4

    order = [('ifd0', entries_ifd0 + [(0x8769, 4, 1, None), (0x8825, 4, 1, None)]), ('exif', entries_exif), ('gps', entries_gps)]
    offsets = {}
    pos = 8
    for name, entries in order:
        offsets[name] = pos
        pos += ifd_size(len(entries))
    data = b''
    data_start = pos
    blocks = []
    for name, entries in order:
        body = struct.pack('>H', len(entries))
        for tag, typ, count, value in sorted(entries, key=lambda e: e[0]):
            if tag == 0x8769:
                value = struct.pack('>I', offsets['exif'])
            elif tag == 0x8825:
                value = struct.pack('>I', offsets['gps'])
            if len(value) <= 4:
                body += struct.pack('>HHI', tag, typ, count) + value.ljust(4, b'\x00')
            else:
                body += struct.pack('>HHI', tag, typ, count) + struct.pack('>I', data_start + len(data))
                data += value
                if len(data) % 2:
                    data += b'\x00'
        body += struct.pack('>I', 0)
        blocks.append(body)
    return b'MM\x00\x2a' + struct.pack('>I', 8) + b''.join(blocks) + data


def ascii_(s):
    b = s.encode() + b'\x00'
    return (2, len(b), b)


def rationals(*pairs):
    return (5, len(pairs), b''.join(struct.pack('>II', n, d) for n, d in pairs))


tiff = tiff_be(
    [(0x010F, *ascii_('Apple')), (0x0110, *ascii_('iPhone 15 Pro')), (0x0112, 3, 1, struct.pack('>H', 6))],
    [
        (0x9003, *ascii_('2021:12:31 23:59:58')),
        (0x829A, *rationals((1, 60))),
        (0x829D, *rationals((178, 100))),
        (0x8827, 3, 1, struct.pack('>H', 1250)),
        (0x920A, *rationals((6765, 1000))),
        (0xA434, *ascii_('iPhone 15 Pro back triple camera 6.765mm f/1.78')),
    ],
    [(1, *ascii_('S')), (2, *rationals((33, 1), (51, 1), (3540, 100))), (3, *ascii_('W')), (4, *rationals((151, 1), (12, 1), (3000, 100)))],
)
# A JPEG with that block in its APP1 segment, right after SOI; the picture is 48 wide, 32 high
# (orientation 6: it shows 32 wide, 48 high).
picture(48, 32, (230, 200, 40)).save(out('_tmp.jpg'), quality=80)
raw = open(out('_tmp.jpg'), 'rb').read()
os.remove(out('_tmp.jpg'))
app1 = b'Exif\x00\x00' + tiff
open(out('iphone-be.jpg'), 'wb').write(raw[:2] + b'\xff\xe1' + struct.pack('>H', len(app1) + 2) + app1 + raw[2:])

# Video: one with its moov box first (faststart), one with it at the end, as phones often write.
common = ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=32x24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', 'creation_time=2022-05-01T10:20:30Z']
subprocess.run(common + ['-movflags', '+faststart', out('clip.mp4')], check=True)
subprocess.run(common + [out('clip-tail.mov')], check=True)
print('made', sorted(f for f in os.listdir(HERE) if not f.endswith('.py')))
