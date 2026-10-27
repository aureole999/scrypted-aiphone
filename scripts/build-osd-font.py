"""Development only: python build-osd-font.py /path/to/NotoSansCJKsc-Regular.otf.

Pillow renders only the fixed OSD character set. No Python/font package is used
by the deployed plugin. Source font: notofonts/noto-cjk (SIL OFL 1.1).
"""
import base64
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

characters = ''.join(chr(c) for c in range(32, 127))
font = ImageFont.truetype(sys.argv[1], 22)
glyphs = {}
for char in dict.fromkeys(characters):
    width = max(1, round(font.getlength(char)))
    image = Image.new('L', (width, 30))
    ImageDraw.Draw(image).text((0, 23), char, font=font, fill=255, anchor='ls')
    glyphs[char] = {'width': width, 'alpha': base64.b64encode(image.tobytes()).decode()}
output = Path(__file__).resolve().parent.parent / 'fs' / 'osd'
output.mkdir(parents=True, exist_ok=True)
(output / 'glyphs.json').write_text(json.dumps({'height': 30, 'glyphs': glyphs}, ensure_ascii=False, separators=(',', ':')))
