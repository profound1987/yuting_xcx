from __future__ import annotations

import json
import os
import secrets
import ssl
import time
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt
from cryptography.hazmat.primitives.ciphers.aead import AESCCM


SECURE_ALG = "AES-128-CCM"
SECURE_PROTOCOL_VERSION = 1
SECURE_TAG_LENGTH = 16
SECURE_NONCE_LENGTH = 13
DEV_ZERO_DEVICE_KEY = bytes(16)


def b64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return __import__("base64").urlsafe_b64decode((value + padding).encode("ascii"))


def b64url_encode(value: bytes) -> str:
    return __import__("base64").urlsafe_b64encode(value).decode("ascii").rstrip("=")


def secure_aad(device_no: str, key_id: str, msg_type: str, seq: int, ts: int, nonce_b64: str) -> bytes:
    return "\n".join([
        "YTS-SEC/1",
        SECURE_ALG,
        device_no,
        key_id,
        msg_type,
        str(seq),
        str(ts),
        nonce_b64,
    ]).encode("utf-8")


class SimDevice:
    def __init__(self) -> None:
        self.device_no = os.environ["YT_TEST_MQTT_DEVICE_NO"]
        self.username = os.environ["YT_TEST_MQTT_USERNAME"]
        self.password = os.environ["YT_TEST_MQTT_PASSWORD"]
        self.host = os.getenv("YT_TEST_MQTT_HOST", "yutingsmarthome.xin")
        self.port = int(os.getenv("YT_TEST_MQTT_PORT", "8883"))
        self.key_id = os.getenv("YT_TEST_DEVICE_KEY_ID", "k1")
        self.key = bytes.fromhex(os.getenv("YT_TEST_DEVICE_KEY_HEX", "0" * 32))
        self.seq = 1
        self.client = mqtt.Client(client_id=f"sim_{self.device_no}", clean_session=True)
        self.client.username_pw_set(self.username, self.password)
        self.client.tls_set(cert_reqs=ssl.CERT_REQUIRED)
        self.client.tls_insecure_set(False)
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message

    def encrypt(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        seq = self.seq
        self.seq += 1
        ts = int(time.time() * 1000)
        nonce = bytes([0x01]) + secrets.token_bytes(8) + seq.to_bytes(4, "big")
        nonce_b64 = b64url_encode(nonce)
        plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        aad = secure_aad(self.device_no, self.key_id, msg_type, seq, ts, nonce_b64)
        encrypted = AESCCM(self.key, tag_length=SECURE_TAG_LENGTH).encrypt(nonce, plaintext, aad)
        return {
            "v": SECURE_PROTOCOL_VERSION,
            "alg": SECURE_ALG,
            "deviceNo": self.device_no,
            "keyId": self.key_id,
            "msgType": msg_type,
            "seq": seq,
            "ts": ts,
            "nonce": nonce_b64,
            "ciphertext": b64url_encode(encrypted[:-SECURE_TAG_LENGTH]),
            "tag": b64url_encode(encrypted[-SECURE_TAG_LENGTH:]),
        }

    def decrypt(self, envelope: dict[str, Any]) -> dict[str, Any]:
        nonce_b64 = str(envelope["nonce"])
        nonce = b64url_decode(nonce_b64)
        ciphertext = b64url_decode(str(envelope["ciphertext"]))
        tag = b64url_decode(str(envelope["tag"]))
        aad = secure_aad(
            str(envelope["deviceNo"]),
            str(envelope.get("keyId") or "k1"),
            str(envelope["msgType"]),
            int(envelope["seq"]),
            int(envelope["ts"]),
            nonce_b64,
        )
        plaintext = AESCCM(self.key, tag_length=SECURE_TAG_LENGTH).decrypt(nonce, ciphertext + tag, aad)
        return json.loads(plaintext.decode("utf-8"))

    def publish_secure(self, suffix: str, msg_type: str, payload: dict[str, Any], retain: bool = False, qos: int = 1) -> None:
        topic = f"yt/v1/devices/{self.device_no}/{suffix}"
        self.client.publish(topic, json.dumps(self.encrypt(msg_type, payload), separators=(",", ":")), qos=qos, retain=retain)

    def on_connect(self, client, _userdata, _flags, rc) -> None:
        print(f"connected rc={rc}", flush=True)
        client.subscribe(f"yt/v1/devices/{self.device_no}/down", qos=1)
        self.publish_secure("status", "device.status", {"online": True}, retain=True, qos=1)
        self.publish_secure("up", "device.boot", {"fwVersion": "sim-0.1.0", "reason": "mqtt_sim"}, retain=False, qos=1)

    def on_message(self, _client, _userdata, message) -> None:
        envelope = json.loads(message.payload.decode("utf-8"))
        payload = self.decrypt(envelope)
        msg_type = envelope.get("msgType")
        print(f"down msgType={msg_type} payload={payload}", flush=True)
        cmd_id = payload.get("cmdId")
        if not cmd_id:
            return
        for status in ("received", "executing", "succeeded"):
            self.publish_secure("up", "command.ack", {"cmdId": cmd_id, "status": status}, retain=False, qos=1)
            print(f"ack {status} cmdId={cmd_id}", flush=True)
            time.sleep(0.5)

    def run(self) -> None:
        self.client.connect(self.host, self.port, keepalive=90)
        self.client.loop_forever()


if __name__ == "__main__":
    env_file = Path("mqtt_test_device.env")
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key, value)
    SimDevice().run()
