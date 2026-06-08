from __future__ import annotations

import json
import ssl
import time
from typing import Any

try:
    import paho.mqtt.client as mqtt
except Exception:  # pragma: no cover - dependency may be absent before install
    mqtt = None

from .database import db, json_dumps, now_ms, row_to_dict
from .logging_config import get_logger, setup_logging
from .services import (
    device_command_payload_for_pull,
    device_secure_message,
    expire_device_commands,
    make_secure_response,
)
from .settings import get_settings


logger = get_logger("yt_mqtt_worker")


def topic_for_device(device_no: str, suffix: str) -> str:
    return f"yt/v1/devices/{device_no}/{suffix}"


class MqttWorker:
    def __init__(self) -> None:
        settings = get_settings()
        if mqtt is None:
            raise RuntimeError("paho-mqtt is not installed; run python3 -m pip install --user -r requirements.txt")
        if not settings.mqtt_username or not settings.mqtt_password:
            raise RuntimeError("YT_MQTT_USERNAME and YT_MQTT_PASSWORD must be configured")

        self.settings = settings
        self.client = mqtt.Client(client_id=settings.mqtt_client_id, clean_session=True)
        self.client.username_pw_set(settings.mqtt_username, settings.mqtt_password)
        if settings.mqtt_tls:
            tls_kwargs: dict[str, Any] = {"cert_reqs": ssl.CERT_REQUIRED}
            if settings.mqtt_ca_file:
                tls_kwargs["ca_certs"] = settings.mqtt_ca_file
            self.client.tls_set(**tls_kwargs)
            self.client.tls_insecure_set(False)
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message

    def on_connect(self, client, _userdata, _flags, rc) -> None:
        if rc != 0:
            logger.error("mqtt_connect_failed rc=%s", rc)
            return
        logger.info("mqtt_connected host=%s port=%s", self.settings.mqtt_host, self.settings.mqtt_port)
        client.subscribe("yt/v1/devices/+/up", qos=1)
        client.subscribe("yt/v1/devices/+/status", qos=1)

    def on_disconnect(self, _client, _userdata, rc) -> None:
        logger.warning("mqtt_disconnected rc=%s", rc)

    def on_message(self, _client, _userdata, message) -> None:
        try:
            payload_text = message.payload.decode("utf-8")
            secure_message = json.loads(payload_text)
            if not isinstance(secure_message, dict):
                raise ValueError("payload is not a JSON object")
        except Exception as error:
            logger.warning("mqtt_invalid_payload topic=%s error=%s", message.topic, error)
            return

        result = device_secure_message(secure_message)
        logger.info(
            "mqtt_up topic=%s success=%s code=%s msgType=%s deviceNo=%s",
            message.topic,
            result.get("success"),
            result.get("code"),
            secure_message.get("msgType"),
            secure_message.get("deviceNo"),
        )

    def connect(self) -> None:
        self.client.connect(self.settings.mqtt_host, self.settings.mqtt_port, keepalive=self.settings.mqtt_keepalive_seconds)
        self.client.loop_start()

    def stop(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()

    def publish_queued_commands(self) -> None:
        current_time = now_ms()
        with db() as connection:
            expire_device_commands(connection, current_time)
            rows = [
                row_to_dict(row)
                for row in connection.execute(
                    """
                    SELECT c.*
                    FROM device_commands c
                    JOIN device_registry d ON d.device_no = c.device_no
                    WHERE c.status = 'queued'
                      AND d.online = 1
                      AND (c.expires_at IS NULL OR c.expires_at >= ?)
                      AND NOT EXISTS (
                        SELECT 1 FROM device_commands inflight
                        WHERE inflight.device_no = c.device_no
                          AND inflight.status IN ('sent', 'received', 'executing')
                          AND (inflight.expires_at IS NULL OR inflight.expires_at >= ?)
                      )
                    ORDER BY c.created_at ASC
                    LIMIT ?
                    """,
                    (current_time, current_time, max(1, self.settings.mqtt_publish_batch_size)),
                ).fetchall()
            ]
            published_devices: set[str] = set()
            for row in rows:
                if not row:
                    continue
                device_no = row["device_no"]
                if device_no in published_devices:
                    continue
                published_devices.add(device_no)
                command_payload = device_command_payload_for_pull(row)
                response = make_secure_response(connection, device_no, "k1", row["command_type"], command_payload)
                secure_payload = response.get("data") if response.get("success") else None
                if not isinstance(secure_payload, dict):
                    logger.warning("mqtt_down_encrypt_failed command=%s device=%s", row["id"], device_no)
                    continue

                sent_at = now_ms()
                connection.execute(
                    """
                    UPDATE device_commands
                    SET status = 'sent', sent_at = ?, failed_reason = ''
                    WHERE id = ? AND device_no = ? AND status = 'queued'
                    """,
                    (sent_at, row["id"], device_no),
                )
                topic = topic_for_device(device_no, "down")
                info = self.client.publish(topic, json_dumps(secure_payload), qos=1, retain=False)
                info.wait_for_publish(timeout=5)
                if info.rc == mqtt.MQTT_ERR_SUCCESS:
                    logger.info("mqtt_down_published command=%s device=%s topic=%s", row["id"], device_no, topic)
                else:
                    logger.warning("mqtt_down_publish_failed command=%s device=%s rc=%s", row["id"], device_no, info.rc)

    def run_forever(self) -> None:
        self.connect()
        try:
            while True:
                self.publish_queued_commands()
                time.sleep(max(0.2, self.settings.mqtt_poll_interval_seconds))
        finally:
            self.stop()


def main() -> None:
    setup_logging()
    worker = MqttWorker()
    worker.run_forever()


if __name__ == "__main__":
    main()
