from functools import lru_cache
import os
from pathlib import Path


def load_env_file() -> None:
    env_path = Path(".env")
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file()


def int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


class Settings:
    database_path: str = os.getenv("YT_DATABASE_PATH", "./data/yunting.db")
    dev_sms_code: str = os.getenv("YT_DEV_SMS_CODE", "123456")
    enable_dev_sms: bool = os.getenv("YT_ENABLE_DEV_SMS", "true").lower() == "true"
    sms_provider: str = os.getenv("YT_SMS_PROVIDER", "aliyun_dypns").lower()
    sms_timeout_seconds: int = int_env("YT_SMS_TIMEOUT_SECONDS", 10)
    aliyun_sms_access_key_id: str = os.getenv("YT_ALIYUN_SMS_ACCESS_KEY_ID", "")
    aliyun_sms_access_key_secret: str = os.getenv("YT_ALIYUN_SMS_ACCESS_KEY_SECRET", "")
    aliyun_sms_sign_name: str = os.getenv("YT_ALIYUN_SMS_SIGN_NAME", "")
    aliyun_sms_template_code: str = os.getenv("YT_ALIYUN_SMS_TEMPLATE_CODE", "")
    aliyun_sms_template_code_key: str = os.getenv("YT_ALIYUN_SMS_TEMPLATE_CODE_KEY", "code")
    aliyun_sms_template_extra_params: str = os.getenv("YT_ALIYUN_SMS_TEMPLATE_EXTRA_PARAMS", "{}")
    aliyun_sms_endpoint: str = os.getenv("YT_ALIYUN_SMS_ENDPOINT", "dypnsapi.aliyuncs.com")
    aliyun_sms_region_id: str = os.getenv("YT_ALIYUN_SMS_REGION_ID", "cn-hangzhou")
    device_code_salt: str = os.getenv("YT_DEVICE_CODE_SALT", "YUNTING-ZHIJIA-DEVICE-CODE-V1")
    wechat_app_id: str = os.getenv("YT_WECHAT_APP_ID", "")
    wechat_app_secret: str = os.getenv("YT_WECHAT_APP_SECRET", "")
    admin_token: str = os.getenv("YT_ADMIN_TOKEN", "")
    bind_failure_warning_threshold: int = int_env("YT_BIND_FAILURE_WARNING_THRESHOLD", 3)
    bind_failure_lock_threshold: int = int_env("YT_BIND_FAILURE_LOCK_THRESHOLD", 10)
    bind_failure_lock_hours: int = int_env("YT_BIND_FAILURE_LOCK_HOURS", 24)
    mqtt_enabled: bool = os.getenv("YT_MQTT_ENABLED", "true").lower() == "true"
    mqtt_host: str = os.getenv("YT_MQTT_HOST", "yutingsmarthome.xin")
    mqtt_port: int = int_env("YT_MQTT_PORT", 8883)
    mqtt_tls: bool = os.getenv("YT_MQTT_TLS", "true").lower() == "true"
    mqtt_ca_file: str = os.getenv("YT_MQTT_CA_FILE", "")
    mqtt_client_id: str = os.getenv("YT_MQTT_CLIENT_ID", "yt_cloud_worker")
    mqtt_username: str = os.getenv("YT_MQTT_USERNAME", "")
    mqtt_password: str = os.getenv("YT_MQTT_PASSWORD", "")
    mqtt_device_password: str = os.getenv("YT_MQTT_DEVICE_PASSWORD", "")
    mqtt_keepalive_seconds: int = int_env("YT_MQTT_KEEPALIVE_SECONDS", 90)
    mqtt_poll_interval_seconds: float = float_env("YT_MQTT_POLL_INTERVAL_SECONDS", 1.0)
    mqtt_publish_batch_size: int = int_env("YT_MQTT_PUBLISH_BATCH_SIZE", 20)
    allowed_origins: list[str] = [
        item.strip()
        for item in os.getenv("YT_ALLOWED_ORIGINS", "*").split(",")
        if item.strip()
    ]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()