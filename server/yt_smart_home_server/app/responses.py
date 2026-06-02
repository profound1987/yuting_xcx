from typing import Any


def ok(data: Any = None, message: str = "") -> dict[str, Any]:
    return {
        "success": True,
        "code": "OK",
        "message": message,
        "data": {} if data is None else data,
    }


def fail(code: str, message: str, data: Any = None) -> dict[str, Any]:
    return {
        "success": False,
        "code": code,
        "message": message,
        "data": data,
    }