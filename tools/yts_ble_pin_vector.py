#!/usr/bin/env python3
"""Generate deterministic YTS-BLE-PIN/1 test vector.

YTS-BLE-PIN/1 is the simplified BLE PIN profile:
- production registry stores deviceNo, PIN, and device AES key
- BLE key uses one fixed salt compiled into both Mini Program and device firmware
- bleAesKey = first16(SHA256(deviceNo + "|" + pin + "|" + fixedBleSalt))
- AES-128-CCM encrypts BLE frames
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from cryptography.hazmat.primitives.ciphers.aead import AESCCM

BLE_PIN_KEY_SALT = "YUNTING-ZHIJIA-BLE-PIN-KEY-V1"
SUITE = "YTS-BLE-PIN-SHA256-AES128CCM-V1"


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_bytes(text: str) -> bytes:
    return hashlib.sha256(text.encode("utf-8")).digest()


def derive_ble_aes_key(device_no: str, pin: str) -> tuple[bytes, str]:
    key_material = f"{device_no.upper()}|{pin}|{BLE_PIN_KEY_SALT}"
    return sha256_bytes(key_material)[:16], key_material


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


@dataclass(frozen=True)
class VectorInput:
    device_no: str = "YT-AW-00000-A324"
    pin: str = "123456"
    purpose: str = "provision"
    provision_session_id: str = "ps_test_vector_001"
    ts: int = 1710000000000
    seq: int = 1
    aead_nonce_hex: str = "000102030405060708090a0b"


def generate() -> dict:
    inp = VectorInput()
    device_no = inp.device_no.upper()
    pin = inp.pin

    if not pin.isascii() or not pin.isdigit() or not (4 <= len(pin) <= 8):
        raise ValueError("PIN must be 4-8 ASCII digits")

    ble_aes_key, key_material = derive_ble_aes_key(device_no, pin)

    aead_nonce = bytes.fromhex(inp.aead_nonce_hex)
    aad_obj = {
        "deviceNo": device_no,
        "msgType": "provision.wifi",
        "nonce": aead_nonce.hex(),
        "proto": "YTS-BLE/1",
        "seq": inp.seq,
        "ts": inp.ts,
    }
    aad = canonical_json_bytes(aad_obj)
    plaintext_obj = {
        "apiUrl": "https://yutingsmarthome.xin/api",
        "deviceNo": device_no,
        "heartbeatIntervalMs": 90000,
        "password": "wifi-password",
        "provisionSessionId": inp.provision_session_id,
        "secureProtocol": "YTS-SEC/1-AES-128-CCM",
        "ssid": "Home-WiFi",
        "ts": inp.ts,
        "type": "provision.wifi",
    }
    plaintext = canonical_json_bytes(plaintext_obj)
    encrypted = AESCCM(ble_aes_key, tag_length=16).encrypt(aead_nonce, plaintext, aad)
    ciphertext, tag = encrypted[:-16], encrypted[-16:]

    return {
        "profile": "YTS-BLE-PIN/1",
        "suite": SUITE,
        "hash": "SHA-256",
        "aead": "AES-128-CCM(tagLen=16, nonceLen=12)",
        "inputs": inp.__dict__,
        "blePinKeySalt": BLE_PIN_KEY_SALT,
        "keyMaterialText": key_material,
        "keyMaterialSha256Hex": sha256_hex(key_material),
        "bleAesKeyHex": ble_aes_key.hex(),
        "aeadAadJson": aad.decode("utf-8"),
        "aeadPlaintextJson": plaintext.decode("utf-8"),
        "aeadNonceHex": aead_nonce.hex(),
        "aeadCiphertextHex": ciphertext.hex(),
        "aeadTagHex": tag.hex(),
        "securityNote": "This simple fixed-salt design is easy to implement. If an attacker captures encrypted BLE traffic, an offline PIN guess is possible; use random 8-digit PINs and device-side failure rate limiting.",
    }


if __name__ == "__main__":
    print(json.dumps(generate(), indent=2, ensure_ascii=False))
