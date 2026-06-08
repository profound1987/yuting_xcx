from __future__ import annotations

import argparse
import base64
import json
import secrets
import time
import urllib.request
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESCCM


SECURE_ALG = "AES-128-CCM"
TAG_LENGTH = 16


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode((text + "=" * ((4 - len(text) % 4) % 4)).encode())


def secure_aad(device_no: str, key_id: str, msg_type: str, seq: int, ts: int, nonce_b64: str) -> bytes:
    return "\n".join(["YTS-SEC/1", SECURE_ALG, device_no, key_id, msg_type, str(seq), str(ts), nonce_b64]).encode()


class Codec:
    def __init__(self, device_no: str, key_hex: str = "0" * 32, key_id: str = "k1") -> None:
        self.device_no = device_no
        self.key_id = key_id
        self.key = bytes.fromhex(key_hex)
        self.seq = 5000

    def encrypt(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.seq += 1
        ts = int(time.time() * 1000)
        nonce = bytes([1]) + secrets.token_bytes(8) + self.seq.to_bytes(4, "big")
        nonce_b64 = b64url_encode(nonce)
        plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        encrypted = AESCCM(self.key, tag_length=TAG_LENGTH).encrypt(
            nonce,
            plaintext,
            secure_aad(self.device_no, self.key_id, msg_type, self.seq, ts, nonce_b64),
        )
        return {
            "v": 1,
            "alg": SECURE_ALG,
            "deviceNo": self.device_no,
            "keyId": self.key_id,
            "msgType": msg_type,
            "seq": self.seq,
            "ts": ts,
            "nonce": nonce_b64,
            "ciphertext": b64url_encode(encrypted[:-TAG_LENGTH]),
            "tag": b64url_encode(encrypted[-TAG_LENGTH:]),
        }

    def decrypt(self, envelope: dict[str, Any]) -> dict[str, Any]:
        nonce_b64 = envelope["nonce"]
        plaintext = AESCCM(self.key, tag_length=TAG_LENGTH).decrypt(
            b64url_decode(nonce_b64),
            b64url_decode(envelope["ciphertext"]) + b64url_decode(envelope["tag"]),
            secure_aad(
                envelope["deviceNo"],
                envelope.get("keyId", "k1"),
                envelope["msgType"],
                int(envelope["seq"]),
                int(envelope["ts"]),
                nonce_b64,
            ),
        )
        return json.loads(plaintext.decode())


def call_api(api_url: str, type_name: str, data: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        api_url,
        data=json.dumps({"type": type_name, "data": data}, ensure_ascii=False, separators=(",", ":")).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode())


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate provision.ack MQTT config.")
    parser.add_argument("--api-url", default="https://yutingsmarthome.xin/api")
    parser.add_argument("--device-no", default="YT-AW-00001-4BF5")
    parser.add_argument("--phone", default="13800009999")
    args = parser.parse_args()

    codec = Codec(args.device_no)
    prepare = call_api(args.api_url, "device.prepareConfigure", {"phone": args.phone, "deviceNo": args.device_no})
    print("PREPARE success=%s code=%s heartbeat=%s" % (prepare.get("success"), prepare.get("code"), (prepare.get("data") or {}).get("heartbeatIntervalMs")))
    if not prepare.get("success"):
        raise SystemExit(1)
    provision = call_api(
        args.api_url,
        "device.secureMessage",
        codec.encrypt(
            "provision.result",
            {"result": "success", "provisionSessionId": prepare["data"]["provisionSessionId"], "fwVersion": "provision-validator"},
        ),
    )
    payload = codec.decrypt(provision["data"]) if provision.get("success") else {}
    mqtt = payload.get("mqtt") or {}
    tls = mqtt.get("tls") or {}
    print(
        "PROVISION_ACK success=%s msgType=%s heartbeat=%s mqttEnabled=%s host=%s port=%s tlsVerify=%s caName=%s passwordPresent=%s caPemPresent=%s"
        % (
            provision.get("success"),
            (provision.get("data") or {}).get("msgType"),
            payload.get("heartbeatIntervalMs"),
            mqtt.get("enabled"),
            mqtt.get("host"),
            mqtt.get("port"),
            tls.get("verifyRequired"),
            tls.get("caName"),
            bool(mqtt.get("password")),
            bool(tls.get("caPem")),
        )
    )
    if payload.get("heartbeatIntervalMs") != 90000 or not mqtt.get("enabled") or tls.get("verifyRequired") is not True:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
