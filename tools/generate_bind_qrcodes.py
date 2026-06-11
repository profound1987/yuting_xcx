import argparse
import re
import zlib
from pathlib import Path
from urllib.parse import urlencode

import pandas as pd
import qrcode


DEVICE_CODE_SALT = "YUNTING-ZHIJIA-DEVICE-CODE-V1"
DEVICE_TYPES = {"AW", "ES", "LC", "SP", "GW"}
DEVICE_NO_RE = re.compile(r"^YT-([A-Z]{2})-([0-9A-F]{5})-([0-9A-F]{4})$")
PIN_RE = re.compile(r"^\d{6}$")


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

        img = qrcode.make(uri)
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
