#!/usr/bin/env python3
"""Encode browser screenshots as optimized GIFs; requires Pillow for regeneration."""
import colorsys
import os
import pathlib
import sys
from PIL import Image

for index in range(1, len(sys.argv), 3):
    directory, destination, duration = sys.argv[index:index + 3]
    files = sorted(pathlib.Path(directory).glob('*.png'))
    # Use one palette for every frame, so GIF optimization can encode only
    # changed pixels instead of repainting the entire dashboard each time.
    sample = Image.new('RGB', (264 * 4, 169 * 3))
    for i in range(12):
        with Image.open(files[i * (len(files) - 1) // 11]) as image:
            thumbnail = image.convert('RGB')
            thumbnail.thumbnail((264, 169), Image.Resampling.LANCZOS)
            sample.paste(thumbnail, ((i % 4) * 264, (i // 4) * 169))
    palette = sample.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    # Tool colors occupy very few pixels in the screenshots. Reserve palette
    # entries for them so median-cut sampling doesn't wash the nodes out.
    colors = palette.getpalette()
    for i in range(36):
        rgb = colorsys.hls_to_rgb(i / 36, 0.88, 0.65)
        colors[(128 + i) * 3:(129 + i) * 3] = [round(channel * 255) for channel in rgb]
    colors[164 * 3:165 * 3] = [137, 209, 133]
    colors[165 * 3:166 * 3] = [204, 167, 0]
    colors[166 * 3:167 * 3] = [244, 135, 113]
    colors[167 * 3:168 * 3] = [77, 170, 252]
    palette.putpalette(colors)
    frames = []
    for file in files:
        with Image.open(file) as image:
            frame = image.convert('RGB')
            max_width, max_height = map(int, os.environ.get('AGENTOBS_GIF_SIZE', '1056x675').split('x'))
            frame.thumbnail((max_width, max_height), Image.Resampling.LANCZOS)
            frames.append(frame.quantize(palette=palette, dither=Image.Dither.NONE))
    frames[0].save(destination, save_all=True, append_images=frames[1:], duration=int(duration), loop=0, optimize=True, disposal=1)
    print(f'{destination}: {len(frames)} frames, {pathlib.Path(destination).stat().st_size // 1024} KiB')
