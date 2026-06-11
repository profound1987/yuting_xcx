import argparse
import re
import secrets
import zlib
from pathlib import Path

import pandas as pd


DEVICE_CODE_SALT = "YUNTING-ZHIJIA-DEVICE-CODE-V1"
DEVICE_TYPES = {"AW", "ES", "LC", "SP", "GW"}
TYPE_RE = re.compile(r"^(?:YT-)?([A-Z]{2})$")
SERIAL_RE = re.compile(r"^[0-9A-F]{5}$")


def crc_check_code(body):
    payload = f"{body}|{DEVICE_CODE_SALT}".upper().encode("ascii")
    return f"{zlib.crc32(payload) & 0xffffffff:08X}"[-4:]


def normalize_type_code(value):
    text = str(value or "").strip().upper()
    matched = TYPE_RE.match(text)
    if not matched:
        raise ValueError("Device type must be like AW or YT-AW")
    type_code = matched.group(1)
    if type_code not in DEVICE_TYPES:
        raise ValueError(f"Unsupported device type: {type_code}")
    return type_code


def parse_start_serial(value):
    text = str(value or "").strip().upper()
    if not SERIAL_RE.match(text):
        raise ValueError("Start serial must be exactly 5 hex characters, e.g. 00100")
    return int(text, 16)


def create_device_no(type_code, serial_number):
    serial = f"{serial_number:05X}"
    body = f"YT-{type_code}-{serial}"
    return f"{body}-{crc_check_code(body)}", serial


def create_pin():
    return f"{secrets.randbelow(1_000_000):06d}"


def create_aes_key_hex():
    return secrets.token_hex(16).upper()


def resolve_output_path(output, first_device_no):
    if not output:
        return Path(f"{first_device_no}.xlsx")
    path = Path(output)
    if path.suffix.lower() == ".xlsx":
        return path
    return path / f"{first_device_no}.xlsx"


def build_rows(type_code, start_serial_number, count):
    rows = []
    for offset in range(count):
        serial_number = start_serial_number + offset
        if serial_number > 0xFFFFF:
            raise ValueError("Serial range exceeds FFFFF")
        device_no, serial = create_device_no(type_code, serial_number)
        rows.append(
            {
                "deviceid": device_no,
                "pin": create_pin(),
                "aesKeyHex": create_aes_key_hex(),
                "keyId": "k1",
                "typeCode": type_code,
                "serial": serial,
            }
        )
    return rows


def main():
    parser = argparse.ArgumentParser(
        description="Generate device registry xlsx with deviceNo, PIN, and 16-byte AES key."
    )
    parser.add_argument("device_type", help="Device type, e.g. YT-AW or AW")
    parser.add_argument("start_serial", help="Start serial: exactly 5 hex characters, e.g. 00100 or 001AF")
    parser.add_argument("count", type=int, help="Number of devices to generate")
    parser.add_argument("-o", "--output", default="", help="Output directory or .xlsx path. Default: <firstDeviceNo>.xlsx")
    args = parser.parse_args()

    if args.count <= 0:
        raise SystemExit("count must be greater than 0")

    try:
        type_code = normalize_type_code(args.device_type)
        start_serial_number = parse_start_serial(args.start_serial)
        rows = build_rows(type_code, start_serial_number, args.count)
    except ValueError as error:
        raise SystemExit(str(error))

    first_device_no = rows[0]["deviceid"]
    output_path = resolve_output_path(args.output, first_device_no)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    pd.DataFrame(rows).to_excel(output_path, index=False)
    print(f"Generated {len(rows)} devices: {output_path}")


if __name__ == "__main__":
    main()
