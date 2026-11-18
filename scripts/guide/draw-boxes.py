"""Draws the red boxes on the guide screenshots (app/assets/guide/images).

Each NAME.png taken by integration_test/v1_compare_test.dart (V1_GUIDE=true) has a
NAME.boxes.json beside it: {"boxes": [[left, top, right, bottom], ...], "blur": [...]} in image
pixels. Boxes are drawn in red; blur covers local paths (they carry the Windows user name).
The json is removed afterwards.

    core/python/cpython-3.13.18-windows-x86_64-none/python.exe -I scripts/guide/draw-boxes.py
"""
import json
import pathlib

from PIL import Image, ImageDraw, ImageFilter

IMAGES = pathlib.Path(__file__).resolve().parents[2] / "app" / "assets" / "guide" / "images"
RED = (214, 48, 39, 255)

for boxes_file in sorted(IMAGES.glob("*.boxes.json")):
    png = boxes_file.with_name(boxes_file.name.replace(".boxes.json", ".png"))
    data = json.loads(boxes_file.read_text(encoding="utf-8"))
    boxes, blur = (data, []) if isinstance(data, list) else (data["boxes"], data["blur"])
    image = Image.open(png).convert("RGBA")
    for left, top, right, bottom in blur:
        area = tuple(int(v) for v in (left, top, right, bottom))
        image.paste(image.crop(area).filter(ImageFilter.GaussianBlur(6)), area[:2])
    draw = ImageDraw.Draw(image)
    for left, top, right, bottom in boxes:
        pad = 5
        draw.rounded_rectangle([left - pad, top - pad, right + pad, bottom + pad], radius=8, outline=RED, width=3)
    # JPEG: the paper texture makes these 1.3 MB as png, about 120 KB here.
    image.convert("RGB").save(png.with_suffix(".jpg"), "JPEG", quality=82, optimize=True, progressive=True)
    png.unlink()
    boxes_file.unlink()
    print(png.name, len(boxes), "boxes", len(blur), "blurred")
