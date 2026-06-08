from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import ssl
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt
from cryptography.hazmat.primitives.ciphers.aead import AESCCM


SECURE_ALG = "AES-128-CCM"
SECURE_PROTOCOL_VERSION = 1
SECURE_TAG_LENGTH = 16


def b64url_decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


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


class SecureCodec:
    def __init__(self, device_no: str, key_hex: str, key_id: str = "k1") -> None:
        self.device_no = device_no
        self.key_id = key_id
        self.key = bytes.fromhex(key_hex)
        self.seq = 1000

    def encrypt(self, msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.seq += 1
        seq = self.seq
        ts = int(time.time() * 1000)
        nonce = bytes([0x01]) + secrets.token_bytes(8) + seq.to_bytes(4, "big")
        nonce_b64 = b64url_encode(nonce)
        plaintext = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        encrypted = AESCCM(self.key, tag_length=SECURE_TAG_LENGTH).encrypt(
            nonce,
            plaintext,
            secure_aad(self.device_no, self.key_id, msg_type, seq, ts, nonce_b64),
        )
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
        plaintext = AESCCM(self.key, tag_length=SECURE_TAG_LENGTH).decrypt(
            nonce,
            ciphertext + tag,
            secure_aad(
                str(envelope["deviceNo"]),
                str(envelope.get("keyId") or "k1"),
                str(envelope["msgType"]),
                int(envelope["seq"]),
                int(envelope["ts"]),
                nonce_b64,
            ),
        )
        return json.loads(plaintext.decode("utf-8"))


def call_api(api_url: str, type_name: str, data: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps({"type": type_name, "data": data}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(api_url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def import_server_app(server_root: str) -> None:
    root = Path(server_root).resolve()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def create_test_command(server_root: str, device_no: str, duration_seconds: int) -> str:
    import_server_app(server_root)
    from app.database import db, now_ms
    from app.services import create_command

    with db() as connection:
        device = connection.execute("SELECT owner_user_id FROM device_registry WHERE device_no = ?", (device_no,)).fetchone()
        user_id = device["owner_user_id"] if device and device["owner_user_id"] else "seed_bound_online_user"
        current_time = now_ms()
        connection.execute(
            "UPDATE device_registry SET online = 1, display_status = '在线', last_seen_at = ?, updated_at = ? WHERE device_no = ?",
            (current_time, current_time, device_no),
        )
        cmd_id = create_command(
            connection,
            user_id,
            device_no,
            "watering.manual.start",
            {"durationSeconds": duration_seconds},
            "queued",
            ttl_seconds=30,
        )
        return cmd_id


def command_status(server_root: str, cmd_id: str) -> dict[str, Any] | None:
    import_server_app(server_root)
    from app.database import db

    with db() as connection:
        row = connection.execute(
            """
            SELECT id, device_no, command_type, status, sent_at, received_at, executing_at, ack_at, result_code
            FROM device_commands WHERE id = ?
            """,
            (cmd_id,),
        ).fetchone()
        return dict(row) if row else None


def validate(args: argparse.Namespace) -> None:
    codec = SecureCodec(args.device_no, args.key_hex, args.key_id)
    bootstrap = call_api(
        args.api_url,
        "device.secureMessage",
        codec.encrypt("bootstrap.request", {"reason": "mqtt_e2e_validation", "fwVersion": "validator-1"}),
    )
    if not bootstrap.get("success"):
        raise RuntimeError(f"bootstrap failed: {bootstrap.get('code')} {bootstrap.get('message')}")
    bootstrap_payload = codec.decrypt(bootstrap["data"])
    mqtt_config = bootstrap_payload.get("mqtt") or {}
    tls_config = mqtt_config.get("tls") or {}
    print(
        "BOOTSTRAP_OK heartbeat=%s mqttEnabled=%s host=%s port=%s tlsVerify=%s caName=%s passwordPresent=%s"
        % (
            bootstrap_payload.get("heartbeatIntervalMs"),
            mqtt_config.get("enabled"),
            mqtt_config.get("host"),
            mqtt_config.get("port"),
            tls_config.get("verifyRequired"),
            tls_config.get("caName"),
            bool(mqtt_config.get("password")),
        )
    )
    if not mqtt_config.get("enabled") or not mqtt_config.get("password"):
        raise RuntimeError("mqtt config is not enabled or password is missing")
    if tls_config.get("verifyRequired") is not True:
        raise RuntimeError("TLS verifyRequired must be true")

    cmd_id_holder: dict[str, str] = {}
    succeeded = {"value": False}
    received_down = {"value": False}

    client = mqtt.Client(client_id=f"yt_validator_{args.device_no}_{secrets.token_hex(3)}", clean_session=True)
    client.username_pw_set(str(mqtt_config["username"]), str(mqtt_config["password"]))

    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".pem", encoding="utf-8") as ca_file:
        ca_file.write(str(tls_config.get("caPem") or ""))
        ca_path = ca_file.name
    try:
        client.tls_set(ca_certs=ca_path, cert_reqs=ssl.CERT_REQUIRED)
        client.tls_insecure_set(False)

        def publish_secure(suffix: str, msg_type: str, payload: dict[str, Any], retain: bool = False, qos: int = 1) -> None:
            topic = f"yt/v1/devices/{args.device_no}/{suffix}"
            client.publish(topic, json.dumps(codec.encrypt(msg_type, payload), ensure_ascii=False, separators=(",", ":")), qos=qos, retain=retain)

        def on_connect(_client, _userdata, _flags, rc):
            print(f"MQTT_CONNECT rc={rc}")
            if rc != 0:
                return
            client.subscribe(f"yt/v1/devices/{args.device_no}/down", qos=1)
            publish_secure("status", "device.status", {"online": True, "source": "validator"}, retain=True, qos=1)
            publish_secure("up", "device.boot", {"fwVersion": "validator-1", "reason": "mqtt_e2e_validation"}, qos=1)
            cmd_id_holder["id"] = create_test_command(args.server_root, args.device_no, args.duration_seconds)
            print(f"COMMAND_CREATED id={cmd_id_holder['id']}")

        def on_message(_client, _userdata, message):
            envelope = json.loads(message.payload.decode("utf-8"))
            payload = codec.decrypt(envelope)
            msg_type = envelope.get("msgType")
            received_down["value"] = True
            print(f"DOWN_RECEIVED msgType={msg_type} cmdId={payload.get('cmdId')}")
            cmd_id = payload.get("cmdId")
            if not cmd_id:
                return
            for status in ("received", "executing", "succeeded"):
                ack_payload = {"cmdId": cmd_id, "status": status, "code": "OK" if status == "succeeded" else ""}
                publish_secure("up", "command.ack", ack_payload, qos=1)
                print(f"ACK_SENT status={status}")
                time.sleep(0.3)
            succeeded["value"] = True
            client.disconnect()

        client.on_connect = on_connect
        client.on_message = on_message
        client.connect(str(mqtt_config["host"]), int(mqtt_config["port"]), keepalive=int(mqtt_config.get("keepAliveSeconds") or 90))
        started = time.time()
        client.loop_start()
        try:
            while time.time() - started < args.timeout_seconds and not succeeded["value"]:
                time.sleep(0.2)
        finally:
            client.loop_stop()
            client.disconnect()
    finally:
        try:
            os.unlink(ca_path)
        except OSError:
            pass

    if not received_down["value"]:
        raise RuntimeError("did not receive down command")
    cmd_id = cmd_id_holder.get("id")
    status = command_status(args.server_root, cmd_id) if cmd_id else None
    print(f"COMMAND_STATUS {status}")
    if not status or status.get("status") != "succeeded":
        raise RuntimeError("command did not reach succeeded")


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate Yunting MQTTS bootstrap and command ACK loop.")
    parser.add_argument("--api-url", default="https://yutingsmarthome.xin/api")
    parser.add_argument("--server-root", default=".")
    parser.add_argument("--device-no", default="YT-AW-00000-A324")
    parser.add_argument("--key-id", default="k1")
    parser.add_argument("--key-hex", default="0" * 32)
    parser.add_argument("--duration-seconds", type=int, default=2)
    parser.add_argument("--timeout-seconds", type=int, default=20)
    args = parser.parse_args()
    validate(args)


if __name__ == "__main__":
    main()
