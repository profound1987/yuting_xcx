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
  heartbeat_interval_ms INTEGER NOT NULL DEFAULT 30000,
  last_heartbeat_at INTEGER,
  last_boot_at INTEGER,
  last_status_at INTEGER,
  last_seen_at INTEGER,
  last_telemetry_at INTEGER,
  telemetry_json TEXT NOT NULL DEFAULT '{}',
  capability_state TEXT NOT NULL DEFAULT 'pending',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  config_state TEXT NOT NULL DEFAULT 'unconfigured',
  desired_config_json TEXT,
  desired_config_version INTEGER NOT NULL DEFAULT 0,
  desired_config_hash TEXT,
  applied_config_json TEXT,
  applied_config_version INTEGER NOT NULL DEFAULT 0,
  applied_config_hash TEXT,
  pending_command_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(owner_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_device_owner ON device_registry(owner_user_id);

CREATE TABLE IF NOT EXISTS device_keys (
  device_no TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  device_key_hex TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(device_no) REFERENCES device_registry(device_no)
);

CREATE TABLE IF NOT EXISTS device_provision_sessions (
  id TEXT PRIMARY KEY,
  device_no TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ready_at INTEGER,
  bound_at INTEGER,
  last_online_at INTEGER,
  auth_verified INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL DEFAULT '{}',
  dev_bypass INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(device_no) REFERENCES device_registry(device_no),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_provision_sessions_device ON device_provision_sessions(device_no, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_provision_sessions_user ON device_provision_sessions(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_provision_sessions_expires ON device_provision_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS device_message_nonces (
  device_no TEXT NOT NULL,
  nonce TEXT NOT NULL,
  msg_type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(device_no, nonce)
);

CREATE INDEX IF NOT EXISTS idx_device_message_nonces_created ON device_message_nonces(created_at DESC);

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
  received_at INTEGER,
  executing_at INTEGER,
  ack_at INTEGER,
  expires_at INTEGER,
  failed_reason TEXT,
  result_code TEXT,
  result_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_device_commands_device ON device_commands(device_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_user ON device_commands(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_type ON device_commands(command_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_status ON device_commands(device_no, status, created_at ASC);

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


def column_names(connection: sqlite3.Connection, table: str) -> set[str]:
    rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"] for row in rows}


def add_column_if_missing(connection: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    if column not in column_names(connection, table):
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def apply_migrations(connection: sqlite3.Connection) -> None:
    add_column_if_missing(connection, "device_registry", "heartbeat_interval_ms", "INTEGER NOT NULL DEFAULT 30000")
    add_column_if_missing(connection, "device_registry", "last_heartbeat_at", "INTEGER")
    add_column_if_missing(connection, "device_registry", "last_boot_at", "INTEGER")
    add_column_if_missing(connection, "device_registry", "last_status_at", "INTEGER")
    add_column_if_missing(connection, "device_registry", "last_seen_at", "INTEGER")
    add_column_if_missing(connection, "device_registry", "last_telemetry_at", "INTEGER")
    add_column_if_missing(connection, "device_registry", "telemetry_json", "TEXT NOT NULL DEFAULT '{}'")
    add_column_if_missing(connection, "device_registry", "capability_state", "TEXT NOT NULL DEFAULT 'pending'")
    add_column_if_missing(connection, "device_registry", "capabilities_json", "TEXT NOT NULL DEFAULT '{}'")
    add_column_if_missing(connection, "device_registry", "config_state", "TEXT NOT NULL DEFAULT 'unconfigured'")
    add_column_if_missing(connection, "device_registry", "desired_config_json", "TEXT")
    add_column_if_missing(connection, "device_registry", "desired_config_version", "INTEGER NOT NULL DEFAULT 0")
    add_column_if_missing(connection, "device_registry", "desired_config_hash", "TEXT")
    add_column_if_missing(connection, "device_registry", "applied_config_json", "TEXT")
    add_column_if_missing(connection, "device_registry", "applied_config_version", "INTEGER NOT NULL DEFAULT 0")
    add_column_if_missing(connection, "device_registry", "applied_config_hash", "TEXT")
    add_column_if_missing(connection, "device_registry", "pending_command_id", "TEXT")
    add_column_if_missing(connection, "device_commands", "received_at", "INTEGER")
    add_column_if_missing(connection, "device_commands", "executing_at", "INTEGER")
    add_column_if_missing(connection, "device_commands", "expires_at", "INTEGER")
    add_column_if_missing(connection, "device_commands", "result_code", "TEXT")
    add_column_if_missing(connection, "device_commands", "result_json", "TEXT NOT NULL DEFAULT '{}'")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_device_commands_status ON device_commands(device_no, status, created_at ASC)")


def init_db() -> None:
    with db() as connection:
        connection.executescript(SCHEMA)
        apply_migrations(connection)