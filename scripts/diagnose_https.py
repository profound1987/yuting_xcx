#!/usr/bin/env python3
"""
HTTPS diagnostic script for yutingsmarthome.xin.

This script is intentionally dependency-free. It checks DNS, TCP 443,
TLS handshake with SNI, certificate metadata, and HTTPS GET/POST requests.

It does not send SMS. The POST request uses auth.checkSession with an invalid
session token, only to verify that POST /api reaches the backend.

Example:
  python scripts/diagnose_https.py
  python scripts/diagnose_https.py --output aliyun-https-report.json
  python scripts/diagnose_https.py --host yutingsmarthome.xin --ip 39.97.237.214
"""

import argparse
import datetime as _datetime
import json
import platform
import socket
import ssl
import sys
import time
import traceback


DEFAULT_HOST = "yutingsmarthome.xin"
DEFAULT_PORT = 443
DEFAULT_PATH = "/api"
DEFAULT_TIMEOUT = 10.0
USER_AGENT = "YuntingAliyunTLSDiagnostic/1.0"


def utc_now():
    return _datetime.datetime.now(_datetime.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def elapsed_ms(started):
    return int((time.perf_counter() - started) * 1000)


def error_detail(error):
    detail = {
        "type": error.__class__.__name__,
        "message": str(error),
    }
    for attr in ("errno", "winerror", "strerror", "reason", "library"):
        value = getattr(error, attr, None)
        if value is not None:
            detail[attr] = value
    detail["traceback"] = traceback.format_exception_only(type(error), error)[-1].strip()
    return detail


def result(name, ok, duration_ms=None, data=None, error=None):
    item = {
        "name": name,
        "ok": bool(ok),
        "durationMs": duration_ms,
        "data": data or {},
    }
    if error is not None:
        item["error"] = error_detail(error)
    return item


def print_result(item):
    status = "OK" if item["ok"] else "FAIL"
    duration = "" if item["durationMs"] is None else " %sms" % item["durationMs"]
    print("[%s] %s%s" % (status, item["name"], duration))
    if item.get("data"):
        for key, value in item["data"].items():
            if value is None or value == "":
                continue
            print("    %s: %s" % (key, value))
    if item.get("error"):
        error = item["error"]
        print("    error: %s: %s" % (error.get("type"), error.get("message")))
        if "errno" in error:
            print("    errno: %s" % error["errno"])
        if "winerror" in error:
            print("    winerror: %s" % error["winerror"])


def resolve_host(host, port):
    started = time.perf_counter()
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        addresses = []
        seen = set()
        for family, _socktype, _proto, _canonname, sockaddr in infos:
            ip = sockaddr[0]
            key = (family, ip)
            if key in seen:
                continue
            seen.add(key)
            addresses.append({
                "family": "IPv6" if family == socket.AF_INET6 else "IPv4",
                "ip": ip,
            })
        return result(
            "DNS resolve %s" % host,
            True,
            elapsed_ms(started),
            {"addresses": addresses},
        ), addresses
    except Exception as error:
        return result("DNS resolve %s" % host, False, elapsed_ms(started), error=error), []


def tcp_connect(ip, port, timeout):
    started = time.perf_counter()
    sock = None
    try:
        sock = socket.create_connection((ip, port), timeout=timeout)
        local = "%s:%s" % sock.getsockname()[:2]
        remote = "%s:%s" % sock.getpeername()[:2]
        return result(
            "TCP connect %s:%s" % (ip, port),
            True,
            elapsed_ms(started),
            {"local": local, "remote": remote},
        )
    except Exception as error:
        return result("TCP connect %s:%s" % (ip, port), False, elapsed_ms(started), error=error)
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


def make_context(tls_version=None):
    context = ssl.create_default_context()
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    if tls_version == "TLSv1.2":
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.maximum_version = ssl.TLSVersion.TLSv1_2
    elif tls_version == "TLSv1.3":
        if not hasattr(ssl.TLSVersion, "TLSv1_3"):
            raise RuntimeError("This Python/OpenSSL build does not support TLSv1.3")
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.maximum_version = ssl.TLSVersion.TLSv1_3
    return context


def summarize_cert(cert):
    if not cert:
        return {}
    subject = []
    issuer = []
    san = []
    for item in cert.get("subject", []):
        subject.extend("%s=%s" % (key, value) for key, value in item)
    for item in cert.get("issuer", []):
        issuer.extend("%s=%s" % (key, value) for key, value in item)
    for key, value in cert.get("subjectAltName", []):
        if key.lower() == "dns":
            san.append(value)
    return {
        "subject": ", ".join(subject),
        "issuer": ", ".join(issuer),
        "notBefore": cert.get("notBefore"),
        "notAfter": cert.get("notAfter"),
        "dnsSAN": san,
    }


def tls_handshake(ip, host, port, timeout, tls_version=None):
    label_version = tls_version or "default"
    name = "TLS handshake %s via %s:%s" % (label_version, ip, port)
    started = time.perf_counter()
    sock = None
    tls_sock = None
    try:
        context = make_context(tls_version)
        sock = socket.create_connection((ip, port), timeout=timeout)
        tls_sock = context.wrap_socket(sock, server_hostname=host)
        cert = summarize_cert(tls_sock.getpeercert())
        data = {
            "serverName": host,
            "tlsVersion": tls_sock.version(),
            "cipher": tls_sock.cipher(),
            "certSubject": cert.get("subject"),
            "certIssuer": cert.get("issuer"),
            "certNotBefore": cert.get("notBefore"),
            "certNotAfter": cert.get("notAfter"),
            "certDnsSAN": cert.get("dnsSAN"),
        }
        return result(name, True, elapsed_ms(started), data)
    except Exception as error:
        return result(name, False, elapsed_ms(started), error=error)
    finally:
        for item in (tls_sock, sock):
            if item is not None:
                try:
                    item.close()
                except Exception:
                    pass


def read_http_response(tls_sock):
    chunks = []
    total = 0
    while total < 65536:
        chunk = tls_sock.recv(4096)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    raw = b"".join(chunks)
    header_bytes, _sep, body = raw.partition(b"\r\n\r\n")
    header_text = header_bytes.decode("iso-8859-1", errors="replace")
    body_text = body[:1000].decode("utf-8", errors="replace")
    status_line = header_text.splitlines()[0] if header_text else ""
    return {
        "statusLine": status_line,
        "headers": header_text,
        "bodyPreview": body_text,
        "bytesRead": len(raw),
    }


def https_request(ip, host, port, timeout, method, path, body=None):
    name = "HTTPS %s https://%s%s via %s:%s" % (method, host, path, ip, port)
    started = time.perf_counter()
    sock = None
    tls_sock = None
    try:
        body_bytes = body.encode("utf-8") if body is not None else b""
        context = make_context()
        sock = socket.create_connection((ip, port), timeout=timeout)
        tls_sock = context.wrap_socket(sock, server_hostname=host)
        headers = [
            "%s %s HTTP/1.1" % (method, path),
            "Host: %s" % host,
            "User-Agent: %s Python/%s" % (USER_AGENT, platform.python_version()),
            "Accept: application/json, text/plain, */*",
            "Connection: close",
        ]
        if body is not None:
            headers.extend([
                "Content-Type: application/json",
                "Content-Length: %s" % len(body_bytes),
            ])
        request_bytes = ("\r\n".join(headers) + "\r\n\r\n").encode("ascii") + body_bytes
        tls_sock.sendall(request_bytes)
        response = read_http_response(tls_sock)
        ok = response["statusLine"].startswith("HTTP/")
        return result(name, ok, elapsed_ms(started), response)
    except Exception as error:
        return result(name, False, elapsed_ms(started), error=error)
    finally:
        for item in (tls_sock, sock):
            if item is not None:
                try:
                    item.close()
                except Exception:
                    pass


def build_targets(host, port, timeout, explicit_ip=None):
    dns_result, addresses = resolve_host(host, port)
    targets = []
    seen = set()
    for address in addresses:
        ip = address["ip"]
        if ip not in seen:
            seen.add(ip)
            targets.append(ip)
    if explicit_ip and explicit_ip not in seen:
        targets.append(explicit_ip)
    return dns_result, targets


def run_diagnostics(args):
    report = {
        "generatedAt": utc_now(),
        "target": {
            "host": args.host,
            "port": args.port,
            "path": args.path,
            "explicitIp": args.ip,
        },
        "environment": {
            "python": sys.version.replace("\n", " "),
            "platform": platform.platform(),
            "openssl": ssl.OPENSSL_VERSION,
        },
        "results": [],
        "notes": [
            "POST test uses auth.checkSession with an invalid diagnostic token; it does not send SMS.",
            "If TCP succeeds but TLS/HTTPS fails with ConnectionResetError, the reset happens before the application reaches FastAPI.",
            "If browser access succeeds while this script and WeChat wx.request fail, ask the cloud provider to check HTTPS access policies for non-browser clients and TLS fingerprint filtering.",
        ],
    }

    print("Yunting HTTPS Diagnostic")
    print("Generated at: %s" % report["generatedAt"])
    print("Target: https://%s:%s%s" % (args.host, args.port, args.path))
    print("Python: %s" % report["environment"]["python"])
    print("OpenSSL: %s" % report["environment"]["openssl"])
    print("")

    dns_result, targets = build_targets(args.host, args.port, args.timeout, args.ip)
    report["results"].append(dns_result)
    print_result(dns_result)

    if not targets:
        print("No IP targets available; stopping.")
        return report

    post_body = json.dumps(
        {
            "type": "auth.checkSession",
            "data": {"sessionToken": "diagnostic-invalid-session"},
        },
        separators=(",", ":"),
    )

    for ip in targets:
        print("")
        print("=== Target IP: %s ===" % ip)
        tests = [
            tcp_connect(ip, args.port, args.timeout),
            tls_handshake(ip, args.host, args.port, args.timeout),
            tls_handshake(ip, args.host, args.port, args.timeout, "TLSv1.2"),
            tls_handshake(ip, args.host, args.port, args.timeout, "TLSv1.3"),
            https_request(ip, args.host, args.port, args.timeout, "GET", "/"),
            https_request(ip, args.host, args.port, args.timeout, "GET", args.path),
            https_request(ip, args.host, args.port, args.timeout, "POST", args.path, post_body),
        ]
        for item in tests:
            report["results"].append(item)
            print_result(item)

    failures = [item for item in report["results"] if not item["ok"]]
    report["summary"] = {
        "total": len(report["results"]),
        "failed": len(failures),
        "passed": len(report["results"]) - len(failures),
    }
    print("")
    print("Summary: %s passed, %s failed" % (report["summary"]["passed"], report["summary"]["failed"]))
    return report


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Diagnose HTTPS reset issues for a Mini Program API domain.")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Domain to test. Default: %(default)s")
    parser.add_argument("--port", default=DEFAULT_PORT, type=int, help="HTTPS port. Default: %(default)s")
    parser.add_argument("--path", default=DEFAULT_PATH, help="API path to test. Default: %(default)s")
    parser.add_argument("--ip", default="", help="Optional fixed IP to test with SNI/Host set to --host.")
    parser.add_argument("--timeout", default=DEFAULT_TIMEOUT, type=float, help="Timeout seconds. Default: %(default)s")
    parser.add_argument("--output", default="", help="Optional JSON report output path.")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    report = run_diagnostics(args)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as file:
            json.dump(report, file, ensure_ascii=False, indent=2)
        print("JSON report written to: %s" % args.output)
    return 0 if report.get("summary", {}).get("failed", 1) == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())