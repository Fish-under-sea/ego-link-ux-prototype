#!/usr/bin/env python3
# 第 1 周服务端（VPS 角色）：接收 / 存储 / 查询 板端观测记录，并托管 Web 页面
# 仅用标准库，便于课堂任意机器直接运行：python server/app.py
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'data')
OBS_FILE = os.path.join(DATA_DIR, 'observations.jsonl')
WEB_DIR = os.path.normpath(os.path.join(ROOT, '..', 'web'))
HOST = '0.0.0.0'
PORT = int(os.environ.get('EYE_SERVER_PORT', '8000'))
CST = timezone(timedelta(hours=8))
REQUIRED_FIELDS = ['device_id', 'sensor', 'record_id', 'status']
_state = {'n': 0, 'record_ids': set()}


def _load_index():
    """启动时载入已存 record_id，保证重发/重试不会产生重复记录。"""
    for rec in _read_all():
        rid = rec.get('record_id')
        if rid:
            _state['record_ids'].add(rid)
    _state['n'] = _count_lines()
    return len(_state['record_ids'])


def _now_iso():
    return datetime.now(CST).strftime('%Y-%m-%dT%H:%M:%S%z')


def _next_index():
    _state['n'] += 1
    return _state['n']


def _count_lines():
    if not os.path.exists(OBS_FILE):
        return 0
    n = 0
    with open(OBS_FILE, 'r', encoding='utf-8') as f:
        for _ in f:
            n += 1
    return n


def _append(record):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OBS_FILE, 'a', encoding='utf-8') as f:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')


def _read_all():
    if not os.path.exists(OBS_FILE):
        return []
    out = []
    with open(OBS_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def validate(rec):
    missing = [k for k in REQUIRED_FIELDS if not rec.get(k)]
    if missing:
        return '缺少必要字段: ' + ', '.join(missing)
    if rec.get('status') not in ('ok', 'no_fix', 'error', 'stale'):
        return 'status 取值非法: ' + repr(rec.get('status'))
    val = rec.get('value')
    if not isinstance(val, dict) or not val:
        return 'value 必须是非空对象'
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = 'EgoLinkServer/0.1'

    def log_message(self, fmt, *args):
        sys.stdout.write('[%s] %s\n' % (_now_iso(), fmt % args))
        sys.stdout.flush()

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text, code=200, ctype='text/plain; charset=utf-8'):
        body = text.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path.split('?')[0] != '/api/observations':
            return self._send_json({'error': 'not found'}, 404)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            raw = self.rfile.read(length)
            rec = json.loads(raw.decode('utf-8'))
        except Exception as exc:
            return self._send_json({'error': 'JSON 解析失败: ' + str(exc)}, 400)
        err = validate(rec)
        if err:
            self.log_message('拒绝观测记录: %s', err)
            return self._send_json({'error': err}, 422)
        rid = rec.get('record_id')
        if rid in _state['record_ids']:
            self.log_message('重复记录已忽略（幂等）: %s', rid)
            return self._send_json({'ok': True, 'duplicate': True,
                                    'record_id': rid}, 200)
        stored = dict(rec)
        stored['server_seq'] = _next_index()
        stored['received_at'] = _now_iso()
        stored['received_epoch'] = time.time()
        _append(stored)
        if rid:
            _state['record_ids'].add(rid)
        self.log_message('已存储 seq=%s record_id=%s |a|=%s', stored.get('seq'),
                         stored.get('record_id'), (stored.get('value') or {}).get('magnitude'))
        return self._send_json({'ok': True, 'server_seq': stored['server_seq'],
                                'received_at': stored['received_at'],
                                'record_id': stored.get('record_id')}, 201)

    def do_GET(self):
        path = self.path.split('?')[0]
        q = {}
        if '?' in self.path:
            for kv in self.path.split('?', 1)[1].split('&'):
                if '=' in kv:
                    k, v = kv.split('=', 1)
                    q[k] = v
        if path == '/api/health':
            return self._send_json({'ok': True, 'service': 'ego-link-server', 'week': 1,
                                    'stored_records': _count_lines(),
                                    'server_time': _now_iso(),
                                    'data_file': os.path.relpath(OBS_FILE, ROOT)})
        if path == '/api/observations':
            recs = _read_all()
            try:
                limit = min(int(q.get('limit', '50')), 500)
            except ValueError:
                limit = 50
            device = q.get('device_id')
            sensor = q.get('sensor')
            if device:
                recs = [r for r in recs if r.get('device_id') == device]
            if sensor:
                recs = [r for r in recs if r.get('sensor') == sensor]
            return self._send_json({'count': len(recs), 'returned': min(limit, len(recs)),
                                    'items': recs[-limit:]})
        if path == '/api/stats':
            recs = _read_all()
            if not recs:
                return self._send_json({'total': 0, 'devices': [], 'gap_s': None,
                                        'last_received_at': None, 'newest_age_s': None})
            last = recs[-1]
            devices = sorted({r.get('device_id', '?') for r in recs})
            epochs = [r.get('received_epoch') for r in recs if r.get('received_epoch')]
            gap = None
            if len(epochs) >= 2:
                gap = round(max(b - a for a, b in zip(epochs, epochs[1:])), 2)
            return self._send_json({'total': len(recs), 'devices': devices, 'gap_s': gap,
                                    'last_received_at': last.get('received_at'),
                                    'newest_age_s': round(time.time() - float(last.get('received_epoch') or 0), 1),
                                    'last_record_id': last.get('record_id'),
                                    'last_value': last.get('value'),
                                    'last_observed_at': last.get('observed_at'),
                                    'last_time_quality': last.get('time_quality'),
                                    'last_status': last.get('status')})
        rel = 'index.html' if path in ('/', '') else path.lstrip('/')
        target = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not target.startswith(WEB_DIR) or not os.path.isfile(target):
            return self._send_json({'error': 'not found', 'path': path}, 404)
        ctype = 'text/html; charset=utf-8'
        if target.endswith('.css'):
            ctype = 'text/css; charset=utf-8'
        elif target.endswith('.js'):
            ctype = 'application/javascript; charset=utf-8'
        with open(target, 'r', encoding='utf-8') as f:
            return self._send_text(f.read(), 200, ctype)


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    print('Ego Link 第 1 周服务端')
    print('  监听: http://%s:%d' % (HOST, PORT))
    print('  存储: %s' % OBS_FILE)
    print('  页面: http://<本机IP>:%d/' % PORT)
    n = _load_index()
    print('  已存记录: %d 条' % _count_lines())
    print('  去重索引: %d 个 record_id' % n)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
