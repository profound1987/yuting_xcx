import argparse
import re
import zlib
from pathlib import Path
from urllib.parse import urlencode

import pandas as pd
from PIL import Image, ImageDraw, ImageFont
import qrcode


DEVICE_CODE_SALT = "YUNTING-ZHIJIA-DEVICE-CODE-V1"
DEVICE_TYPES = {"AW", "ES", "LC", "SP", "GW"}
DEVICE_NO_RE = re.compile(r"^YT-([A-Z]{2})-([0-9A-F]{5})-([0-9A-F]{4})$")
PIN_RE = re.compile(r"^\d{6}$")
LABEL_FONT_SIZE = 24
LABEL_PADDING_X = 24
LABEL_PADDING_TOP = 8
LABEL_PADDING_BOTTOM = 20
LABEL_LINE_GAP = 6

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
]


def normalize_columns(df):
    mapping = {}
    for col in df.columns:
        key = str(col).strip().lower()
        if key in ("deviceid", "device_id", "deviceno", "device_no", "设备号"):
            mapping[col] = "deviceNo"
        elif key in ("pin", "绑定码", "配对码"):
            mapping[col] = "pin"
    return df.rename(columns=mapping)


def build_bind_uri(device_no, pin):
    # Keep device AES keys out of QR codes; QR only proves near-field possession.
    query = urlencode({
        "v": "1",
        "deviceNo": device_no,
        "pin": pin,
    })
    return f"ytsh://bind?{query}"


def load_label_font(size):
    for candidate in FONT_CANDIDATES:
        path = Path(candidate)
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size)
            except OSError:
                pass
    return ImageFont.load_default()


def text_size(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def make_labeled_qr(uri, device_no, pin):
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        border=4,
        box_size=10,
    )
    qr.add_data(uri)
    qr.make(fit=True)
    qr_image = qr.make_image(fill_color="black", back_color="white").convert("RGB")

    lines = [f"设备号:{device_no}", f"PIN码:{pin}"]
    font = load_label_font(LABEL_FONT_SIZE)
    measure = Image.new("RGB", (1, 1), "white")
    measure_draw = ImageDraw.Draw(measure)
    line_sizes = [text_size(measure_draw, line, font) for line in lines]
    text_width = max(width for width, _height in line_sizes)
    text_height = sum(height for _width, height in line_sizes) + LABEL_LINE_GAP * (len(lines) - 1)

    canvas_width = max(qr_image.width, text_width + LABEL_PADDING_X * 2)
    canvas_height = qr_image.height + LABEL_PADDING_TOP + text_height + LABEL_PADDING_BOTTOM
    canvas = Image.new("RGB", (canvas_width, canvas_height), "white")
    canvas.paste(qr_image, ((canvas_width - qr_image.width) // 2, 0))

    draw = ImageDraw.Draw(canvas)
    y = qr_image.height + LABEL_PADDING_TOP
    for line, (width, height) in zip(lines, line_sizes):
        draw.text(((canvas_width - width) // 2, y), line, font=font, fill="black")
        y += height + LABEL_LINE_GAP
    return canvas


def crc_check_code(body):
    payload = f"{body}|{DEVICE_CODE_SALT}".upper().encode("ascii")
    return f"{zlib.crc32(payload) & 0xffffffff:08X}"[-4:]


def normalize_device_no(value):
    return str(value or "").strip().upper()


def validate_device_no(device_no):
    matched = DEVICE_NO_RE.match(device_no)
    if not matched:
        return False
    type_code, serial, check_code = matched.groups()
    body = f"YT-{type_code}-{serial}"
    return type_code in DEVICE_TYPES and crc_check_code(body) == check_code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("excel", help="Excel file path, e.g. devices.xlsx")
    parser.add_argument("-o", "--output", default="qrcodes", help="Output directory")
    args = parser.parse_args()

    excel_path = Path(args.excel)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    df = normalize_columns(pd.read_excel(excel_path, dtype=str))

    if "deviceNo" not in df.columns or "pin" not in df.columns:
        raise SystemExit("Excel must contain columns: deviceID/deviceNo and PIN")

    rows = []
    for index, row in df.iterrows():
        device_no = normalize_device_no(row["deviceNo"])
        pin = str(row["pin"]).strip().zfill(6)

        if not validate_device_no(device_no):
            raise SystemExit(f"Invalid deviceNo at row {index + 2}: {device_no}")

        if not PIN_RE.match(pin):
            raise SystemExit(f"Invalid PIN at row {index + 2}: {pin}")

        uri = build_bind_uri(device_no, pin)
        filename = f"{device_no}.png"
        image_path = output_dir / filename

        img = make_labeled_qr(uri, device_no, pin)
        img.save(image_path)

        rows.append({
            "deviceNo": device_no,
            "pin": pin,
            "qrContent": uri,
            "qrImage": str(image_path),
        })

    pd.DataFrame(rows).to_excel(output_dir / "qrcode_manifest.xlsx", index=False)
    print(f"Generated {len(rows)} QR codes in: {output_dir}")


if __name__ == "__main__":
    main()
