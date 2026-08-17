#!/usr/bin/env python3
"""
lan-proxy — HTTPS-прокси на Windows-ПК, дающий серверу доступ в домашнюю локалку.

Зачем: сервис code-ask живёт на VPS, а Яндекс-Станции доступны только по LAN
(облачный Quasar-API на нашем токене отвечает 401). ПК стоит в той же сети и
всегда включён, поэтому он проксирует соединения сервера к колонкам.

Что умеет:
  * `CONNECT host:port` — туннель в локалку (порты ограничены ALLOW_PORTS).
    Поверх туннеля клиент сам поднимает TLS/wss к станции.
  * `GET /_stations` — mDNS-обнаружение станций (multicast через прокси не ходит,
    поэтому сканирует ПК и отдаёт JSON: device_id, host, port, platform).
  * `GET /_health` — проверка живости.

Защита: Basic auth (пароль принимается и в `Proxy-Authorization`, и в
`Authorization` — первый для CONNECT, второй для служебных GET) + прокси слушает
только 127.0.0.1, а наружу его отдаёт frpc, чей туннель сам шифрован TLS
(frp ≥ 0.50, `transport.tls.enable` по умолчанию включён).

Свой TLS на listener'е — опция `PROXY_TLS=1`, по умолчанию выключен. Причина:
клиенту нужно поднять TLS к станции ПОВЕРХ CONNECT-туннеля, а Python не умеет
TLS-в-TLS (обернуть `SSLSocket` вторым `wrap_socket` нельзя — второй слой пойдёт
по сырому fd и порвёт первый). Включать TLS здесь имеет смысл, если прокси
слушает LAN/интернет напрямую, без frp.

Конфиг — переменные окружения (или файл `config` рядом со скриптом):
  PROXY_USER, PROXY_PASSWORD   логин/пароль (обязательны)
  PROXY_PORT                   порт listener'а (по умолчанию 8890)
  PROXY_BIND                   интерфейс (по умолчанию 127.0.0.1: наружу отдаёт frpc)
  PROXY_TLS                    1 -> слушать HTTPS (нужны TLS_CERT/TLS_KEY)
  TLS_CERT, TLS_KEY            сертификат (по умолчанию cert.pem/key.pem рядом)
  ALLOW_PORTS                  разрешённые порты CONNECT (по умолчанию 1961,443)
  ALLOW_NETS                   разрешённые префиксы адресов (по умолчанию 192.168.,10.,172.)
"""

import base64
import hmac
import json
import os
import select
import socket
import socketserver
import ssl
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_config():
    cfg = {}
    try:
        with open(os.path.join(HERE, "config"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    cfg[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return cfg


CFG = _load_config()


def _get(key, default=""):
    return os.environ.get(key) or CFG.get(key) or default


USER = _get("PROXY_USER", "server")
PASSWORD = _get("PROXY_PASSWORD", "")
PORT = int(_get("PROXY_PORT", "8890"))
BIND = _get("PROXY_BIND", "127.0.0.1")
USE_TLS = _get("PROXY_TLS", "0") in ("1", "true", "yes", "on")
CERT = _get("TLS_CERT", os.path.join(HERE, "cert.pem"))
KEY = _get("TLS_KEY", os.path.join(HERE, "key.pem"))
ALLOW_PORTS = {int(p) for p in _get("ALLOW_PORTS", "1961,443").split(",") if p.strip()}
ALLOW_NETS = tuple(n.strip() for n in _get("ALLOW_NETS", "192.168.,10.,172.").split(",")
                   if n.strip())
IDLE_TIMEOUT = float(_get("IDLE_TIMEOUT", "120"))
EXPECTED = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()

_stations_cache = {"data": [], "ts": 0.0}
_stations_lock = threading.Lock()
STATIONS_TTL = 60.0


def log(msg):
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


# ── mDNS-обнаружение станций ──────────────────────────────────────

def discover_stations(timeout=5.0):
    """Станции из локалки по mDNS `_yandexio._tcp`. -> [{device_id, host, port, platform}]"""
    with _stations_lock:
        if _stations_cache["data"] and (time.time() - _stations_cache["ts"]) < STATIONS_TTL:
            return _stations_cache["data"]
    try:
        from zeroconf import Zeroconf, ServiceBrowser
    except ImportError:
        log("zeroconf не установлен: /_stations вернёт пустой список")
        return []

    found = {}

    class _Listener:
        def add_service(self, zc, type_, name):
            info = zc.get_service_info(type_, name, timeout=2000)
            if not info:
                return
            props = {(k.decode() if isinstance(k, bytes) else k):
                     (v.decode() if isinstance(v, bytes) else v)
                     for k, v in (info.properties or {}).items()}
            addrs = info.parsed_addresses() if hasattr(info, "parsed_addresses") else []
            if props.get("deviceId") and addrs:
                found[props["deviceId"]] = {
                    "device_id": props["deviceId"], "host": addrs[0],
                    "port": info.port, "platform": props.get("platform"),
                    "label": props.get("platform") or props["deviceId"]}

        def update_service(self, *a):
            pass

        def remove_service(self, *a):
            pass

    zc = Zeroconf()
    try:
        ServiceBrowser(zc, "_yandexio._tcp.local.", _Listener())
        time.sleep(timeout)
    finally:
        zc.close()
    out = sorted(found.values(), key=lambda s: s["device_id"])
    with _stations_lock:
        _stations_cache["data"] = out
        _stations_cache["ts"] = time.time()
    return out


# ── прокси ────────────────────────────────────────────────────────

class Handler(socketserver.BaseRequestHandler):

    def _read_headers(self):
        self.request.settimeout(20)
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.request.recv(4096)
            if not chunk:
                return None, {}
            buf += chunk
            if len(buf) > 65536:
                return None, {}
        head, _, rest = buf.partition(b"\r\n\r\n")
        lines = head.decode("latin1").split("\r\n")
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        # rest — байты, которые клиент успел прислать сразу за заголовками
        # (например TLS ClientHello вдогонку CONNECT'у). Их нельзя терять:
        # отдаём вызывающему, чтобы он переслал их наверх.
        self.leftover = rest
        return lines[0], headers

    def _send(self, status, body=b"", ctype="text/plain; charset=utf-8", extra=""):
        resp = (f"HTTP/1.1 {status}\r\nContent-Length: {len(body)}\r\n"
                f"Content-Type: {ctype}\r\nConnection: close\r\n{extra}\r\n").encode()
        try:
            self.request.sendall(resp + body)
        except OSError:
            pass

    def _authorized(self, headers):
        if not PASSWORD:
            return False
        for key in ("proxy-authorization", "authorization"):
            got = headers.get(key)
            if got and hmac.compare_digest(got.strip(), EXPECTED):
                return True
        return False

    def handle(self):
        self.leftover = b""
        try:
            request_line, headers = self._read_headers()
        except (OSError, ssl.SSLError):
            return
        if not request_line:
            return
        parts = request_line.split()
        if len(parts) < 2:
            return self._send("400 Bad Request", b"bad request\n")
        method, target = parts[0].upper(), parts[1]

        if not self._authorized(headers):
            log(f"401 {method} {target} от {self.client_address[0]}")
            return self._send("407 Proxy Authentication Required", b"auth required\n",
                              extra='Proxy-Authenticate: Basic realm="lan-proxy"\r\n')

        if method == "CONNECT":
            return self._do_connect(target)
        if method == "GET" and target.startswith("/_stations"):
            body = json.dumps({"stations": discover_stations()},
                              ensure_ascii=False).encode()
            return self._send("200 OK", body, "application/json; charset=utf-8")
        if method == "GET" and target.startswith("/_health"):
            return self._send("200 OK", b'{"ok":true}\n', "application/json")
        return self._send("405 Method Not Allowed", b"only CONNECT/_stations/_health\n")

    def _do_connect(self, target):
        host, _, port_s = target.rpartition(":")
        try:
            port = int(port_s)
        except ValueError:
            return self._send("400 Bad Request", b"bad target\n")
        if port not in ALLOW_PORTS:
            log(f"403 порт {port} не разрешён")
            return self._send("403 Forbidden", b"port not allowed\n")
        if ALLOW_NETS and not host.startswith(ALLOW_NETS):
            log(f"403 адрес {host} не разрешён")
            return self._send("403 Forbidden", b"host not allowed\n")
        try:
            upstream = socket.create_connection((host, port), timeout=10)
        except OSError as e:
            log(f"502 {host}:{port} — {e}")
            return self._send("502 Bad Gateway", b"upstream unreachable\n")
        log(f"CONNECT {host}:{port} открыт")
        try:
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if self.leftover:
                upstream.sendall(self.leftover)
            self._pump(self.request, upstream)
        finally:
            upstream.close()
            log(f"CONNECT {host}:{port} закрыт")

    @staticmethod
    def _pump(a, b):
        """Двусторонняя перекачка байтов до закрытия любой из сторон."""
        a.settimeout(None)
        b.settimeout(None)
        socks = [a, b]
        while True:
            try:
                ready, _, err = select.select(socks, [], socks, IDLE_TIMEOUT)
            except (OSError, ValueError):
                return
            if err or not ready:
                return
            for src in ready:
                dst = b if src is a else a
                try:
                    data = src.recv(65536)
                except (OSError, ssl.SSLError):
                    return
                if not data:
                    return
                try:
                    dst.sendall(data)
                except OSError:
                    return


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    if not PASSWORD:
        sys.exit("PROXY_PASSWORD не задан (env или файл config рядом со скриптом)")
    srv = Server((BIND, PORT), Handler)
    scheme = "http"
    if USE_TLS:
        if not (os.path.exists(CERT) and os.path.exists(KEY)):
            sys.exit(f"PROXY_TLS=1, но нет сертификата: {CERT} / {KEY}")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"
    log(f"lan-proxy на {scheme}://{BIND}:{PORT} user={USER} "
        f"порты={sorted(ALLOW_PORTS)} сети={ALLOW_NETS}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
