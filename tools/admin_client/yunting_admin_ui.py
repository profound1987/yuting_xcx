from __future__ import annotations

import json
import os
import threading
import time
import traceback
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk


DEFAULT_BASE_URL = "https://yutingsmarthome.xin"
DEFAULT_TIMEOUT_SECONDS = "12"
SSH_TUNNEL_BASE_URL = "http://127.0.0.1:18000"
SSH_TUNNEL_COMMAND = "ssh -N -L 18000:127.0.0.1:8000 -i C:\\Users\\THINK\\.ssh\\yunting_dev_ed25519 yunting@39.97.237.214"
INVALID_INPUT = object()


class AdminClientError(Exception):
    pass


@dataclass
class ApiResult:
    body: dict[str, Any] | list[Any] | str
    request_id: str
    elapsed_ms: int
    http_status: int | None = None


class AdminApiClient:
    def __init__(self, base_url: str, admin_token: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.admin_token = admin_token
        self.timeout_seconds = timeout_seconds

    def api_url(self) -> str:
        if self.base_url.endswith("/api"):
            return self.base_url
        return f"{self.base_url}/api"

    def call(self, api_type: str, payload: dict[str, Any] | None = None) -> ApiResult:
        if not self.admin_token:
            raise AdminClientError("请先填写管理员密钥")
        data = dict(payload or {})
        data["adminToken"] = self.admin_token
        return self._post_api(api_type, data)

    def health(self) -> ApiResult:
        url = self.api_url()
        started_at = time.perf_counter()
        try:
            with urllib.request.urlopen(url, timeout=self.timeout_seconds) as response:
                raw_body = response.read().decode("utf-8", errors="replace")
                elapsed_ms = int((time.perf_counter() - started_at) * 1000)
                return ApiResult(
                    body=parse_json_or_text(raw_body),
                    request_id=response.headers.get("X-Request-Id", ""),
                    elapsed_ms=elapsed_ms,
                    http_status=getattr(response, "status", None),
                )
        except urllib.error.HTTPError as error:
            raise AdminClientError(format_http_error(error, started_at)) from error
        except urllib.error.URLError as error:
            raise AdminClientError(format_url_error(error)) from error
        except TimeoutError as error:
            raise AdminClientError("请求超时") from error

    def _post_api(self, api_type: str, data: dict[str, Any]) -> ApiResult:
        url = self.api_url()
        body = json.dumps({"type": api_type, "data": data}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        started_at = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw_body = response.read().decode("utf-8", errors="replace")
                elapsed_ms = int((time.perf_counter() - started_at) * 1000)
                return ApiResult(
                    body=parse_json_or_text(raw_body),
                    request_id=response.headers.get("X-Request-Id", ""),
                    elapsed_ms=elapsed_ms,
                    http_status=getattr(response, "status", None),
                )
        except urllib.error.HTTPError as error:
            raise AdminClientError(format_http_error(error, started_at)) from error
        except urllib.error.URLError as error:
            raise AdminClientError(format_url_error(error)) from error
        except TimeoutError as error:
            raise AdminClientError("请求超时") from error


class AdminApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("云汀智能家居 - 本地管理员工具")
        self.geometry("1180x780")
        self.minsize(980, 680)

        self.base_url_var = tk.StringVar(value=os.getenv("YT_ADMIN_BASE_URL", DEFAULT_BASE_URL))
        self.token_var = tk.StringVar(value=os.getenv("YT_ADMIN_TOKEN", ""))
        self.timeout_var = tk.StringVar(value=os.getenv("YT_ADMIN_TIMEOUT", DEFAULT_TIMEOUT_SECONDS))
        self.show_token_var = tk.BooleanVar(value=False)
        self.status_var = tk.StringVar(value="就绪")
        self.action_buttons: list[ttk.Button] = []

        self._configure_style()
        self._build_layout()

    def _configure_style(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 13, "bold"))
        style.configure("Hint.TLabel", foreground="#5f6b7a")
        style.configure("Danger.TButton", foreground="#a52828")

    def _build_layout(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)
        self.rowconfigure(2, weight=2)

        self._build_connection_panel()
        self._build_notebook()
        self._build_output_panel()
        self._build_status_bar()

    def _build_connection_panel(self) -> None:
        panel = ttk.Frame(self, padding=(14, 12, 14, 8))
        panel.grid(row=0, column=0, sticky="ew")
        panel.columnconfigure(1, weight=1)
        panel.columnconfigure(3, weight=1)

        ttk.Label(panel, text="云汀本地管理员工具", style="Title.TLabel").grid(row=0, column=0, columnspan=6, sticky="w", pady=(0, 8))

        ttk.Label(panel, text="服务器地址").grid(row=1, column=0, sticky="w", padx=(0, 8))
        ttk.Entry(panel, textvariable=self.base_url_var).grid(row=1, column=1, sticky="ew", padx=(0, 14))

        ttk.Label(panel, text="管理员密钥").grid(row=1, column=2, sticky="w", padx=(0, 8))
        self.token_entry = ttk.Entry(panel, textvariable=self.token_var, show="*")
        self.token_entry.grid(row=1, column=3, sticky="ew", padx=(0, 8))

        ttk.Checkbutton(panel, text="显示", variable=self.show_token_var, command=self._toggle_token_visibility).grid(row=1, column=4, sticky="w", padx=(0, 12))

        ttk.Label(panel, text="超时秒").grid(row=1, column=5, sticky="w", padx=(0, 8))
        ttk.Entry(panel, textvariable=self.timeout_var, width=7).grid(row=1, column=6, sticky="w")

        health_button = ttk.Button(panel, text="健康检查", command=self.run_health_check)
        health_button.grid(row=1, column=7, sticky="e", padx=(12, 0))
        self.action_buttons.append(health_button)

        ttk.Label(
            panel,
            text="密钥只在本窗口内使用，不会写入文件；请求结果中也不会显示密钥。",
            style="Hint.TLabel",
        ).grid(row=2, column=0, columnspan=8, sticky="w", pady=(8, 0))

    def _build_notebook(self) -> None:
        self.notebook = ttk.Notebook(self)
        self.notebook.grid(row=1, column=0, sticky="nsew", padx=14, pady=(4, 10))

        self._build_overview_tab()
        self._build_user_tab()
        self._build_device_tab()
        self._build_bind_attempts_tab()
        self._build_commands_tab()
        self._build_management_tab()
        self._build_audit_tab()
        self._build_raw_request_tab()

    def _build_output_panel(self) -> None:
        panel = ttk.Frame(self, padding=(14, 0, 14, 8))
        panel.grid(row=2, column=0, sticky="nsew")
        panel.columnconfigure(0, weight=1)
        panel.rowconfigure(1, weight=1)

        toolbar = ttk.Frame(panel)
        toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        ttk.Label(toolbar, text="结果", style="Title.TLabel").pack(side="left")
        ttk.Button(toolbar, text="复制结果", command=self.copy_output).pack(side="right")
        ttk.Button(toolbar, text="清空", command=self.clear_output).pack(side="right", padx=(0, 8))

        self.output = scrolledtext.ScrolledText(panel, wrap="word", height=16, font=("Consolas", 10))
        self.output.grid(row=1, column=0, sticky="nsew")

    def _build_status_bar(self) -> None:
        bar = ttk.Frame(self, padding=(14, 0, 14, 10))
        bar.grid(row=3, column=0, sticky="ew")
        ttk.Label(bar, textvariable=self.status_var, style="Hint.TLabel").pack(side="left")

    def _build_overview_tab(self) -> None:
        frame = self._new_tab("总览")
        frame.columnconfigure(1, weight=1)
        self.overview_type_code_var = tk.StringVar()
        self.overview_bind_status_var = tk.StringVar()
        self.overview_online_var = tk.StringVar()
        self.overview_limit_var = tk.StringVar(value="50")

        ttk.Label(frame, text="查看用户、设备、绑定失败和控制指令的整体统计。", style="Hint.TLabel").grid(row=0, column=0, columnspan=3, sticky="w")
        self._button(frame, "刷新总览", lambda: self.run_admin_call("总览统计", "admin.overview", {})).grid(row=1, column=0, columnspan=2, sticky="w", pady=(16, 18))

        ttk.Separator(frame).grid(row=2, column=0, columnspan=3, sticky="ew", pady=(0, 18))
        ttk.Label(frame, text="按类型和状态列出设备", style="Title.TLabel").grid(row=3, column=0, columnspan=3, sticky="w", pady=(0, 10))
        self._combo_row(frame, 4, "设备类型码", self.overview_type_code_var, ["", "AW", "ES", "LC", "SP", "GW"])
        self._combo_row(frame, 5, "绑定状态", self.overview_bind_status_var, ["", "bound", "unbound"])
        self._combo_row(frame, 6, "在线状态", self.overview_online_var, ["", "online", "offline"])
        self._entry_row(frame, 7, "返回条数", self.overview_limit_var, width=12)
        self._button(frame, "列出设备", self.search_devices).grid(row=8, column=1, sticky="w", pady=(10, 0))

    def _build_user_tab(self) -> None:
        frame = self._new_tab("用户查询")
        frame.columnconfigure(1, weight=1)
        self.users_status_var = tk.StringVar()
        self.users_since_hours_var = tk.StringVar()
        self.users_limit_var = tk.StringVar(value="50")
        self.users_include_seed_var = tk.BooleanVar(value=False)
        self.users_include_phone_var = tk.BooleanVar(value=False)
        self.user_phone_var = tk.StringVar()
        self.user_limit_var = tk.StringVar(value="20")
        self.user_openid_var = tk.StringVar()

        ttk.Label(frame, text="列出已注册用户", style="Title.TLabel").grid(row=0, column=0, columnspan=3, sticky="w", pady=(0, 10))
        self._combo_row(frame, 1, "用户状态", self.users_status_var, ["", "active", "disabled"])
        self._entry_row(frame, 2, "最近小时", self.users_since_hours_var, width=12, hint="为空表示不限时间")
        self._entry_row(frame, 3, "返回条数", self.users_limit_var, width=12)
        ttk.Checkbutton(frame, text="包含预置测试用户", variable=self.users_include_seed_var).grid(row=4, column=1, sticky="w", pady=(6, 0))
        ttk.Checkbutton(frame, text="返回完整手机号", variable=self.users_include_phone_var).grid(row=4, column=2, sticky="w", padx=(10, 0), pady=(6, 0))
        self._button(frame, "列出注册用户", self.search_users).grid(row=5, column=1, sticky="w", pady=(10, 22))

        ttk.Separator(frame).grid(row=6, column=0, columnspan=3, sticky="ew", pady=(0, 18))
        ttk.Label(frame, text="按条件精确查询", style="Title.TLabel").grid(row=7, column=0, columnspan=3, sticky="w", pady=(0, 10))
        self._entry_row(frame, 8, "手机号", self.user_phone_var, hint="如 13800138000")
        self._entry_row(frame, 9, "返回条数", self.user_limit_var, width=12)
        self._button(frame, "按手机号查询", self.search_user_by_phone).grid(row=10, column=1, sticky="w", pady=(10, 22))

        ttk.Separator(frame).grid(row=11, column=0, columnspan=3, sticky="ew", pady=(0, 18))
        self._entry_row(frame, 12, "OpenID", self.user_openid_var, hint="用户在关于页复制的 OpenID")
        self._button(frame, "按 OpenID 查询", self.search_user_by_openid).grid(row=13, column=1, sticky="w", pady=(10, 0))

    def _build_device_tab(self) -> None:
        frame = self._new_tab("设备查询")
        frame.columnconfigure(1, weight=1)
        self.device_no_var = tk.StringVar()
        self.device_limit_var = tk.StringVar(value="20")

        self._entry_row(frame, 0, "设备号", self.device_no_var, hint="如 YT-AW-00000-A324")
        self._entry_row(frame, 1, "返回条数", self.device_limit_var, width=12)
        self._button(frame, "查询设备", self.search_device_by_no).grid(row=2, column=1, sticky="w", pady=(10, 0))

    def _build_bind_attempts_tab(self) -> None:
        frame = self._new_tab("绑定失败")
        frame.columnconfigure(1, weight=1)
        self.bind_phone_var = tk.StringVar()
        self.bind_device_var = tk.StringVar()
        self.bind_result_var = tk.StringVar()
        self.bind_code_var = tk.StringVar()
        self.bind_reason_var = tk.StringVar()
        self.bind_since_hours_var = tk.StringVar(value="24")
        self.bind_limit_var = tk.StringVar(value="50")

        self._entry_row(frame, 0, "手机号", self.bind_phone_var)
        self._entry_row(frame, 1, "设备号", self.bind_device_var)
        self._combo_row(frame, 2, "结果", self.bind_result_var, ["", "success", "failed", "blocked"])
        self._entry_row(frame, 3, "错误码", self.bind_code_var, hint="如 DEVICE_ALREADY_BOUND")
        self._entry_row(frame, 4, "原因", self.bind_reason_var, hint="如 bound_by_other")
        self._entry_row(frame, 5, "最近小时", self.bind_since_hours_var, width=12)
        self._entry_row(frame, 6, "返回条数", self.bind_limit_var, width=12)
        self._button(frame, "查询绑定记录", self.search_bind_attempts).grid(row=7, column=1, sticky="w", pady=(10, 0))

    def _build_commands_tab(self) -> None:
        frame = self._new_tab("控制记录")
        frame.columnconfigure(1, weight=1)
        self.commands_phone_var = tk.StringVar()
        self.commands_device_var = tk.StringVar()
        self.commands_type_var = tk.StringVar()
        self.commands_status_var = tk.StringVar()
        self.commands_since_hours_var = tk.StringVar(value="24")
        self.commands_limit_var = tk.StringVar(value="50")

        self._entry_row(frame, 0, "手机号", self.commands_phone_var)
        self._entry_row(frame, 1, "设备号", self.commands_device_var)
        self._combo_row(frame, 2, "指令类型", self.commands_type_var, ["", "watering.saveConfig", "watering.startManual", "watering.stopManual"])
        self._combo_row(frame, 3, "状态", self.commands_status_var, ["", "success", "failed"])
        self._entry_row(frame, 4, "最近小时", self.commands_since_hours_var, width=12)
        self._entry_row(frame, 5, "返回条数", self.commands_limit_var, width=12)
        self._button(frame, "查询控制记录", self.search_device_commands).grid(row=6, column=1, sticky="w", pady=(10, 0))

    def _build_management_tab(self) -> None:
        frame = self._new_tab("管理操作")
        frame.columnconfigure(1, weight=1)
        frame.columnconfigure(4, weight=1)

        ttk.Label(frame, text="用户操作", style="Title.TLabel").grid(row=0, column=0, columnspan=3, sticky="w")
        self.manage_phone_var = tk.StringVar()
        self.manage_user_id_var = tk.StringVar()
        self.manage_user_reason_var = tk.StringVar(value="admin_disabled")
        self._entry_row(frame, 1, "手机号", self.manage_phone_var, column=0)
        self._entry_row(frame, 2, "用户 ID", self.manage_user_id_var, column=0)
        self._entry_row(frame, 3, "原因", self.manage_user_reason_var, column=0)
        user_buttons = ttk.Frame(frame)
        user_buttons.grid(row=4, column=1, sticky="w", pady=(10, 18))
        self._button(user_buttons, "禁用用户", self.disable_user, style="Danger.TButton").pack(side="left", padx=(0, 8))
        self._button(user_buttons, "恢复用户", self.restore_user).pack(side="left")

        ttk.Separator(frame).grid(row=5, column=0, columnspan=6, sticky="ew", pady=(0, 18))
        ttk.Label(frame, text="设备操作", style="Title.TLabel").grid(row=6, column=0, columnspan=3, sticky="w")
        self.manage_device_var = tk.StringVar()
        self.manage_device_reason_var = tk.StringVar(value="admin_disabled")
        self._entry_row(frame, 7, "设备号", self.manage_device_var, column=0)
        self._entry_row(frame, 8, "原因", self.manage_device_reason_var, column=0)
        device_buttons = ttk.Frame(frame)
        device_buttons.grid(row=9, column=1, sticky="w", pady=(10, 0))
        self._button(device_buttons, "禁用设备", self.disable_device, style="Danger.TButton").pack(side="left", padx=(0, 8))
        self._button(device_buttons, "恢复设备", self.restore_device).pack(side="left", padx=(0, 8))
        self._button(device_buttons, "强制解绑", self.force_unbind_device, style="Danger.TButton").pack(side="left")

        ttk.Label(
            frame,
            text="危险操作会先弹出确认框，并会写入服务端 admin_audit_events 审计记录。",
            style="Hint.TLabel",
        ).grid(row=10, column=0, columnspan=6, sticky="w", pady=(16, 0))

    def _build_audit_tab(self) -> None:
        frame = self._new_tab("管理审计")
        frame.columnconfigure(1, weight=1)
        self.audit_action_var = tk.StringVar()
        self.audit_target_type_var = tk.StringVar()
        self.audit_target_id_var = tk.StringVar()
        self.audit_since_hours_var = tk.StringVar(value="24")
        self.audit_limit_var = tk.StringVar(value="50")

        self._entry_row(frame, 0, "动作", self.audit_action_var, hint="如 admin.device.findByNo")
        self._combo_row(frame, 1, "目标类型", self.audit_target_type_var, ["", "system", "user", "phone", "device", "openid", "bind_attempt", "device_command", "admin_audit"])
        self._entry_row(frame, 2, "目标 ID", self.audit_target_id_var)
        self._entry_row(frame, 3, "最近小时", self.audit_since_hours_var, width=12)
        self._entry_row(frame, 4, "返回条数", self.audit_limit_var, width=12)
        self._button(frame, "查询审计记录", self.search_audit).grid(row=5, column=1, sticky="w", pady=(10, 0))

    def _build_raw_request_tab(self) -> None:
        frame = self._new_tab("高级调用")
        frame.columnconfigure(1, weight=1)
        frame.rowconfigure(1, weight=1)
        self.raw_type_var = tk.StringVar(value="admin.overview")
        self._entry_row(frame, 0, "接口 type", self.raw_type_var)
        ttk.Label(frame, text="data JSON", anchor="nw").grid(row=1, column=0, sticky="nw", padx=(0, 10), pady=(4, 0))
        self.raw_data_text = scrolledtext.ScrolledText(frame, wrap="word", height=8, font=("Consolas", 10))
        self.raw_data_text.grid(row=1, column=1, sticky="nsew", pady=(4, 0))
        self.raw_data_text.insert("1.0", "{}")
        self._button(frame, "发送高级调用", self.run_raw_request).grid(row=2, column=1, sticky="w", pady=(10, 0))
        ttk.Label(frame, text="这里会自动补入 adminToken，请不要在 JSON 里填写密钥。", style="Hint.TLabel").grid(row=3, column=1, sticky="w", pady=(10, 0))

    def _new_tab(self, title: str) -> ttk.Frame:
        frame = ttk.Frame(self.notebook, padding=16)
        self.notebook.add(frame, text=title)
        return frame

    def _entry_row(
        self,
        parent: tk.Widget,
        row: int,
        label: str,
        variable: tk.StringVar,
        width: int | None = None,
        hint: str = "",
        column: int = 0,
    ) -> ttk.Entry:
        ttk.Label(parent, text=label).grid(row=row, column=column, sticky="w", padx=(0, 10), pady=4)
        entry = ttk.Entry(parent, textvariable=variable, width=width)
        entry.grid(row=row, column=column + 1, sticky="ew", pady=4)
        if hint:
            ttk.Label(parent, text=hint, style="Hint.TLabel").grid(row=row, column=column + 2, sticky="w", padx=(10, 0), pady=4)
        return entry

    def _combo_row(
        self,
        parent: tk.Widget,
        row: int,
        label: str,
        variable: tk.StringVar,
        values: list[str],
    ) -> ttk.Combobox:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=(0, 10), pady=4)
        combo = ttk.Combobox(parent, textvariable=variable, values=values, state="readonly")
        combo.grid(row=row, column=1, sticky="ew", pady=4)
        return combo

    def _button(self, parent: tk.Widget, text: str, command: Callable[[], None], style: str | None = None) -> ttk.Button:
        button = ttk.Button(parent, text=text, command=command, style=style)
        self.action_buttons.append(button)
        return button

    def _toggle_token_visibility(self) -> None:
        self.token_entry.configure(show="" if self.show_token_var.get() else "*")

    def make_client(self, require_token: bool = True) -> AdminApiClient | None:
        base_url = self.base_url_var.get().strip()
        if not (base_url.startswith("http://") or base_url.startswith("https://")):
            messagebox.showerror("配置错误", "服务器地址必须以 http:// 或 https:// 开头")
            return None
        try:
            timeout_seconds = float(self.timeout_var.get().strip() or DEFAULT_TIMEOUT_SECONDS)
        except ValueError:
            messagebox.showerror("配置错误", "超时秒数必须是数字")
            return None
        if timeout_seconds <= 0:
            messagebox.showerror("配置错误", "超时秒数必须大于 0")
            return None
        admin_token = self.token_var.get().strip()
        if require_token and not admin_token:
            messagebox.showerror("配置错误", "请先填写管理员密钥")
            return None
        return AdminApiClient(base_url, admin_token, timeout_seconds)

    def run_health_check(self) -> None:
        client = self.make_client(require_token=False)
        if not client:
            return
        self._run_in_background("健康检查", "GET /api", lambda: client.health())

    def run_admin_call(self, title: str, api_type: str, payload: dict[str, Any], confirm_message: str | None = None) -> None:
        if confirm_message and not messagebox.askyesno("确认操作", confirm_message):
            return
        client = self.make_client(require_token=True)
        if not client:
            return
        self._run_in_background(title, api_type, lambda: client.call(api_type, payload))

    def _run_in_background(self, title: str, api_label: str, worker: Callable[[], ApiResult]) -> None:
        self.set_busy(True)
        self.status_var.set(f"请求中：{api_label}")

        def run() -> None:
            try:
                result = worker()
                self.after(0, lambda: self.show_result(title, api_label, result))
            except Exception as error:
                message = str(error) or error.__class__.__name__
                detail = traceback.format_exc()
                self.after(0, lambda: self.show_error(title, api_label, message, detail))
            finally:
                self.after(0, lambda: self.set_busy(False))

        threading.Thread(target=run, daemon=True).start()

    def show_result(self, title: str, api_label: str, result: ApiResult) -> None:
        self.status_var.set(f"完成：{api_label}，耗时 {result.elapsed_ms} ms")
        lines = [
            f"# {title}",
            f"接口: {api_label}",
            f"HTTP 状态: {result.http_status if result.http_status is not None else '-'}",
            f"请求 ID: {result.request_id or '-'}",
            f"耗时: {result.elapsed_ms} ms",
            "",
            format_body(result.body),
        ]
        self.write_output("\n".join(lines))

    def show_error(self, title: str, api_label: str, message: str, detail: str) -> None:
        self.status_var.set(f"失败：{api_label}")
        self.write_output(f"# {title}\n接口: {api_label}\n错误: {message}\n\n{detail}")
        messagebox.showerror("请求失败", message)

    def set_busy(self, busy: bool) -> None:
        state = "disabled" if busy else "normal"
        for button in self.action_buttons:
            button.configure(state=state)

    def write_output(self, text: str) -> None:
        self.output.configure(state="normal")
        self.output.delete("1.0", tk.END)
        self.output.insert("1.0", text)
        self.output.configure(state="normal")

    def clear_output(self) -> None:
        self.output.delete("1.0", tk.END)
        self.status_var.set("已清空结果")

    def copy_output(self) -> None:
        text = self.output.get("1.0", tk.END).strip()
        if not text:
            self.status_var.set("没有可复制的结果")
            return
        self.clipboard_clear()
        self.clipboard_append(text)
        self.status_var.set("结果已复制")

    def search_users(self) -> None:
        payload = compact_payload(
            {
                "status": self.users_status_var.get(),
                "limit": self.read_limit(self.users_limit_var, default=50),
                "sinceMs": self.read_since_ms(self.users_since_hours_var),
                "includeSeedUsers": self.users_include_seed_var.get(),
                "includePhone": self.users_include_phone_var.get(),
            }
        )
        if payload is None:
            return
        self.run_admin_call("列出注册用户", "admin.users.search", payload)

    def search_user_by_phone(self) -> None:
        payload = compact_payload({"phone": self.user_phone_var.get(), "limit": self.read_limit(self.user_limit_var, default=20)})
        if payload is None:
            return
        if not payload.get("phone"):
            messagebox.showerror("参数错误", "请填写手机号")
            return
        self.run_admin_call("按手机号查询用户", "admin.user.findByPhone", payload)

    def search_user_by_openid(self) -> None:
        payload = compact_payload({"openid": self.user_openid_var.get()})
        if not payload.get("openid"):
            messagebox.showerror("参数错误", "请填写 OpenID")
            return
        self.run_admin_call("按 OpenID 查询用户", "admin.user.findByOpenid", payload)

    def search_device_by_no(self) -> None:
        payload = compact_payload({"deviceNo": self.device_no_var.get(), "limit": self.read_limit(self.device_limit_var, default=20)})
        if payload is None:
            return
        if not payload.get("deviceNo"):
            messagebox.showerror("参数错误", "请填写设备号")
            return
        self.run_admin_call("按设备号查询设备", "admin.device.findByNo", payload)

    def search_devices(self) -> None:
        payload = compact_payload(
            {
                "typeCode": self.overview_type_code_var.get(),
                "bindStatus": self.overview_bind_status_var.get(),
                "online": self.overview_online_var.get(),
                "limit": self.read_limit(self.overview_limit_var, default=50),
            }
        )
        if payload is None:
            return
        self.run_admin_call("按条件列出设备", "admin.devices.search", payload)

    def search_bind_attempts(self) -> None:
        payload = compact_payload(
            {
                "phone": self.bind_phone_var.get(),
                "deviceNo": self.bind_device_var.get(),
                "result": self.bind_result_var.get(),
                "code": self.bind_code_var.get(),
                "reason": self.bind_reason_var.get(),
                "limit": self.read_limit(self.bind_limit_var, default=50),
                "sinceMs": self.read_since_ms(self.bind_since_hours_var),
            }
        )
        if payload is None:
            return
        self.run_admin_call("绑定失败排障", "admin.bindAttempts.search", payload)

    def search_device_commands(self) -> None:
        payload = compact_payload(
            {
                "phone": self.commands_phone_var.get(),
                "deviceNo": self.commands_device_var.get(),
                "commandType": self.commands_type_var.get(),
                "status": self.commands_status_var.get(),
                "limit": self.read_limit(self.commands_limit_var, default=50),
                "sinceMs": self.read_since_ms(self.commands_since_hours_var),
            }
        )
        if payload is None:
            return
        self.run_admin_call("控制指令查询", "admin.device.commands", payload)

    def search_audit(self) -> None:
        payload = compact_payload(
            {
                "action": self.audit_action_var.get(),
                "targetType": self.audit_target_type_var.get(),
                "targetId": self.audit_target_id_var.get(),
                "limit": self.read_limit(self.audit_limit_var, default=50),
                "sinceMs": self.read_since_ms(self.audit_since_hours_var),
            }
        )
        if payload is None:
            return
        self.run_admin_call("管理审计查询", "admin.audit.search", payload)

    def disable_user(self) -> None:
        payload = compact_payload({"phone": self.manage_phone_var.get(), "userId": self.manage_user_id_var.get(), "reason": self.manage_user_reason_var.get()})
        if not payload.get("phone") and not payload.get("userId"):
            messagebox.showerror("参数错误", "请填写手机号或用户 ID")
            return
        self.run_admin_call("禁用用户", "admin.user.disable", payload, "确认禁用该用户并撤销其活跃会话吗？")

    def restore_user(self) -> None:
        payload = compact_payload({"phone": self.manage_phone_var.get(), "userId": self.manage_user_id_var.get()})
        if not payload.get("phone") and not payload.get("userId"):
            messagebox.showerror("参数错误", "请填写手机号或用户 ID")
            return
        self.run_admin_call("恢复用户", "admin.user.restore", payload, "确认恢复该用户吗？")

    def disable_device(self) -> None:
        payload = compact_payload({"deviceNo": self.manage_device_var.get(), "reason": self.manage_device_reason_var.get()})
        if not payload.get("deviceNo"):
            messagebox.showerror("参数错误", "请填写设备号")
            return
        self.run_admin_call("禁用设备", "admin.device.disable", payload, "确认禁用该设备并置为离线吗？")

    def restore_device(self) -> None:
        payload = compact_payload({"deviceNo": self.manage_device_var.get()})
        if not payload.get("deviceNo"):
            messagebox.showerror("参数错误", "请填写设备号")
            return
        self.run_admin_call("恢复设备", "admin.device.restore", payload, "确认恢复该设备为 registered 状态吗？")

    def force_unbind_device(self) -> None:
        payload = compact_payload({"deviceNo": self.manage_device_var.get(), "reason": self.manage_device_reason_var.get() or "admin_force_unbind"})
        if not payload.get("deviceNo"):
            messagebox.showerror("参数错误", "请填写设备号")
            return
        self.run_admin_call("强制解绑设备", "admin.device.forceUnbind", payload, "确认强制解绑该设备吗？这会清除当前绑定用户。")

    def run_raw_request(self) -> None:
        api_type = self.raw_type_var.get().strip()
        if not api_type:
            messagebox.showerror("参数错误", "请填写接口 type")
            return
        try:
            payload = json.loads(self.raw_data_text.get("1.0", tk.END).strip() or "{}")
        except json.JSONDecodeError as error:
            messagebox.showerror("JSON 错误", f"data JSON 格式错误：{error}")
            return
        if not isinstance(payload, dict):
            messagebox.showerror("参数错误", "data JSON 必须是对象")
            return
        payload.pop("adminToken", None)
        self.run_admin_call("高级管理调用", api_type, payload)

    def read_limit(self, variable: tk.StringVar, default: int) -> int | object:
        raw_value = variable.get().strip()
        if not raw_value:
            return default
        try:
            limit = int(raw_value)
        except ValueError:
            messagebox.showerror("参数错误", "返回条数必须是整数")
            return INVALID_INPUT
        if limit <= 0 or limit > 200:
            messagebox.showerror("参数错误", "返回条数范围应为 1 到 200")
            return INVALID_INPUT
        return limit

    def read_since_ms(self, variable: tk.StringVar) -> int | object | None:
        raw_value = variable.get().strip()
        if not raw_value:
            return None
        try:
            hours = float(raw_value)
        except ValueError:
            messagebox.showerror("参数错误", "最近小时必须是数字")
            return INVALID_INPUT
        if hours <= 0:
            messagebox.showerror("参数错误", "最近小时必须大于 0")
            return INVALID_INPUT
        return int(time.time() * 1000 - hours * 60 * 60 * 1000)


def compact_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    compacted: dict[str, Any] = {}
    for key, value in payload.items():
        if value is INVALID_INPUT:
            return None
        if value is None:
            continue
        if isinstance(value, str):
            value = value.strip()
            if not value:
                continue
        compacted[key] = value
    return compacted


def parse_json_or_text(raw_body: str) -> dict[str, Any] | list[Any] | str:
    try:
        return json.loads(raw_body)
    except json.JSONDecodeError:
        return raw_body


def format_body(body: dict[str, Any] | list[Any] | str) -> str:
    if isinstance(body, (dict, list)):
        return json.dumps(body, ensure_ascii=False, indent=2)
    return body


def format_http_error(error: urllib.error.HTTPError, started_at: float) -> str:
    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
    raw_body = error.read().decode("utf-8", errors="replace")
    body = parse_json_or_text(raw_body)
    return f"HTTP {error.code}，耗时 {elapsed_ms} ms：\n{format_body(body)}"


def format_url_error(error: urllib.error.URLError) -> str:
    reason = getattr(error, "reason", error)
    message = f"连接服务器失败：{reason}"
    if isinstance(reason, ConnectionResetError) or "10054" in str(reason) or "Connection reset" in str(reason):
        message += (
            "\n\n检测到连接被重置。若 HTTPS 443 被 TLS 握手重置影响，可以先保持 SSH 隧道运行："
            f"\n{SSH_TUNNEL_COMMAND}"
            f"\n然后将服务器地址改为：{SSH_TUNNEL_BASE_URL}"
        )
    return message


def main() -> None:
    app = AdminApp()
    app.mainloop()


if __name__ == "__main__":
    main()