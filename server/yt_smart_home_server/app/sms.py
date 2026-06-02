from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import json
import secrets
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .settings import get_settings


class SmsError(Exception):
    code = "SMS_SEND_FAILED"
    message = "验证码发送失败，请稍后再试"


class SmsNotConfiguredError(SmsError):
    code = "SMS_NOT_CONFIGURED"
    message = "短信服务未配置"


def percent_encode(value: Any) -> str:
    return urllib.parse.quote(str(value), safe="~")


def sign_aliyun_rpc(params: dict[str, str], access_key_secret: str, method: str = "GET") -> str:
    canonical_query = "&".join(
        f"{percent_encode(key)}={percent_encode(params[key])}"
        for key in sorted(params)
    )
    string_to_sign = f"{method}&{percent_encode('/')}&{percent_encode(canonical_query)}"
    digest = hmac.new(
        f"{access_key_secret}&".encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha1,
    ).digest()
    return base64.b64encode(digest).decode("ascii")


def ensure_aliyun_config() -> None:
    settings = get_settings()
    required = (
        settings.aliyun_sms_access_key_id,
        settings.aliyun_sms_access_key_secret,
        settings.aliyun_sms_sign_name,
        settings.aliyun_sms_template_code,
    )
    if not all(required):
        raise SmsNotConfiguredError()


def build_template_param(code: str) -> str:
    settings = get_settings()
    try:
        extra_params = json.loads(settings.aliyun_sms_template_extra_params or "{}")
    except json.JSONDecodeError as error:
        raise SmsNotConfiguredError() from error
    if not isinstance(extra_params, dict):
        raise SmsNotConfiguredError()
    template_params = {str(key): str(value) for key, value in extra_params.items()}
    template_params[settings.aliyun_sms_template_code_key] = code
    template_param = json.dumps(
        template_params,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return template_param


def aliyun_endpoint_url(endpoint: str, fallback: str) -> str:
    value = (endpoint or fallback).strip() or fallback
    if not value.startswith(("http://", "https://")):
        value = f"https://{value}"
    return value.rstrip("/")


def read_aliyun_response(url: str, timeout: int) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return json.loads(error.read().decode("utf-8"))
        except json.JSONDecodeError:
            raise SmsError() from error
    except (TimeoutError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise SmsError() from error


def raise_for_aliyun_body(body: dict[str, Any]) -> None:
    if body.get("Code") == "OK" or body.get("Success") is True:
        return
    error = SmsError()
    error.code = str(body.get("Code") or "SMS_SEND_FAILED")
    error.message = str(body.get("Message") or SmsError.message)
    raise error


def send_aliyun_sms_code(phone: str, code: str) -> dict[str, Any]:
    settings = get_settings()
    ensure_aliyun_config()

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    template_param = build_template_param(code)
    params = {
        "AccessKeyId": settings.aliyun_sms_access_key_id,
        "Action": "SendSms",
        "Format": "JSON",
        "PhoneNumbers": phone,
        "RegionId": settings.aliyun_sms_region_id,
        "SignName": settings.aliyun_sms_sign_name,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": secrets.token_hex(16),
        "SignatureVersion": "1.0",
        "TemplateCode": settings.aliyun_sms_template_code,
        "TemplateParam": template_param,
        "Timestamp": timestamp,
        "Version": "2017-05-25",
    }
    params["Signature"] = sign_aliyun_rpc(params, settings.aliyun_sms_access_key_secret)
    query = urllib.parse.urlencode(params)
    url = f"{aliyun_endpoint_url(settings.aliyun_sms_endpoint, 'dysmsapi.aliyuncs.com')}/?{query}"
    body = read_aliyun_response(url, settings.sms_timeout_seconds)
    raise_for_aliyun_body(body)
    return body


def send_aliyun_dypns_sms_code(phone: str, code: str) -> dict[str, Any]:
    settings = get_settings()
    ensure_aliyun_config()

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    endpoint = settings.aliyun_sms_endpoint
    if endpoint == "dysmsapi.aliyuncs.com":
        endpoint = "dypnsapi.aliyuncs.com"
    params = {
        "AccessKeyId": settings.aliyun_sms_access_key_id,
        "Action": "SendSmsVerifyCode",
        "Format": "JSON",
        "PhoneNumber": phone,
        "RegionId": settings.aliyun_sms_region_id,
        "SignName": settings.aliyun_sms_sign_name,
        "SignatureMethod": "HMAC-SHA1",
        "SignatureNonce": secrets.token_hex(16),
        "SignatureVersion": "1.0",
        "TemplateCode": settings.aliyun_sms_template_code,
        "TemplateParam": build_template_param(code),
        "Timestamp": timestamp,
        "Version": "2017-05-25",
    }
    params["Signature"] = sign_aliyun_rpc(params, settings.aliyun_sms_access_key_secret)
    query = urllib.parse.urlencode(params)
    url = f"{aliyun_endpoint_url(endpoint, 'dypnsapi.aliyuncs.com')}/?{query}"
    body = read_aliyun_response(url, settings.sms_timeout_seconds)
    raise_for_aliyun_body(body)
    return body


def send_sms_code(phone: str, code: str) -> dict[str, Any]:
    settings = get_settings()
    if settings.sms_provider == "aliyun":
        return send_aliyun_sms_code(phone, code)
    if settings.sms_provider in ("aliyun_dypns", "dypns"):
        return send_aliyun_dypns_sms_code(phone, code)
    raise SmsNotConfiguredError()