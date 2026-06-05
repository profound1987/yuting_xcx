from typing import Any
import time
import uuid

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi import Request
from pydantic import BaseModel, Field

from .database import init_db
from .logging_config import get_logger, setup_logging
from .responses import fail, ok
from .services import ensure_seed_data, handle_api
from .settings import get_settings


class ApiRequest(BaseModel):
    type: str = Field(..., min_length=1)
    data: dict[str, Any] = Field(default_factory=dict)
    sessionToken: str | None = None


settings = get_settings()
setup_logging()
logger = get_logger("yt_smart_home")
app = FastAPI(title="Yunting Smart Home Server", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def access_log_middleware(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    started_at = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        logger.exception(
            "request_failed request_id=%s method=%s path=%s client=%s duration_ms=%s",
            request_id,
            request.method,
            request.url.path,
            request.client.host if request.client else "unknown",
            duration_ms,
        )
        raise

    duration_ms = int((time.perf_counter() - started_at) * 1000)
    logger.info(
        "request request_id=%s method=%s path=%s status=%s client=%s duration_ms=%s",
        request_id,
        request.method,
        request.url.path,
        response.status_code,
        request.client.host if request.client else "unknown",
        duration_ms,
    )
    response.headers["X-Request-Id"] = request_id
    return response


@app.on_event("startup")
def startup() -> None:
    init_db()
    ensure_seed_data()
    logger.info("server_started service=yt_smart_home_server")


@app.get("/health")
def health() -> dict[str, Any]:
    return ok({"service": "yt_smart_home_server", "status": "healthy"})


@app.get("/api")
def api_info() -> dict[str, Any]:
    return ok({
        "service": "yt_smart_home_server",
        "message": "Yunting Smart Home API endpoint. Use POST /api with JSON body.",
        "method": "POST",
        "requestShape": {"type": "api.type", "data": {}},
    })


@app.post("/api")
def api(api_request: ApiRequest, request: Request) -> dict[str, Any]:
    started_at = time.perf_counter()
    request_id = getattr(request.state, "request_id", "unknown")
    data = dict(api_request.data or {})
    if api_request.sessionToken and "sessionToken" not in data:
        data["sessionToken"] = api_request.sessionToken
    data["_requestId"] = request_id
    data["_clientHost"] = request.client.host if request.client else "unknown"
    data["_userAgent"] = request.headers.get("user-agent", "")[:300]
    try:
        result = handle_api(api_request.type, data)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        logger.info(
            "api_call request_id=%s type=%s success=%s code=%s duration_ms=%s",
            request_id,
            api_request.type,
            result.get("success"),
            result.get("code"),
            duration_ms,
        )
        return result
    except Exception as error:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        logger.exception(
            "api_error request_id=%s type=%s duration_ms=%s",
            request_id,
            api_request.type,
            duration_ms,
        )
        return fail("INTERNAL_ERROR", "服务器内部错误", {"detail": str(error)})