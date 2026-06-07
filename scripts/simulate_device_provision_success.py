#!/usr/bin/env python3
"""Simulate a device provisioning success report with YTS-SEC/1 AES-128-CCM.

This script intentionally does NOT call device.bind. It only:
1. Creates a temporary provision session via device.prepareConfigure.
2. Builds the exact device.secureMessage envelope that firmware should send after Wi-Fi succeeds.
3. Sends it to the server and decrypts the server's provision.ack response.
4. Optionally checks provision status for the session.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.request
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESCCM


API_URL = os.getenv("YT_API_URL", "https://yutingsmarthome.xin/api")
DEVICE_NO = os.getenv("YT_DEVICE_NO", "YT-AW-00000-A324")
KEY_ID = os.getenv("YT_KEY_ID", "k1")
# Current BL616CL test key: 16 bytes of 0x00.
DEVICE_KEY_HEX = os.getenv("YT_DEVICE_KEY_HEX", "00000000000000000000000000000000")
# Valid test phone used only to create an isolated provision session. No bind is performed.
TEST_PHONE = os.getenv("YT_TEST_PHONE", "13900000001")

SECURE_PROTOCOL_VERSION = 1
SECURE_ALG = "AES-128-CCM"
TAG_LEN = 16


def now_ms() -> int:
    return int(time.time() * 1000)


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def b64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def secure_aad(device_no: str, key_id: str, msg_type: str, seq: int, ts: int, nonce_b64: str) -> bytes:
    return "\n".join(
        [
            "YTS-SEC/1",
            SECURE_ALG,
            device_no,
            key_id,
            msg_type,
            str(seq),
            str(ts),
            nonce_b64,
        ]
    ).encode("utf-8")


def post_api(api_type: str, data: dict[str, Any]) -> dict[str, Any]:
    body = json_dumps({"type": api_type, "data": data}).encode("utf-8")
    request = urllib.request.Request(
        API_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def build_secure_message(msg_type: str, seq: int, payload: dict[str, Any]) -> tuple[dict[str, Any], str, bytes]:
    key = bytes.fromhex(DEVICE_KEY_HEX)
    ts = now_ms()
    # nonce = direction(0x01 device->cloud) || bootRandom(8 bytes) || seq(4 bytes big-endian)
    nonce = bytes([0x01]) + os.urandom(8) + seq.to_bytes(4, "big")
    nonce_b64 = b64url_encode(nonce)
    plaintext = json_dumps(payload).encode("utf-8")
    aad = secure_aad(DEVICE_NO, KEY_ID, msg_type, seq, ts, nonce_b64)
    encrypted = AESCCM(key, tag_length=TAG_LEN).encrypt(nonce, plaintext, aad)
    secure_message = {
        "v": SECURE_PROTOCOL_VERSION,
        "alg": SECURE_ALG,
        "deviceNo": DEVICE_NO,
        "keyId": KEY_ID,
        "msgType": msg_type,
        "seq": seq,
        "ts": ts,
        "nonce": nonce_b64,
        "ciphertext": b64url_encode(encrypted[:-TAG_LEN]),
        "tag": b64url_encode(encrypted[-TAG_LEN:]),
    }
    return secure_message, plaintext.decode("utf-8"), aad


def decrypt_secure_response(data: dict[str, Any]) -> dict[str, Any]:
    key = bytes.fromhex(DEVICE_KEY_HEX)
    nonce = b64url_decode(data["nonce"])
    ciphertext = b64url_decode(data["ciphertext"])
    tag = b64url_decode(data["tag"])
    aad = secure_aad(
        data["deviceNo"],
        data["keyId"],
        data["msgType"],
        int(data["seq"]),
        int(data["ts"]),
        data["nonce"],
    )
    plaintext = AESCCM(key, tag_length=TAG_LEN).decrypt(nonce, ciphertext + tag, aad)
    return json.loads(plaintext.decode("utf-8"))


def pretty(title: str, value: Any) -> None:
    print(f"\n=== {title} ===")
    if isinstance(value, (dict, list)):
        print(json.dumps(value, ensure_ascii=False, indent=2))
    else:
        print(value)


def main() -> None:
    print(f"API_URL={API_URL}")
    print(f"DEVICE_NO={DEVICE_NO}")
    print(f"KEY_ID={KEY_ID}")
    print(f"TEST_PHONE={TEST_PHONE}")

    prepare_request = {"phone": TEST_PHONE, "deviceNo": DEVICE_NO}
    pretty("1. device.prepareConfigure request", {"type": "device.prepareConfigure", "data": prepare_request})
    prepare_response = post_api("device.prepareConfigure", prepare_request)
    pretty("1. device.prepareConfigure response", prepare_response)
    if not prepare_response.get("success"):
        raise SystemExit("device.prepareConfigure failed; cannot simulate a successful provision.result without a valid provisionSessionId.")

    provision_session_id = prepare_response["data"]["provisionSessionId"]
    heartbeat_interval_ms = prepare_response["data"].get("heartbeatIntervalMs", 30000)

    provision_payload = {
        "provisionSessionId": provision_session_id,
        "result": "success",
        "fwVersion": "0.1.0-test",
        "deviceType": "watering",
        "bootReason": "power_on",
        "uptimeMs": 12000,
        "network": {
            "wifiSsidHash": "",
            "wifiRssi": -55,
            "localIp": "192.168.1.24",
            "mac": "AA:BB:CC:DD:EE:FF",
        },
        "capabilities": ["watering", "telemetry", "commandAck"],
        "errors": [],
    }
    secure_message, plaintext_json, aad = build_secure_message("provision.result", 1, provision_payload)
    pretty("2. Device plaintext payload before AES-CCM", json.loads(plaintext_json))
    pretty("3. AES-CCM AAD string", aad.decode("utf-8"))
    pretty("4. device.secureMessage request data sent by device", secure_message)

    secure_response = post_api("device.secureMessage", secure_message)
    pretty("5. Raw server response", secure_response)
    if secure_response.get("success") and isinstance(secure_response.get("data"), dict) and secure_response["data"].get("msgType") == "provision.ack":
        ack_payload = decrypt_secure_response(secure_response["data"])
        pretty("6. Decrypted provision.ack payload", ack_payload)

    status_request = {"phone": TEST_PHONE, "deviceNo": DEVICE_NO, "provisionSessionId": provision_session_id}
    status_response = post_api("device.checkProvisionStatus", status_request)
    pretty("7. device.checkProvisionStatus response after simulated device report", status_response)

    print("\nNOTE: device.bind was NOT called. This simulation should not bind the device to the test phone.")
    print(f"Provision session created for test only: {provision_session_id}")
    print(f"Heartbeat interval from server: {heartbeat_interval_ms} ms")


if __name__ == "__main__":
    main()
