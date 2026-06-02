import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .settings import get_settings


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_database_dir() -> None:
    db_path = Path(get_settings().database_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)


def connect() -> sqlite3.Connection:
    ensure_database_dir()
    connection = sqlite3.connect(get_settings().database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    connection = connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: str | None, default: Any = None) -> Any:
    if not value:
        return default
    return json.loads(value)


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  phone_masked TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sms_codes (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  scene TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sms_codes_phone_scene ON sms_codes(phone, scene, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS auth_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  phone_masked TEXT,
  event_type TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_openids (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  openid TEXT NOT NULL UNIQUE,
  unionid TEXT,
  appid TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_openids_user ON user_openids(user_id, status);
CREATE INDEX IF NOT EXISTS idx_user_openids_openid ON user_openids(openid);

CREATE TABLE IF NOT EXISTS device_registry (
  device_no TEXT PRIMARY KEY,
  type_code TEXT NOT NULL,
  serial TEXT NOT NULL,
  device_type TEXT NOT NULL,
  type_label TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  bind_status TEXT NOT NULL,
  online INTEGER NOT NULL,
  owner_user_id TEXT,
  mock_scenario TEXT NOT NULL,
  display_status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  last_watering_at TEXT NOT NULL,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(owner_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_device_owner ON device_registry(owner_user_id);

CREATE TABLE IF NOT EXISTS device_bind_events (
  id TEXT PRIMARY KEY,
  device_no TEXT NOT NULL,
  user_id TEXT,
  event_type TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_bind_events_device ON device_bind_events(device_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_bind_events_user ON device_bind_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS device_bind_attempts (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  phone TEXT,
  phone_masked TEXT,
  user_id TEXT,
  input_device_no TEXT NOT NULL,
  normalized_device_no TEXT NOT NULL,
  result TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  reason TEXT NOT NULL,
  client_host TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bind_attempts_phone ON device_bind_attempts(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bind_attempts_device ON device_bind_attempts(normalized_device_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bind_attempts_code ON device_bind_attempts(code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bind_attempts_reason ON device_bind_attempts(reason, created_at DESC);

CREATE TABLE IF NOT EXISTS device_commands (
  id TEXT PRIMARY KEY,
  device_no TEXT NOT NULL,
  user_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  ack_at INTEGER,
  failed_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_commands_device ON device_commands(device_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_user ON device_commands(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_type ON device_commands(command_type, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  detail_json TEXT NOT NULL,
  client_host TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_events(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_events(target_type, target_id, created_at DESC);
"""


def init_db() -> None:
    with db() as connection:
        connection.executescript(SCHEMA)