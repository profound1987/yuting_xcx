import json
import hashlib
import hmac
import re
import secrets
import time
import urllib.parse
import urllib.request
import zlib
from typing import Any

from .database import db, json_dumps, json_loads, now_ms, row_to_dict
from .responses import fail, ok
from .settings import get_settings
from .sms import SmsError, send_sms_code


DEVICE_TYPES = [
    {"label": "智能浇水设备", "value": "watering", "code": "AW"},
    {"label": "环境传感器", "value": "sensor", "code": "ES"},
    {"label": "智能灯控", "value": "light", "code": "LC"},
    {"label": "智能插座", "value": "socket", "code": "SP"},
    {"label": "智能网关", "value": "gateway", "code": "GW"},
]

DEVICE_NO_PATTERN = re.compile(r"^YT-([A-Z]{2})-([0-9A-F]{5})-([0-9A-F]{4})$")
PHONE_PATTERN = re.compile(r"^1[3-9]\d{9}$")
SEED_BOUND_USER_ID = "seed_bound_user"
SEED_BOUND_ONLINE_USER_ID = "seed_bound_online_user"
SEED_BOUND_OFFLINE_USER_ID = "seed_bound_offline_user"
SEED_BOUND_ONLINE_PHONE = "11111111111"
SEED_BOUND_OFFLINE_PHONE = "00000000000"
SEED_USER_IDS = (SEED_BOUND_USER_ID, SEED_BOUND_ONLINE_USER_ID, SEED_BOUND_OFFLINE_USER_ID)
SEED_DEFAULT_USER_IDS = (SEED_BOUND_ONLINE_USER_ID, SEED_BOUND_OFFLINE_USER_ID)
SEED_ADMIN_QUERY_PHONES = (SEED_BOUND_ONLINE_PHONE, SEED_BOUND_OFFLINE_PHONE)
SEED_SCENARIOS = ("sale-unbound-online", "sale-bound-online", "sale-bound-offline")


def make_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(16)}"


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def mask_phone(phone: str) -> str:
    return f"{phone[:3]}****{phone[-4:]}"


def sql_marks(values: tuple[Any, ...]) -> str:
    return ",".join("?" for _ in values)


def is_admin_query_phone(phone: str) -> bool:
    return bool(PHONE_PATTERN.match(phone) or phone in SEED_ADMIN_QUERY_PHONES)


def format_time(value: int | None) -> str:
    if not value:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(value / 1000))


def rows_to_dicts(rows) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def read_limit(data: dict[str, Any], default: int = 20, maximum: int = 100) -> int:
    try:
        value = int(data.get("limit", default))
    except (TypeError, ValueError):
        value = default
    return max(1, min(value, maximum))


def read_since_ms(data: dict[str, Any]) -> int | None:
    value = data.get("sinceMs") or data.get("since")
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_device_no(value: str | None) -> str:
    return (value or "").strip().upper()


def default_watering_config() -> dict[str, Any]:
    return {
        "mode": "demand",
        "demand": {"intervalHours": 4, "threshold": 35, "durationSeconds": 20},
        "schedule": {"intervalDays": 1, "times": 2, "durationSeconds": 30},
        "manual": {"durationSeconds": 10},
    }


def crc_check_code(body: str) -> str:
    payload = f"{body}|{get_settings().device_code_salt}".upper().encode("ascii")
    return f"{zlib.crc32(payload) & 0xFFFFFFFF:08X}"[-4:]


def get_device_type_by_code(type_code: str) -> dict[str, str] | None:
    for item in DEVICE_TYPES:
        if item["code"] == type_code:
            return item
    return None


def parse_device_no(value: str | None) -> dict[str, Any] | None:
    device_no = normalize_device_no(value)
    matched = DEVICE_NO_PATTERN.match(device_no)
    if not matched:
        return None
    type_code, serial, check_code = matched.groups()
    type_info = get_device_type_by_code(type_code)
    body = f"YT-{type_code}-{serial}"
    if not type_info or crc_check_code(body) != check_code:
        return None
    return {
        "deviceNo": device_no,
        "typeCode": type_code,
        "serial": serial,
        "serialNumber": int(serial, 16),
        "typeInfo": type_info,
    }


def create_device_no(type_code: str, serial: str) -> str:
    body = f"YT-{type_code}-{serial}"
    return f"{body}-{crc_check_code(body)}"


def get_seed_scenario(serial_number: int) -> str:
    if 0x00000 <= serial_number <= 0x00031:
        return "sale-unbound-online"
    if 0x00032 <= serial_number <= 0x0004A:
        return "sale-bound-online"
    if 0x0004B <= serial_number <= 0x00063:
        return "sale-bound-offline"
    return "not-produced"


def seed_owner_user_id_for_scenario(scenario: str) -> str | None:
    if scenario == "sale-bound-online":
        return SEED_BOUND_ONLINE_USER_ID
    if scenario == "sale-bound-offline":
        return SEED_BOUND_OFFLINE_USER_ID
    return None


def ensure_seed_users(connection, current_time: int) -> None:
    for user_id, phone in (
        (SEED_BOUND_ONLINE_USER_ID, SEED_BOUND_ONLINE_PHONE),
        (SEED_BOUND_OFFLINE_USER_ID, SEED_BOUND_OFFLINE_PHONE),
    ):
        row = connection.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if row:
            connection.execute(
                "UPDATE users SET phone = ?, phone_masked = ?, status = 'active', updated_at = ? WHERE id = ?",
                (phone, mask_phone(phone), current_time, user_id),
            )
            continue
        connection.execute(
            """
            INSERT INTO users(id, phone, phone_masked, status, created_at, updated_at, last_login_at)
            VALUES(?, ?, ?, 'active', ?, ?, ?)
            """,
            (user_id, phone, mask_phone(phone), current_time, current_time, current_time),
        )


def normalize_seed_device_ownership(connection, current_time: int) -> None:
    seed_user_marks = sql_marks(SEED_USER_IDS)
    connection.execute(
        f"""
        UPDATE device_registry
        SET bind_status = 'unbound', owner_user_id = NULL, online = 1,
            display_status = '在线', updated_at = ?
        WHERE mock_scenario = 'sale-unbound-online'
          AND owner_user_id IN ({seed_user_marks})
        """,
        (current_time, *SEED_USER_IDS),
    )
    connection.execute(
        f"""
        UPDATE device_registry
        SET bind_status = 'bound', owner_user_id = ?, online = 1,
            display_status = '在线', updated_at = ?
        WHERE mock_scenario = 'sale-bound-online'
          AND (owner_user_id IS NULL OR owner_user_id IN ({seed_user_marks}))
          AND (owner_user_id IS NULL OR owner_user_id <> ? OR bind_status <> 'bound' OR online <> 1 OR display_status <> '在线')
        """,
        (SEED_BOUND_ONLINE_USER_ID, current_time, *SEED_USER_IDS, SEED_BOUND_ONLINE_USER_ID),
    )
    connection.execute(
        f"""
        UPDATE device_registry
        SET bind_status = 'bound', owner_user_id = ?, online = 0,
            display_status = '离线', updated_at = ?
        WHERE mock_scenario = 'sale-bound-offline'
          AND (owner_user_id IS NULL OR owner_user_id IN ({seed_user_marks}))
          AND (owner_user_id IS NULL OR owner_user_id <> ? OR bind_status <> 'bound' OR online <> 0 OR display_status <> '离线')
        """,
        (SEED_BOUND_OFFLINE_USER_ID, current_time, *SEED_USER_IDS, SEED_BOUND_OFFLINE_USER_ID),
    )


def ensure_seed_data() -> None:
    current_time = now_ms()
    with db() as connection:
        ensure_seed_users(connection, current_time)
        row = connection.execute("SELECT COUNT(*) AS count FROM device_registry").fetchone()
        if row and row["count"]:
            normalize_seed_device_ownership(connection, current_time)
            return

        for type_info in DEVICE_TYPES:
            for serial_number in range(0x00064):
                serial = f"{serial_number:05X}"
                scenario = get_seed_scenario(serial_number)
                device_no = create_device_no(type_info["code"], serial)
                online = 0 if scenario == "sale-bound-offline" else 1
                bind_status = "unbound" if scenario == "sale-unbound-online" else "bound"
                owner_user_id = seed_owner_user_id_for_scenario(scenario)
                config = default_watering_config() if type_info["value"] == "watering" else {}
                connection.execute(
                    """
                    INSERT INTO device_registry(
                      device_no, type_code, serial, device_type, type_label, name, status,
                      bind_status, online, owner_user_id, mock_scenario, display_status,
                      config_json, last_watering_at, last_synced_at, created_at, updated_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        device_no,
                        type_info["code"],
                        serial,
                        type_info["value"],
                        type_info["label"],
                        type_info["label"],
                        "registered",
                        bind_status,
                        online,
                        owner_user_id,
                        scenario,
                        "在线" if online else "离线",
                        json_dumps(config),
                        "--",
                        None,
                        current_time,
                        current_time,
                    ),
                )


def public_user(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "phone": row["phone"],
        "phoneMasked": row["phone_masked"],
        "status": row["status"],
    }


def get_user_by_phone(connection, phone: str) -> dict[str, Any] | None:
    return row_to_dict(connection.execute("SELECT * FROM users WHERE phone = ?", (phone,)).fetchone())


def get_user_by_id(connection, user_id: str) -> dict[str, Any] | None:
    return row_to_dict(connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())


def openid_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "openid": row["openid"],
        "unionid": row["unionid"] or "",
        "appid": row["appid"] or "",
        "source": row["source"],
        "status": row["status"],
        "createdAt": row["created_at"],
        "createdAtText": format_time_ms(row["created_at"]),
        "updatedAt": row["updated_at"],
        "updatedAtText": format_time_ms(row["updated_at"]),
        "lastSeenAt": row["last_seen_at"],
        "lastSeenAtText": format_time_ms(row["last_seen_at"]),
    }


def get_openid_bindings(connection, user_id: str) -> list[dict[str, Any]]:
    rows = rows_to_dicts(
        connection.execute(
            "SELECT * FROM user_openids WHERE user_id = ? ORDER BY last_seen_at DESC",
            (user_id,),
        ).fetchall()
    )
    return [openid_payload(row) for row in rows]


def exchange_wechat_login_code(login_code: str | None) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    code = (login_code or "").strip()
    if not code:
        return None, fail("WECHAT_CODE_MISSING", "缺少微信登录凭证")
    settings = get_settings()
    if not settings.wechat_app_id or not settings.wechat_app_secret:
        return None, fail("WECHAT_NOT_CONFIGURED", "服务端未配置微信登录")

    query = urllib.parse.urlencode(
        {
            "appid": settings.wechat_app_id,
            "secret": settings.wechat_app_secret,
            "js_code": code,
            "grant_type": "authorization_code",
        }
    )
    url = f"https://api.weixin.qq.com/sns/jscode2session?{query}"
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None, fail("WECHAT_CODE_EXCHANGE_FAILED", "微信登录校验失败")

    openid = payload.get("openid")
    if not openid:
        return None, fail("WECHAT_CODE_INVALID", "微信登录凭证无效")
    return payload, None


def upsert_openid_binding(connection, user: dict[str, Any], wechat_payload: dict[str, Any], source: str = "wechat_code") -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    current_time = now_ms()
    openid = wechat_payload["openid"]
    unionid = wechat_payload.get("unionid") or ""
    appid = get_settings().wechat_app_id
    existing = row_to_dict(connection.execute("SELECT * FROM user_openids WHERE openid = ?", (openid,)).fetchone())
    if existing and existing["user_id"] != user["id"]:
        return None, fail("OPENID_BOUND_BY_OTHER", "该微信身份已绑定其他账号")
    if existing:
        connection.execute(
            """
            UPDATE user_openids
            SET unionid = ?, appid = ?, source = ?, status = 'active', updated_at = ?, last_seen_at = ?
            WHERE id = ?
            """,
            (unionid, appid, source, current_time, current_time, existing["id"]),
        )
        updated = row_to_dict(connection.execute("SELECT * FROM user_openids WHERE id = ?", (existing["id"],)).fetchone())
        return updated, None

    binding = {
        "id": make_id("openid"),
        "user_id": user["id"],
        "openid": openid,
        "unionid": unionid,
        "appid": appid,
        "source": source,
        "status": "active",
        "created_at": current_time,
        "updated_at": current_time,
        "last_seen_at": current_time,
    }
    connection.execute(
        """
        INSERT INTO user_openids(id, user_id, openid, unionid, appid, source, status, created_at, updated_at, last_seen_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            binding["id"],
            binding["user_id"],
            binding["openid"],
            binding["unionid"],
            binding["appid"],
            binding["source"],
            binding["status"],
            binding["created_at"],
            binding["updated_at"],
            binding["last_seen_at"],
        ),
    )
    return binding, None


def ensure_user(connection, phone: str) -> dict[str, Any]:
    user = get_user_by_phone(connection, phone)
    current_time = now_ms()
    if user:
        connection.execute(
            "UPDATE users SET updated_at = ?, last_login_at = ? WHERE id = ?",
            (current_time, current_time, user["id"]),
        )
        user["updated_at"] = current_time
        user["last_login_at"] = current_time
        return user

    user = {
        "id": make_id("user"),
        "phone": phone,
        "phone_masked": mask_phone(phone),
        "status": "active",
        "created_at": current_time,
        "updated_at": current_time,
        "last_login_at": current_time,
    }
    connection.execute(
        """
        INSERT INTO users(id, phone, phone_masked, status, created_at, updated_at, last_login_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        """,
        (
            user["id"],
            user["phone"],
            user["phone_masked"],
            user["status"],
            user["created_at"],
            user["updated_at"],
            user["last_login_at"],
        ),
    )
    return user


def create_auth_event(connection, user_id: str | None, phone_masked: str | None, event_type: str, result: str, reason: str = "") -> None:
    connection.execute(
        """
        INSERT INTO auth_events(id, user_id, phone_masked, event_type, result, reason, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        """,
        (make_id("event"), user_id, phone_masked, event_type, result, reason, now_ms()),
    )


def create_session(connection, user_id: str) -> dict[str, Any]:
    current_time = now_ms()
    session_token = secrets.token_urlsafe(32)
    expires_at = current_time + 30 * 24 * 60 * 60 * 1000
    max_expires_at = current_time + 90 * 24 * 60 * 60 * 1000
    session = {
        "id": make_id("session"),
        "user_id": user_id,
        "sessionToken": session_token,
        "token_hash": sha256_hex(session_token),
        "status": "active",
        "created_at": current_time,
        "expires_at": expires_at,
        "max_expires_at": max_expires_at,
        "last_seen_at": current_time,
    }
    connection.execute("UPDATE sessions SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'", (current_time, user_id))
    connection.execute(
        """
        INSERT INTO sessions(id, user_id, token_hash, status, created_at, expires_at, max_expires_at, last_seen_at, revoked_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (
            session["id"],
            session["user_id"],
            session["token_hash"],
            session["status"],
            session["created_at"],
            session["expires_at"],
            session["max_expires_at"],
            session["last_seen_at"],
        ),
    )
    return session


def validate_session(connection, session_token: str | None) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any]]:
    if not session_token:
        return None, None, fail("SESSION_MISSING", "请先登录")
    token_hash = sha256_hex(session_token)
    session = row_to_dict(connection.execute("SELECT * FROM sessions WHERE token_hash = ?", (token_hash,)).fetchone())
    if not session:
        return None, None, fail("SESSION_EXPIRED", "登录已过期，请重新登录")
    current_time = now_ms()
    if session["status"] == "revoked":
        return None, None, fail("SESSION_REVOKED", "登录已注销，请重新登录")
    if session["status"] != "active" or current_time >= session["expires_at"] or current_time >= session["max_expires_at"]:
        connection.execute("UPDATE sessions SET status = 'expired' WHERE id = ?", (session["id"],))
        return None, None, fail("SESSION_EXPIRED", "登录已过期，请重新登录")
    user = get_user_by_id(connection, session["user_id"])
    if not user or user["status"] != "active":
        return None, None, fail("USER_DISABLED", "账号不可用")
    next_expires_at = min(current_time + 30 * 24 * 60 * 60 * 1000, session["max_expires_at"])
    connection.execute("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", (current_time, next_expires_at, session["id"]))
    session["expires_at"] = next_expires_at
    session["last_seen_at"] = current_time
    return user, session, ok()


def resolve_user(connection, data: dict[str, Any], create_if_missing: bool = False) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    session_token = data.get("sessionToken")
    if session_token:
        user, _session, response = validate_session(connection, session_token)
        return user, response

    phone = (data.get("phone") or "").strip()
    if not PHONE_PATTERN.match(phone):
        return None, fail("SESSION_MISSING", "请先登录")
    user = ensure_user(connection, phone) if create_if_missing else get_user_by_phone(connection, phone)
    if not user:
        return None, fail("SESSION_MISSING", "请先登录")
    if user["status"] != "active":
        return None, fail("USER_DISABLED", "账号不可用")
    return user, ok()


def format_time_ms(value: int | None) -> str:
    if not value:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(value / 1000))


def request_meta(data: dict[str, Any]) -> dict[str, str]:
    return {
        "requestId": str(data.get("_requestId") or ""),
        "clientHost": str(data.get("_clientHost") or ""),
        "userAgent": str(data.get("_userAgent") or "")[:300],
    }


def limit_from_data(data: dict[str, Any], default: int = 20, maximum: int = 100) -> int:
    try:
        limit = int(data.get("limit") or default)
    except (TypeError, ValueError):
        return default
    return max(1, min(limit, maximum))


def audit_actor_from_data(connection, data: dict[str, Any], user: dict[str, Any] | None = None) -> dict[str, Any]:
    if user:
        return {"userId": user["id"], "phone": user["phone"], "phoneMasked": user["phone_masked"]}

    phone = (data.get("phone") or "").strip()
    if PHONE_PATTERN.match(phone):
        existing = get_user_by_phone(connection, phone)
        return {
            "userId": existing["id"] if existing else None,
            "phone": phone,
            "phoneMasked": existing["phone_masked"] if existing else mask_phone(phone),
        }

    session_token = data.get("sessionToken")
    if session_token:
        session = row_to_dict(
            connection.execute("SELECT * FROM sessions WHERE token_hash = ?", (sha256_hex(session_token),)).fetchone()
        )
        if session:
            existing = get_user_by_id(connection, session["user_id"])
            if existing:
                return {"userId": existing["id"], "phone": existing["phone"], "phoneMasked": existing["phone_masked"]}

    return {"userId": None, "phone": None, "phoneMasked": None}


def record_bind_attempt(
    connection,
    data: dict[str, Any],
    input_device_no: str,
    normalized_device_no: str,
    result: str,
    code: str,
    message: str,
    reason: str,
    user: dict[str, Any] | None = None,
) -> None:
    actor = audit_actor_from_data(connection, data, user)
    meta = request_meta(data)
    connection.execute(
        """
        INSERT INTO device_bind_attempts(
          id, request_id, phone, phone_masked, user_id, input_device_no, normalized_device_no,
          result, code, message, reason, client_host, user_agent, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            make_id("bind_attempt"),
            meta["requestId"],
            actor["phone"],
            actor["phoneMasked"],
            actor["userId"],
            input_device_no or "",
            normalized_device_no or "",
            result,
            code,
            message,
            reason,
            meta["clientHost"],
            meta["userAgent"],
            now_ms(),
        ),
    )


def bind_failure_window_ms() -> int:
    return max(1, get_settings().bind_failure_lock_hours) * 60 * 60 * 1000


def get_bind_failure_summary(connection, phone: str | None) -> dict[str, Any]:
    settings = get_settings()
    warning_threshold = max(1, settings.bind_failure_warning_threshold)
    lock_threshold = max(warning_threshold + 1, settings.bind_failure_lock_threshold)
    lock_hours = max(1, settings.bind_failure_lock_hours)
    current_time = now_ms()
    window_start = current_time - bind_failure_window_ms()
    rows = connection.execute(
        """
        SELECT created_at FROM device_bind_attempts
        WHERE phone = ? AND result = 'failed' AND created_at >= ?
        ORDER BY created_at DESC
        """,
        (phone or "", window_start),
    ).fetchall()
    timestamps = [row["created_at"] for row in rows]
    failed_count = len(timestamps)
    locked_until = None
    if failed_count >= lock_threshold:
        locked_until = min(timestamps[:lock_threshold]) + bind_failure_window_ms()
    return {
        "failedCount24h": failed_count,
        "warningThreshold": warning_threshold,
        "lockThreshold": lock_threshold,
        "remainingBeforeLock": max(0, lock_threshold - failed_count),
        "lockHours": lock_hours,
        "locked": bool(locked_until and current_time < locked_until),
        "lockedUntil": locked_until,
        "lockedUntilText": format_time_ms(locked_until),
    }


def bind_failure_data(summary: dict[str, Any]) -> dict[str, Any]:
    return {"bindRisk": summary}


def bind_failure_message(message: str, summary: dict[str, Any]) -> str:
    failed_count = summary["failedCount24h"]
    warning_threshold = summary["warningThreshold"]
    lock_threshold = summary["lockThreshold"]
    lock_hours = summary["lockHours"]
    if failed_count >= lock_threshold:
        return f"{message}。当前手机号24小时内绑定失败已达到{lock_threshold}次，{lock_hours}小时内将无法再次绑定。"
    if failed_count > warning_threshold:
        return f"{message}。当前手机号24小时内绑定失败已达到{failed_count}次，超过{lock_threshold}次将锁定{lock_hours}小时。"
    return message


def fail_with_bind_risk(connection, data: dict[str, Any], code: str, message: str, user: dict[str, Any] | None = None) -> dict[str, Any]:
    actor = audit_actor_from_data(connection, data, user)
    if not actor["phone"]:
        return fail(code, message)
    summary = get_bind_failure_summary(connection, actor["phone"])
    return fail(code, bind_failure_message(message, summary), bind_failure_data(summary))


def bind_locked_response(connection, data: dict[str, Any], input_device_no: str, normalized_device_no: str) -> dict[str, Any] | None:
    actor = audit_actor_from_data(connection, data)
    if not actor["phone"]:
        return None
    summary = get_bind_failure_summary(connection, actor["phone"])
    if not summary["locked"]:
        return None

    message = f"绑定失败次数过多，请在{summary['lockedUntilText']}后再试"
    record_bind_attempt(
        connection,
        data,
        input_device_no,
        normalized_device_no,
        "blocked",
        "DEVICE_BIND_LOCKED",
        message,
        "too_many_bind_failures",
    )
    return fail("DEVICE_BIND_LOCKED", message, bind_failure_data(summary))


def require_admin(data: dict[str, Any]) -> dict[str, Any] | None:
    admin_token = get_settings().admin_token
    if not admin_token:
        return fail("ADMIN_DISABLED", "管理员功能未启用")
    token = str(data.get("adminToken") or "")
    if not token or not hmac.compare_digest(token, admin_token):
        return fail("ADMIN_FORBIDDEN", "无管理员权限")
    return None


def record_admin_event(
    connection,
    data: dict[str, Any],
    action: str,
    target_type: str,
    target_id: str | None,
    result: str,
    reason: str = "",
    detail: dict[str, Any] | None = None,
) -> None:
    meta = request_meta(data)
    admin_id = str(data.get("adminId") or "admin_token")[:80]
    connection.execute(
        """
        INSERT INTO admin_audit_events(
          id, request_id, admin_id, action, target_type, target_id, result, reason,
          detail_json, client_host, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            make_id("admin_audit"),
            meta["requestId"],
            admin_id,
            action,
            target_type,
            target_id,
            result,
            reason,
            json_dumps(detail or {}),
            meta["clientHost"],
            now_ms(),
        ),
    )


def admin_user_payload(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "phoneMasked": user["phone_masked"],
        "status": user["status"],
        "createdAt": user["created_at"],
        "createdAtText": format_time_ms(user["created_at"]),
        "updatedAt": user["updated_at"],
        "updatedAtText": format_time_ms(user["updated_at"]),
        "lastLoginAt": user["last_login_at"],
        "lastLoginAtText": format_time_ms(user["last_login_at"]),
    }


def bind_attempt_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "requestId": row["request_id"],
        "phoneMasked": row["phone_masked"],
        "userId": row["user_id"],
        "inputDeviceNo": row["input_device_no"],
        "normalizedDeviceNo": row["normalized_device_no"],
        "result": row["result"],
        "code": row["code"],
        "message": row["message"],
        "reason": row["reason"],
        "clientHost": row["client_host"],
        "createdAt": row["created_at"],
        "createdAtText": format_time_ms(row["created_at"]),
    }


def bind_event_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "deviceNo": row["device_no"],
        "userId": row["user_id"],
        "eventType": row["event_type"],
        "result": row["result"],
        "reason": row["reason"],
        "createdAt": row["created_at"],
        "createdAtText": format_time_ms(row["created_at"]),
    }


def command_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "deviceNo": row["device_no"],
        "userId": row["user_id"],
        "userPhoneMasked": row.get("phone_masked"),
        "commandType": row["command_type"],
        "payload": json_loads(row["payload_json"], {}),
        "status": row["status"],
        "createdAt": row["created_at"],
        "createdAtText": format_time_ms(row["created_at"]),
        "sentAt": row["sent_at"],
        "sentAtText": format_time_ms(row["sent_at"]),
        "ackAt": row["ack_at"],
        "ackAtText": format_time_ms(row["ack_at"]),
        "failedReason": row["failed_reason"],
    }


def auth_event_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "phoneMasked": row["phone_masked"],
        "eventType": row["event_type"],
        "result": row["result"],
        "reason": row["reason"],
        "createdAt": row["created_at"],
        "createdAtText": format_time_ms(row["created_at"]),
    }


def device_bound_at(connection, device_no: str) -> int | None:
    row = connection.execute(
        """
        SELECT created_at FROM device_bind_events
        WHERE device_no = ? AND event_type = 'bind' AND result = 'success'
        ORDER BY created_at DESC LIMIT 1
        """,
        (device_no,),
    ).fetchone()
    return row["created_at"] if row else None


def admin_device_payload(connection, device: dict[str, Any]) -> dict[str, Any]:
    owner = get_user_by_id(connection, device["owner_user_id"]) if device["owner_user_id"] else None
    bound_at = device_bound_at(connection, device["device_no"])
    return {
        "deviceNo": device["device_no"],
        "typeCode": device["type_code"],
        "serial": device["serial"],
        "deviceType": device["device_type"],
        "typeLabel": device["type_label"],
        "name": device["name"],
        "status": device["status"],
        "bindStatus": device["bind_status"],
        "online": bool(device["online"]),
        "displayStatus": device["display_status"],
        "ownerUserId": device["owner_user_id"],
        "ownerPhoneMasked": owner["phone_masked"] if owner else "",
        "mockScenario": device["mock_scenario"],
        "config": json_loads(device["config_json"], {}),
        "lastWateringAt": device["last_watering_at"],
        "lastSyncedAt": device["last_synced_at"],
        "lastSyncedAtText": format_time_ms(device["last_synced_at"]),
        "boundAt": bound_at,
        "boundAtText": format_time_ms(bound_at),
        "createdAt": device["created_at"],
        "createdAtText": format_time_ms(device["created_at"]),
        "updatedAt": device["updated_at"],
        "updatedAtText": format_time_ms(device["updated_at"]),
    }


def auth_send_code(data: dict[str, Any]) -> dict[str, Any]:
    phone = (data.get("phone") or "").strip()
    if not PHONE_PATTERN.match(phone):
        return fail("INVALID_PHONE", "手机号格式错误")
    scene = data.get("scene") or "login"
    settings = get_settings()
    current_time = now_ms()
    with db() as connection:
        recent = connection.execute(
            "SELECT * FROM sms_codes WHERE phone = ? AND scene = ? ORDER BY created_at DESC LIMIT 1",
            (phone, scene),
        ).fetchone()
        if recent and current_time - recent["created_at"] < 60_000:
            cooldown = max(1, int((60_000 - (current_time - recent["created_at"])) / 1000))
            return fail("SMS_TOO_FREQUENT", "验证码发送太频繁", {"cooldownSeconds": cooldown})

        code = settings.dev_sms_code if settings.enable_dev_sms else f"{secrets.randbelow(1_000_000):06d}"
        expires_at = current_time + 5 * 60 * 1000
        if not settings.enable_dev_sms:
            try:
                send_sms_code(phone, code)
            except SmsError as error:
                create_auth_event(connection, None, mask_phone(phone), "send_code", "failed", error.code)
                return fail(error.code, error.message)
        connection.execute(
            """
            INSERT INTO sms_codes(id, phone, scene, code_hash, status, attempts, expires_at, created_at, used_at)
            VALUES(?, ?, ?, ?, 'pending', 0, ?, ?, NULL)
            """,
            (make_id("sms"), phone, scene, sha256_hex(f"{phone}:{code}"), expires_at, current_time),
        )
        create_auth_event(connection, None, mask_phone(phone), "send_code", "success")
        payload = {"cooldownSeconds": 60}
        if settings.enable_dev_sms:
            payload["devCode"] = code
        return ok(payload, "验证码已发送")


def auth_login_by_code(data: dict[str, Any]) -> dict[str, Any]:
    phone = (data.get("phone") or "").strip()
    code = (data.get("code") or "").strip()
    if not PHONE_PATTERN.match(phone):
        return fail("INVALID_PHONE", "手机号格式错误")
    if not re.fullmatch(r"\d{6}", code):
        return fail("CODE_INVALID", "验证码错误")
    current_time = now_ms()
    with db() as connection:
        sms = row_to_dict(
            connection.execute(
                "SELECT * FROM sms_codes WHERE phone = ? AND scene = 'login' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
                (phone,),
            ).fetchone()
        )
        if not sms:
            return fail("CODE_INVALID", "验证码错误")
        if current_time >= sms["expires_at"]:
            connection.execute("UPDATE sms_codes SET status = 'expired' WHERE id = ?", (sms["id"],))
            return fail("CODE_EXPIRED", "验证码过期")
        if sms["attempts"] >= 5:
            connection.execute("UPDATE sms_codes SET status = 'blocked' WHERE id = ?", (sms["id"],))
            return fail("CODE_INVALID", "验证码错误")
        if sha256_hex(f"{phone}:{code}") != sms["code_hash"]:
            connection.execute("UPDATE sms_codes SET attempts = attempts + 1 WHERE id = ?", (sms["id"],))
            return fail("CODE_INVALID", "验证码错误")

        connection.execute("UPDATE sms_codes SET status = 'used', used_at = ? WHERE id = ?", (current_time, sms["id"]))
        user = ensure_user(connection, phone)
        if user["status"] != "active":
            create_auth_event(connection, user["id"], user["phone_masked"], "login_failed", "failed", "user_disabled")
            return fail("USER_DISABLED", "账号不可用")
        session = create_session(connection, user["id"])
        create_auth_event(connection, user["id"], user["phone_masked"], "login_success", "success")
        return ok(
            {
                "authSession": {
                    "userId": user["id"],
                    "sessionToken": session["sessionToken"],
                    "phoneMasked": user["phone_masked"],
                    "expiresAt": session["expires_at"],
                    "maxExpiresAt": session["max_expires_at"],
                    "loginAt": session["created_at"],
                },
                "user": public_user(user),
            },
            "登录成功",
        )


def auth_check_session(data: dict[str, Any]) -> dict[str, Any]:
    with db() as connection:
        user, session, response = validate_session(connection, data.get("sessionToken"))
        if not response["success"] or not user or not session:
            return response
        return ok(
            {
                "authSession": {
                    "userId": user["id"],
                    "sessionToken": data.get("sessionToken"),
                    "phoneMasked": user["phone_masked"],
                    "expiresAt": session["expires_at"],
                    "maxExpiresAt": session["max_expires_at"],
                },
                "user": public_user(user),
            },
            "会话有效",
        )


def auth_logout(data: dict[str, Any]) -> dict[str, Any]:
    token = data.get("sessionToken")
    if not token:
        return ok({}, "已退出")
    with db() as connection:
        token_hash = sha256_hex(token)
        current_time = now_ms()
        session = row_to_dict(connection.execute("SELECT * FROM sessions WHERE token_hash = ?", (token_hash,)).fetchone())
        if session:
            connection.execute("UPDATE sessions SET status = 'revoked', revoked_at = ? WHERE id = ?", (current_time, session["id"]))
        return ok({}, "已退出")


def auth_bind_wechat(data: dict[str, Any]) -> dict[str, Any]:
    with db() as connection:
        user, response = resolve_user(connection, data, create_if_missing=True)
        if not response["success"] or not user:
            return response
        wechat_payload, wechat_error = exchange_wechat_login_code(data.get("loginCode"))
        if wechat_error or not wechat_payload:
            create_auth_event(connection, user["id"], user["phone_masked"], "bind_openid", "failed", wechat_error["code"] if wechat_error else "wechat_error")
            return wechat_error or fail("WECHAT_CODE_INVALID", "微信登录凭证无效")
        binding, bind_error = upsert_openid_binding(connection, user, wechat_payload)
        if bind_error or not binding:
            create_auth_event(connection, user["id"], user["phone_masked"], "bind_openid", "failed", bind_error["code"] if bind_error else "bind_failed")
            return bind_error or fail("OPENID_BIND_FAILED", "微信身份绑定失败")
        create_auth_event(connection, user["id"], user["phone_masked"], "bind_openid", "success")
        return ok({"user": public_user(user), "wechatBinding": openid_payload(binding)}, "微信身份已绑定")


def user_get_profile(data: dict[str, Any]) -> dict[str, Any]:
    with db() as connection:
        user, response = resolve_user(connection, data, create_if_missing=True)
        if not response["success"] or not user:
            return response
        return ok(
            {
                "user": {
                    "id": user["id"],
                    "phoneMasked": user["phone_masked"],
                    "status": user["status"],
                    "createdAt": user["created_at"],
                    "createdAtText": format_time_ms(user["created_at"]),
                    "lastLoginAt": user["last_login_at"],
                    "lastLoginAtText": format_time_ms(user["last_login_at"]),
                },
                "wechatBindings": get_openid_bindings(connection, user["id"]),
            }
        )


def get_display_status(device: dict[str, Any]) -> str:
    if device["display_status"] == "浇水中":
        return "浇水中"
    return "在线" if device["online"] else "离线"


def device_payload(device: dict[str, Any], owner_phone: str | None = None) -> dict[str, Any]:
    return {
        "id": device["device_no"].replace("-", "_"),
        "deviceNo": device["device_no"],
        "deviceSerial": device["serial"],
        "deviceTypeCode": device["type_code"],
        "name": device["name"],
        "type": device["device_type"],
        "typeLabel": device["type_label"],
        "status": get_display_status(device),
        "online": bool(device["online"]),
        "bindStatus": device["bind_status"],
        "ownerPhone": owner_phone or "",
        "mockScenario": device["mock_scenario"],
        "config": json_loads(device["config_json"], {}),
        "lastWateringAt": device["last_watering_at"],
        "lastSyncedAt": device["last_synced_at"],
        "syncState": "synced" if device["online"] else "offline",
        "createdAt": device["created_at"],
        "updatedAt": device["updated_at"],
    }


def get_device(connection, device_no: str) -> dict[str, Any] | None:
    return row_to_dict(connection.execute("SELECT * FROM device_registry WHERE device_no = ?", (device_no,)).fetchone())


def owner_phone(connection, owner_user_id: str | None) -> str | None:
    if not owner_user_id:
        return None
    user = get_user_by_id(connection, owner_user_id)
    return user["phone"] if user else None


def assert_owner(user: dict[str, Any], device: dict[str, Any]) -> dict[str, Any] | None:
    if device["owner_user_id"] != user["id"]:
        return fail("DEVICE_FORBIDDEN", "无权操作该设备")
    return None


def record_bind_event(connection, device_no: str, user_id: str | None, event_type: str, result: str, reason: str = "") -> None:
    connection.execute(
        """
        INSERT INTO device_bind_events(id, device_no, user_id, event_type, result, reason, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        """,
        (make_id("bind_event"), device_no, user_id, event_type, result, reason, now_ms()),
    )


def device_bind(data: dict[str, Any]) -> dict[str, Any]:
    input_device_no = data.get("deviceNo") or ""
    normalized_device_no = normalize_device_no(input_device_no)
    with db() as connection:
        locked = bind_locked_response(connection, data, input_device_no, normalized_device_no)
        if locked:
            return locked

        parsed = parse_device_no(input_device_no)
        if not parsed:
            record_bind_attempt(
                connection,
                data,
                input_device_no,
                normalized_device_no,
                "failed",
                "DEVICE_NOT_BINDABLE",
                "设备号不正确",
                "invalid_format_or_crc",
            )
            return fail_with_bind_risk(connection, data, "DEVICE_NOT_BINDABLE", "设备号不正确")

        if parsed["serialNumber"] > 0x00063:
            record_bind_attempt(
                connection,
                data,
                input_device_no,
                parsed["deviceNo"],
                "failed",
                "DEVICE_NOT_BINDABLE",
                "设备号不正确",
                "not_in_test_registry",
            )
            return fail_with_bind_risk(connection, data, "DEVICE_NOT_BINDABLE", "设备号不正确")

        user, response = resolve_user(connection, data, create_if_missing=True)
        if not response["success"] or not user:
            record_bind_attempt(
                connection,
                data,
                input_device_no,
                parsed["deviceNo"],
                "failed",
                response["code"],
                response["message"],
                response["code"].lower(),
            )
            return fail_with_bind_risk(connection, data, response["code"], response["message"])
        device = get_device(connection, parsed["deviceNo"])
        if not device or device["status"] != "registered":
            record_bind_event(connection, parsed["deviceNo"], user["id"], "bind", "failed", "not_registered")
            record_bind_attempt(
                connection,
                data,
                input_device_no,
                parsed["deviceNo"],
                "failed",
                "DEVICE_NOT_BINDABLE",
                "设备号不正确",
                "not_registered",
                user,
            )
            return fail_with_bind_risk(connection, data, "DEVICE_NOT_BINDABLE", "设备号不正确", user)
        if device["bind_status"] == "bound":
            if device["owner_user_id"] == user["id"]:
                record_bind_attempt(connection, data, input_device_no, device["device_no"], "success", "OK", "绑定成功", "already_owned", user)
                return ok({"user": public_user(user), "device": device_payload(device, user["phone"])}, "绑定成功")
            if device["owner_user_id"] or device["mock_scenario"] == "sale-bound-online":
                record_bind_event(connection, device["device_no"], user["id"], "bind", "failed", "bound_by_other")
                record_bind_attempt(
                    connection,
                    data,
                    input_device_no,
                    device["device_no"],
                    "failed",
                    "DEVICE_ALREADY_BOUND",
                    "设备已被绑定",
                    "bound_by_other",
                    user,
                )
                return fail_with_bind_risk(connection, data, "DEVICE_ALREADY_BOUND", "设备已被绑定", user)
        current_time = now_ms()
        name = (data.get("deviceName") or "").strip() or device["type_label"]
        config_json = device["config_json"] or json_dumps(default_watering_config() if device["device_type"] == "watering" else {})
        connection.execute(
            """
            UPDATE device_registry
            SET bind_status = 'bound', owner_user_id = ?, name = ?, config_json = ?, updated_at = ?
            WHERE device_no = ?
            """,
            (user["id"], name, config_json, current_time, device["device_no"]),
        )
        record_bind_event(connection, device["device_no"], user["id"], "bind", "success")
        record_bind_attempt(connection, data, input_device_no, device["device_no"], "success", "OK", "绑定成功", "bound", user)
        updated = get_device(connection, device["device_no"])
        return ok({"user": public_user(user), "device": device_payload(updated, user["phone"])}, "绑定成功")


def device_unbind(data: dict[str, Any]) -> dict[str, Any]:
    device_no = normalize_device_no(data.get("deviceNo"))
    with db() as connection:
        user, response = resolve_user(connection, data)
        if not response["success"] or not user:
            return response
        device = get_device(connection, device_no)
        if not device:
            return fail("DEVICE_NOT_FOUND", "设备不存在")
        forbidden = assert_owner(user, device)
        if forbidden:
            return forbidden
        current_time = now_ms()
        reset_config = default_watering_config() if device["device_type"] == "watering" else {}
        connection.execute(
            """
            UPDATE device_registry
            SET bind_status = 'unbound', owner_user_id = NULL, name = ?, config_json = ?,
                last_watering_at = '--', last_synced_at = NULL, display_status = ?, updated_at = ?
            WHERE device_no = ?
            """,
            (device["type_label"], json_dumps(reset_config), "在线" if device["online"] else "离线", current_time, device_no),
        )
        record_bind_event(connection, device_no, user["id"], "unbind", "success")
        return ok({"deviceNo": device_no, "unboundAt": current_time}, "已解绑")


def device_list(data: dict[str, Any]) -> dict[str, Any]:
    with db() as connection:
        user, response = resolve_user(connection, data)
        if not response["success"] or not user:
            return response
        rows = connection.execute("SELECT * FROM device_registry WHERE owner_user_id = ? ORDER BY updated_at DESC", (user["id"],)).fetchall()
        devices = [device_payload(dict(row), user["phone"]) for row in rows]
        return ok({"devices": devices})


def device_get_status(data: dict[str, Any]) -> dict[str, Any]:
    device_no = normalize_device_no(data.get("deviceNo"))
    with db() as connection:
        user, response = resolve_user(connection, data)
        if not response["success"] or not user:
            return response
        device = get_device(connection, device_no)
        if not device:
            return fail("DEVICE_NOT_FOUND", "设备不存在")
        forbidden = assert_owner(user, device)
        if forbidden:
            return forbidden
        return ok(
            {
                "deviceNo": device["device_no"],
                "status": get_display_status(device),
                "online": bool(device["online"]),
                "config": json_loads(device["config_json"], {}),
                "lastWateringAt": device["last_watering_at"],
                "lastSyncedAt": device["last_synced_at"],
                "updatedAt": device["updated_at"],
            }
        )


def validate_watering_config(config: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    try:
        next_config = {
            "mode": config.get("mode") or "demand",
            "demand": {
                "intervalHours": int(config.get("demand", {}).get("intervalHours")),
                "threshold": int(config.get("demand", {}).get("threshold")),
                "durationSeconds": int(config.get("demand", {}).get("durationSeconds")),
            },
            "schedule": {
                "intervalDays": int(config.get("schedule", {}).get("intervalDays")),
                "times": int(config.get("schedule", {}).get("times")),
                "durationSeconds": int(config.get("schedule", {}).get("durationSeconds")),
            },
            "manual": {"durationSeconds": int(config.get("manual", {}).get("durationSeconds"))},
        }
    except (TypeError, ValueError):
        return None, fail("INVALID_CONFIG", "请输入有效整数")
    if next_config["mode"] not in {"demand", "schedule", "manual"}:
        return None, fail("INVALID_CONFIG", "浇水模式不正确")
    if not 1 <= next_config["demand"]["intervalHours"] <= 72:
        return None, fail("INVALID_CONFIG", "检测周期不正确")
    if not 1 <= next_config["demand"]["threshold"] <= 100:
        return None, fail("INVALID_CONFIG", "湿度阈值不正确")
    if not 1 <= next_config["demand"]["durationSeconds"] <= 3600:
        return None, fail("INVALID_CONFIG", "浇水时长不正确")
    if not 1 <= next_config["schedule"]["intervalDays"] <= 365:
        return None, fail("INVALID_CONFIG", "天数须为整数")
    if not 1 <= next_config["schedule"]["times"] <= 24:
        return None, fail("INVALID_CONFIG", "次数须为整数")
    if not 1 <= next_config["schedule"]["durationSeconds"] <= 3600:
        return None, fail("INVALID_CONFIG", "浇水时长不正确")
    if not 1 <= next_config["manual"]["durationSeconds"] <= 3600:
        return None, fail("INVALID_CONFIG", "浇水秒数不正确")
    return next_config, None


def create_command(
    connection,
    user_id: str,
    device_no: str,
    command_type: str,
    payload: dict[str, Any],
    status: str = "ack",
    failed_reason: str = "",
) -> None:
    current_time = now_ms()
    connection.execute(
        """
        INSERT INTO device_commands(id, device_no, user_id, command_type, payload_json, status, created_at, sent_at, ack_at, failed_reason)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            make_id("cmd"),
            device_no,
            user_id,
            command_type,
            json_dumps(payload),
            status,
            current_time,
            current_time if status in {"sent", "ack", "failed"} else None,
            current_time if status == "ack" else None,
            failed_reason,
        ),
    )


def watering_save_config(data: dict[str, Any]) -> dict[str, Any]:
    device_no = normalize_device_no(data.get("deviceNo"))
    config, config_error = validate_watering_config(data.get("config") or {})
    if config_error:
        return config_error
    with db() as connection:
        user, response = resolve_user(connection, data)
        if not response["success"] or not user:
            return response
        device = get_device(connection, device_no)
        if not device or device["device_type"] != "watering":
            return fail("DEVICE_NOT_FOUND", "设备不存在")
        forbidden = assert_owner(user, device)
        if forbidden:
            return forbidden
        if device["status"] != "registered":
            create_command(connection, user["id"], device_no, "watering.saveConfig", {"config": config}, "failed", "device_disabled")
            return fail("DEVICE_DISABLED", "设备不可用")
        if not device["online"]:
            create_command(connection, user["id"], device_no, "watering.saveConfig", {"config": config}, "failed", "device_offline")
            return fail("DEVICE_OFFLINE", "设备离线，无法保存")
        current_time = now_ms()
        create_command(connection, user["id"], device_no, "watering.saveConfig", {"config": config})
        connection.execute(
            """
            UPDATE device_registry SET config_json = ?, last_synced_at = ?, updated_at = ? WHERE device_no = ?
            """,
            (json_dumps(config), current_time, current_time, device_no),
        )
        return ok({"config": config, "syncedAt": current_time, "status": "在线", "online": True}, "已同步")


def watering_start_manual(data: dict[str, Any]) -> dict[str, Any]:
    device_no = normalize_device_no(data.get("deviceNo"))
    try:
        duration_seconds = int(data.get("durationSeconds"))
    except (TypeError, ValueError):
        return fail("INVALID_CONFIG", "请输入浇水秒数")
    if not 1 <= duration_seconds <= 3600:
        return fail("INVALID_CONFIG", "请输入浇水秒数")
    with db() as connection:
        user, response = resolve_user(connection, data)
        if not response["success"] or not user:
            return response
        device = get_device(connection, device_no)
        if not device or device["device_type"] != "watering":
            return fail("DEVICE_NOT_FOUND", "设备不存在")
        forbidden = assert_owner(user, device)
        if forbidden:
            return forbidden
        if device["status"] != "registered":
            create_command(connection, user["id"], device_no, "watering.startManual", {"durationSeconds": duration_seconds}, "failed", "device_disabled")
            return fail("DEVICE_DISABLED", "设备不可用")
        if not device["online"]:
            create_command(connection, user["id"], device_no, "watering.startManual", {"durationSeconds": duration_seconds}, "failed", "device_offline")
            return fail("DEVICE_OFFLINE", "设备离线，无法下发")
        current_time = now_ms()
        last_watering_at = time.strftime("%Y-%m-%d %H:%M", time.localtime(current_time / 1000))
        create_command(connection, user["id"], device_no, "watering.startManual", {"durationSeconds": duration_seconds})
        connection.execute(
            """
            UPDATE device_registry SET display_status = '浇水中', last_watering_at = ?, last_synced_at = ?, updated_at = ? WHERE device_no = ?
            """,
            (last_watering_at, current_time, current_time, device_no),
        )
        return ok({"status": "浇水中", "online": True, "lastWateringAt": last_watering_at, "syncedAt": current_time, "durationSeconds": duration_seconds})


def watering_stop_manual(data: dict[str, Any]) -> dict[str, Any]:
    device_no = normalize_device_no(data.get("deviceNo"))
    with db() as connection:
        user, response = resolve_user(connection, data)
        if not response["success"] or not user:
            return response
        device = get_device(connection, device_no)
        if not device or device["device_type"] != "watering":
            return fail("DEVICE_NOT_FOUND", "设备不存在")
        forbidden = assert_owner(user, device)
        if forbidden:
            return forbidden
        if device["status"] != "registered":
            create_command(connection, user["id"], device_no, "watering.stopManual", {}, "failed", "device_disabled")
            return fail("DEVICE_DISABLED", "设备不可用")
        if not device["online"]:
            create_command(connection, user["id"], device_no, "watering.stopManual", {}, "failed", "device_offline")
            return fail("DEVICE_OFFLINE", "设备离线，无法下发")
        current_time = now_ms()
        create_command(connection, user["id"], device_no, "watering.stopManual", {})
        connection.execute(
            "UPDATE device_registry SET display_status = '在线', last_synced_at = ?, updated_at = ? WHERE device_no = ?",
            (current_time, current_time, device_no),
        )
        return ok({"status": "在线", "online": True, "syncedAt": current_time})


def admin_overview(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    last_24h = now_ms() - 24 * 60 * 60 * 1000
    with db() as connection:
        seed_user_marks = sql_marks(SEED_USER_IDS)
        seed_default_user_marks = sql_marks(SEED_DEFAULT_USER_IDS)
        real_owner_filter = f"owner_user_id IS NOT NULL AND owner_user_id NOT IN ({seed_user_marks})"
        type_rows = rows_to_dicts(
            connection.execute(
                f"""
                SELECT
                  type_code,
                  device_type,
                  type_label,
                  COUNT(*) AS total_count,
                  SUM(CASE WHEN bind_status = 'bound' THEN 1 ELSE 0 END) AS bound_count,
                  SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) AS online_count
                FROM device_registry
                                WHERE {real_owner_filter}
                GROUP BY type_code, device_type, type_label
                ORDER BY type_code
                """,
                                SEED_USER_IDS,
            ).fetchall()
        )
        type_stats = {row["type_code"]: row for row in type_rows}
        seed_scenario_params = (*SEED_SCENARIOS,)
        seed_scenario_marks = ",".join("?" for _ in SEED_SCENARIOS)
        seed_type_rows = rows_to_dicts(
            connection.execute(
                f"""
                SELECT
                  type_code,
                  device_type,
                  type_label,
                  COUNT(*) AS total_count,
                  SUM(CASE WHEN bind_status = 'bound' THEN 1 ELSE 0 END) AS bound_count,
                  SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) AS online_count
                FROM device_registry
                WHERE mock_scenario IN ({seed_scenario_marks})
                GROUP BY type_code, device_type, type_label
                ORDER BY type_code
                """,
                seed_scenario_params,
            ).fetchall()
        )
        seed_type_stats = {row["type_code"]: row for row in seed_type_rows}
        overview = {
            "metricScope": "real_user_bound_devices",
            "note": "默认统计排除了预置测试用户和测试台账；完整台账见 registrySummary，预置测试台账见 seedInventory。",
            "usersTotal": connection.execute(f"SELECT COUNT(*) AS count FROM users WHERE id NOT IN ({seed_user_marks})", SEED_USER_IDS).fetchone()["count"],
            "usersActive": connection.execute(
                f"SELECT COUNT(*) AS count FROM users WHERE status = 'active' AND id NOT IN ({seed_user_marks})",
                SEED_USER_IDS,
            ).fetchone()["count"],
            "devicesTotal": connection.execute(
                f"SELECT COUNT(*) AS count FROM device_registry WHERE {real_owner_filter}",
                SEED_USER_IDS,
            ).fetchone()["count"],
            "devicesBound": connection.execute(
                f"SELECT COUNT(*) AS count FROM device_registry WHERE bind_status = 'bound' AND {real_owner_filter}",
                SEED_USER_IDS,
            ).fetchone()["count"],
            "devicesOnline": connection.execute(
                f"SELECT COUNT(*) AS count FROM device_registry WHERE online = 1 AND {real_owner_filter}",
                SEED_USER_IDS,
            ).fetchone()["count"],
            "devicesByType": [
                {
                    "typeCode": type_info["code"],
                    "deviceType": type_info["value"],
                    "typeLabel": type_info["label"],
                    "totalCount": (type_stats.get(type_info["code"]) or {}).get("total_count", 0),
                    "boundCount": (type_stats.get(type_info["code"]) or {}).get("bound_count", 0) or 0,
                    "onlineCount": (type_stats.get(type_info["code"]) or {}).get("online_count", 0) or 0,
                }
                for type_info in DEVICE_TYPES
            ],
            "registrySummary": {
                "devicesTotal": connection.execute("SELECT COUNT(*) AS count FROM device_registry").fetchone()["count"],
                "devicesBound": connection.execute("SELECT COUNT(*) AS count FROM device_registry WHERE bind_status = 'bound'").fetchone()["count"],
                "devicesOnline": connection.execute("SELECT COUNT(*) AS count FROM device_registry WHERE online = 1").fetchone()["count"],
            },
            "seedInventory": {
                "usersTotal": connection.execute(
                    f"SELECT COUNT(*) AS count FROM users WHERE id IN ({seed_default_user_marks})",
                    SEED_DEFAULT_USER_IDS,
                ).fetchone()["count"],
                "boundOnlineOwnerPhone": SEED_BOUND_ONLINE_PHONE,
                "boundOfflineOwnerPhone": SEED_BOUND_OFFLINE_PHONE,
                "devicesTotal": connection.execute(
                    f"SELECT COUNT(*) AS count FROM device_registry WHERE mock_scenario IN ({seed_scenario_marks})",
                    seed_scenario_params,
                ).fetchone()["count"],
                "devicesBound": connection.execute(
                    f"SELECT COUNT(*) AS count FROM device_registry WHERE bind_status = 'bound' AND mock_scenario IN ({seed_scenario_marks})",
                    seed_scenario_params,
                ).fetchone()["count"],
                "devicesOnline": connection.execute(
                    f"SELECT COUNT(*) AS count FROM device_registry WHERE online = 1 AND mock_scenario IN ({seed_scenario_marks})",
                    seed_scenario_params,
                ).fetchone()["count"],
                "devicesByType": [
                    {
                        "typeCode": type_info["code"],
                        "deviceType": type_info["value"],
                        "typeLabel": type_info["label"],
                        "totalCount": (seed_type_stats.get(type_info["code"]) or {}).get("total_count", 0),
                        "boundCount": (seed_type_stats.get(type_info["code"]) or {}).get("bound_count", 0) or 0,
                        "onlineCount": (seed_type_stats.get(type_info["code"]) or {}).get("online_count", 0) or 0,
                    }
                    for type_info in DEVICE_TYPES
                ],
            },
            "bindAttempts24h": connection.execute("SELECT COUNT(*) AS count FROM device_bind_attempts WHERE created_at >= ?", (last_24h,)).fetchone()["count"],
            "bindFailures24h": connection.execute(
                "SELECT COUNT(*) AS count FROM device_bind_attempts WHERE result = 'failed' AND created_at >= ?",
                (last_24h,),
            ).fetchone()["count"],
            "bindBlocked24h": connection.execute(
                "SELECT COUNT(*) AS count FROM device_bind_attempts WHERE result = 'blocked' AND created_at >= ?",
                (last_24h,),
            ).fetchone()["count"],
            "commands24h": connection.execute("SELECT COUNT(*) AS count FROM device_commands WHERE created_at >= ?", (last_24h,)).fetchone()["count"],
            "commandFailures24h": connection.execute(
                "SELECT COUNT(*) AS count FROM device_commands WHERE status = 'failed' AND created_at >= ?",
                (last_24h,),
            ).fetchone()["count"],
        }
        record_admin_event(connection, data, "admin.overview", "system", None, "success")
        return ok(overview)


def admin_user_find_by_phone(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    phone = (data.get("phone") or "").strip()
    if not is_admin_query_phone(phone):
        return fail("INVALID_PHONE", "手机号格式错误")
    limit = read_limit(data)
    with db() as connection:
        user = get_user_by_phone(connection, phone)
        attempts = rows_to_dicts(
            connection.execute(
                "SELECT * FROM device_bind_attempts WHERE phone = ? ORDER BY created_at DESC LIMIT ?",
                (phone, limit),
            ).fetchall()
        )
        if not user:
            record_admin_event(connection, data, "admin.user.findByPhone", "phone", mask_phone(phone), "success", "not_registered")
            return ok(
                {
                    "exists": False,
                    "phoneMasked": mask_phone(phone),
                    "recentBindAttempts": [bind_attempt_payload(row) for row in attempts],
                }
            )

        session_row = connection.execute(
            """
            SELECT COUNT(*) AS active_count, MAX(last_seen_at) AS last_seen_at
            FROM sessions WHERE user_id = ? AND status = 'active'
            """,
            (user["id"],),
        ).fetchone()
        device_rows = rows_to_dicts(
            connection.execute(
                "SELECT * FROM device_registry WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT ?",
                (user["id"], limit),
            ).fetchall()
        )
        auth_rows = rows_to_dicts(
            connection.execute(
                "SELECT * FROM auth_events WHERE user_id = ? OR phone_masked = ? ORDER BY created_at DESC LIMIT ?",
                (user["id"], user["phone_masked"], limit),
            ).fetchall()
        )
        command_rows = rows_to_dicts(
            connection.execute(
                """
                SELECT c.*, u.phone_masked FROM device_commands c
                LEFT JOIN users u ON u.id = c.user_id
                WHERE c.user_id = ?
                ORDER BY c.created_at DESC LIMIT ?
                """,
                (user["id"], limit),
            ).fetchall()
        )
        record_admin_event(connection, data, "admin.user.findByPhone", "user", user["id"], "success", detail={"phoneMasked": user["phone_masked"]})
        return ok(
            {
                "exists": True,
                "user": admin_user_payload(user),
                "sessionSummary": {
                    "activeCount": session_row["active_count"],
                    "lastSeenAt": session_row["last_seen_at"],
                    "lastSeenAtText": format_time_ms(session_row["last_seen_at"]),
                },
                "devices": [admin_device_payload(connection, row) for row in device_rows],
                "wechatBindings": get_openid_bindings(connection, user["id"]),
                "recentAuthEvents": [auth_event_payload(row) for row in auth_rows],
                "recentBindAttempts": [bind_attempt_payload(row) for row in attempts],
                "recentCommands": [command_payload(row) for row in command_rows],
            }
        )


def admin_user_find_by_openid(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    openid = (data.get("openid") or "").strip()
    if not openid:
        return fail("OPENID_REQUIRED", "OpenID不能为空")
    with db() as connection:
        row = row_to_dict(
            connection.execute(
                """
                SELECT o.*, u.id AS user_id, u.phone_masked, u.status AS user_status,
                       u.created_at AS user_created_at, u.updated_at AS user_updated_at,
                       u.last_login_at AS user_last_login_at
                FROM user_openids o
                JOIN users u ON u.id = o.user_id
                WHERE o.openid = ?
                """,
                (openid,),
            ).fetchone()
        )
        if not row:
            record_admin_event(connection, data, "admin.user.findByOpenid", "openid", openid, "success", "not_found")
            return ok({"exists": False, "openid": openid})
        user = {
            "id": row["user_id"],
            "phone_masked": row["phone_masked"],
            "status": row["user_status"],
            "created_at": row["user_created_at"],
            "updated_at": row["user_updated_at"],
            "last_login_at": row["user_last_login_at"],
        }
        binding = {
            "id": row["id"],
            "openid": row["openid"],
            "unionid": row["unionid"],
            "appid": row["appid"],
            "source": row["source"],
            "status": row["status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "last_seen_at": row["last_seen_at"],
        }
        record_admin_event(connection, data, "admin.user.findByOpenid", "user", user["id"], "success", detail={"phoneMasked": user["phone_masked"]})
        return ok({"exists": True, "user": admin_user_payload(user), "wechatBinding": openid_payload(binding)})


def admin_device_find_by_no(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    device_no = normalize_device_no(data.get("deviceNo"))
    if not device_no:
        return fail("INVALID_DEVICE_NO", "设备号不能为空")
    limit = read_limit(data)
    with db() as connection:
        device = get_device(connection, device_no)
        attempts = rows_to_dicts(
            connection.execute(
                "SELECT * FROM device_bind_attempts WHERE normalized_device_no = ? ORDER BY created_at DESC LIMIT ?",
                (device_no, limit),
            ).fetchall()
        )
        if not device:
            record_admin_event(connection, data, "admin.device.findByNo", "device", device_no, "success", "not_found")
            return ok({"exists": False, "deviceNo": device_no, "recentBindAttempts": [bind_attempt_payload(row) for row in attempts]})

        bind_events = rows_to_dicts(
            connection.execute(
                "SELECT * FROM device_bind_events WHERE device_no = ? ORDER BY created_at DESC LIMIT ?",
                (device_no, limit),
            ).fetchall()
        )
        command_rows = rows_to_dicts(
            connection.execute(
                """
                SELECT c.*, u.phone_masked FROM device_commands c
                LEFT JOIN users u ON u.id = c.user_id
                WHERE c.device_no = ?
                ORDER BY c.created_at DESC LIMIT ?
                """,
                (device_no, limit),
            ).fetchall()
        )
        commands = [command_payload(row) for row in command_rows]
        work_commands = [item for item in commands if item["commandType"] == "watering.startManual"]
        total_duration = sum(int(item["payload"].get("durationSeconds") or 0) for item in work_commands)
        record_admin_event(connection, data, "admin.device.findByNo", "device", device_no, "success")
        return ok(
            {
                "exists": True,
                "device": admin_device_payload(connection, device),
                "recentBindEvents": [bind_event_payload(row) for row in bind_events],
                "recentBindAttempts": [bind_attempt_payload(row) for row in attempts],
                "recentCommands": commands,
                "workSummaryInReturnedRows": {
                    "manualWateringCount": len(work_commands),
                    "manualWateringTotalSeconds": total_duration,
                },
            }
        )


def admin_bind_attempts_search(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    limit = read_limit(data, default=50, maximum=200)
    clauses = []
    params: list[Any] = []
    phone = (data.get("phone") or "").strip()
    if phone:
        if not is_admin_query_phone(phone):
            return fail("INVALID_PHONE", "手机号格式错误")
        clauses.append("phone = ?")
        params.append(phone)
    device_no = normalize_device_no(data.get("deviceNo"))
    if device_no:
        clauses.append("normalized_device_no = ?")
        params.append(device_no)
    for field, column in (("result", "result"), ("code", "code"), ("reason", "reason")):
        value = (data.get(field) or "").strip()
        if value:
            clauses.append(f"{column} = ?")
            params.append(value)
    since_ms = read_since_ms(data)
    if since_ms:
        clauses.append("created_at >= ?")
        params.append(since_ms)
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db() as connection:
        rows = rows_to_dicts(
            connection.execute(
                f"SELECT * FROM device_bind_attempts {where_sql} ORDER BY created_at DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
        )
        record_admin_event(connection, data, "admin.bindAttempts.search", "bind_attempt", None, "success", detail={"count": len(rows)})
        return ok({"attempts": [bind_attempt_payload(row) for row in rows], "count": len(rows)})


def admin_device_commands(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    limit = read_limit(data, default=50, maximum=200)
    clauses = []
    params: list[Any] = []
    device_no = normalize_device_no(data.get("deviceNo"))
    if device_no:
        clauses.append("c.device_no = ?")
        params.append(device_no)
    phone = (data.get("phone") or "").strip()
    with db() as connection:
        if phone:
            if not is_admin_query_phone(phone):
                return fail("INVALID_PHONE", "手机号格式错误")
            user = get_user_by_phone(connection, phone)
            if not user:
                record_admin_event(connection, data, "admin.device.commands", "phone", mask_phone(phone), "success", "user_not_found")
                return ok({"commands": [], "count": 0, "workSummaryInReturnedRows": {"manualWateringCount": 0, "manualWateringTotalSeconds": 0}})
            clauses.append("c.user_id = ?")
            params.append(user["id"])
        for field, column in (("commandType", "c.command_type"), ("status", "c.status")):
            value = (data.get(field) or "").strip()
            if value:
                clauses.append(f"{column} = ?")
                params.append(value)
        since_ms = read_since_ms(data)
        if since_ms:
            clauses.append("c.created_at >= ?")
            params.append(since_ms)
        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = rows_to_dicts(
            connection.execute(
                f"""
                SELECT c.*, u.phone_masked FROM device_commands c
                LEFT JOIN users u ON u.id = c.user_id
                {where_sql}
                ORDER BY c.created_at DESC LIMIT ?
                """,
                (*params, limit),
            ).fetchall()
        )
        commands = [command_payload(row) for row in rows]
        work_commands = [item for item in commands if item["commandType"] == "watering.startManual"]
        total_duration = sum(int(item["payload"].get("durationSeconds") or 0) for item in work_commands)
        record_admin_event(connection, data, "admin.device.commands", "device_command", device_no or None, "success", detail={"count": len(commands)})
        return ok(
            {
                "commands": commands,
                "count": len(commands),
                "workSummaryInReturnedRows": {
                    "manualWateringCount": len(work_commands),
                    "manualWateringTotalSeconds": total_duration,
                },
            }
        )


def admin_user_disable(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    phone = (data.get("phone") or "").strip()
    user_id = (data.get("userId") or "").strip()
    reason = (data.get("reason") or "admin_disabled").strip()
    with db() as connection:
        user = get_user_by_phone(connection, phone) if phone else get_user_by_id(connection, user_id)
        if not user:
            return fail("USER_NOT_FOUND", "用户不存在")
        current_time = now_ms()
        connection.execute("UPDATE users SET status = 'disabled', updated_at = ? WHERE id = ?", (current_time, user["id"]))
        connection.execute("UPDATE sessions SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status = 'active'", (current_time, user["id"]))
        record_admin_event(connection, data, "admin.user.disable", "user", user["id"], "success", reason, {"phoneMasked": user["phone_masked"]})
        return ok({"userId": user["id"], "phoneMasked": user["phone_masked"], "status": "disabled", "updatedAt": current_time})


def admin_user_restore(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    phone = (data.get("phone") or "").strip()
    user_id = (data.get("userId") or "").strip()
    with db() as connection:
        user = get_user_by_phone(connection, phone) if phone else get_user_by_id(connection, user_id)
        if not user:
            return fail("USER_NOT_FOUND", "用户不存在")
        current_time = now_ms()
        connection.execute("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?", (current_time, user["id"]))
        record_admin_event(connection, data, "admin.user.restore", "user", user["id"], "success", detail={"phoneMasked": user["phone_masked"]})
        return ok({"userId": user["id"], "phoneMasked": user["phone_masked"], "status": "active", "updatedAt": current_time})


def admin_device_disable(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    device_no = normalize_device_no(data.get("deviceNo"))
    reason = (data.get("reason") or "admin_disabled").strip()
    with db() as connection:
        device = get_device(connection, device_no)
        if not device:
            return fail("DEVICE_NOT_FOUND", "设备不存在")
        current_time = now_ms()
        connection.execute(
            "UPDATE device_registry SET status = 'disabled', online = 0, display_status = '离线', updated_at = ? WHERE device_no = ?",
            (current_time, device_no),
        )
        record_admin_event(connection, data, "admin.device.disable", "device", device_no, "success", reason)
        return ok({"deviceNo": device_no, "status": "disabled", "updatedAt": current_time})


def admin_device_restore(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    device_no = normalize_device_no(data.get("deviceNo"))
    with db() as connection:
        device = get_device(connection, device_no)
        if not device:
            return fail("DEVICE_NOT_FOUND", "设备不存在")
        current_time = now_ms()
        connection.execute("UPDATE device_registry SET status = 'registered', updated_at = ? WHERE device_no = ?", (current_time, device_no))
        record_admin_event(connection, data, "admin.device.restore", "device", device_no, "success")
        return ok({"deviceNo": device_no, "status": "registered", "updatedAt": current_time})


def admin_device_force_unbind(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    device_no = normalize_device_no(data.get("deviceNo"))
    reason = (data.get("reason") or "admin_force_unbind").strip()
    with db() as connection:
        device = get_device(connection, device_no)
        if not device:
            return fail("DEVICE_NOT_FOUND", "设备不存在")
        old_owner_user_id = device["owner_user_id"]
        current_time = now_ms()
        reset_config = default_watering_config() if device["device_type"] == "watering" else {}
        connection.execute(
            """
            UPDATE device_registry
            SET bind_status = 'unbound', owner_user_id = NULL, name = ?, config_json = ?,
                last_watering_at = '--', last_synced_at = NULL, display_status = ?, updated_at = ?
            WHERE device_no = ?
            """,
            (device["type_label"], json_dumps(reset_config), "在线" if device["online"] else "离线", current_time, device_no),
        )
        record_bind_event(connection, device_no, old_owner_user_id, "admin_unbind", "success", reason)
        record_admin_event(connection, data, "admin.device.forceUnbind", "device", device_no, "success", reason, {"oldOwnerUserId": old_owner_user_id})
        return ok({"deviceNo": device_no, "oldOwnerUserId": old_owner_user_id, "unboundAt": current_time})


def admin_audit_search(data: dict[str, Any]) -> dict[str, Any]:
    forbidden = require_admin(data)
    if forbidden:
        return forbidden
    limit = read_limit(data, default=50, maximum=200)
    clauses = []
    params: list[Any] = []
    for field, column in (("action", "action"), ("targetType", "target_type"), ("targetId", "target_id")):
        value = (data.get(field) or "").strip()
        if value:
            clauses.append(f"{column} = ?")
            params.append(value)
    since_ms = read_since_ms(data)
    if since_ms:
        clauses.append("created_at >= ?")
        params.append(since_ms)
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with db() as connection:
        rows = rows_to_dicts(
            connection.execute(
                f"SELECT * FROM admin_audit_events {where_sql} ORDER BY created_at DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
        )
        events = [
            {
                "id": row["id"],
                "requestId": row["request_id"],
                "adminId": row["admin_id"],
                "action": row["action"],
                "targetType": row["target_type"],
                "targetId": row["target_id"],
                "result": row["result"],
                "reason": row["reason"],
                "detail": json_loads(row["detail_json"], {}),
                "clientHost": row["client_host"],
                "createdAt": row["created_at"],
                "createdAtText": format_time_ms(row["created_at"]),
            }
            for row in rows
        ]
        record_admin_event(connection, data, "admin.audit.search", "admin_audit", None, "success", detail={"count": len(events)})
        return ok({"events": events, "count": len(events)})


HANDLERS = {
    "auth.sendCode": auth_send_code,
    "auth.loginByCode": auth_login_by_code,
    "auth.checkSession": auth_check_session,
    "auth.logout": auth_logout,
    "auth.bindWechat": auth_bind_wechat,
    "user.getProfile": user_get_profile,
    "device.bind": device_bind,
    "device.unbind": device_unbind,
    "device.list": device_list,
    "device.getStatus": device_get_status,
    "watering.saveConfig": watering_save_config,
    "watering.startManual": watering_start_manual,
    "watering.stopManual": watering_stop_manual,
    "admin.overview": admin_overview,
    "admin.user.findByPhone": admin_user_find_by_phone,
    "admin.user.findByOpenid": admin_user_find_by_openid,
    "admin.device.findByNo": admin_device_find_by_no,
    "admin.bindAttempts.search": admin_bind_attempts_search,
    "admin.device.commands": admin_device_commands,
    "admin.user.disable": admin_user_disable,
    "admin.user.restore": admin_user_restore,
    "admin.device.disable": admin_device_disable,
    "admin.device.restore": admin_device_restore,
    "admin.device.forceUnbind": admin_device_force_unbind,
    "admin.audit.search": admin_audit_search,
}


def handle_api(api_type: str, data: dict[str, Any]) -> dict[str, Any]:
    handler = HANDLERS.get(api_type)
    if not handler:
        return fail("API_NOT_FOUND", "接口不存在")
    return handler(data)