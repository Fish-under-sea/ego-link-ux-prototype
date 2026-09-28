#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
一键切换板端 WiFi 配置（写入 app_config.local.h，该文件已被 .gitignore 忽略）

为什么需要它：
  板子换网络时，要改 SSID / 密码 / 服务器 IP 三个值，还要找到"板子能访问到的
  本机 IP"。手工改容易填错（尤其 Windows 移动热点的网关 IP 不是常见网段）。

用法：
    # 只写配置，看看选了哪个 IP
    python scripts/set_wifi.py --ssid "我的热点"

    # 指定服务器 IP（多网卡时用）
    python scripts/set_wifi.py --ssid "我的热点" --pass "12345678" --host 192.168.137.1

    # 写完直接编译 + 烧录
    python scripts/set_wifi.py --ssid "我的热点" --build --flash

提示：
  · 开放网络（无密码）把 --pass 省略或留空即可。
  · Windows 移动热点的网关地址通常是 192.168.137.1，但**板子要填的是电脑在该
    热点网段里的地址**——用本脚本不带 --host 运行会自动列出候选。
  · 板子不需要上外网，只要能访问运行 server.js 的电脑即可。
"""
import argparse
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_H = os.path.join(ROOT, 'firmware', 's3eye_imu_idf', 'main', 'app_config.local.h')
IDF_PY = r'C:\Espressif\python_env\idf5.4_py3.11_env\Scripts\python.exe'
IDFWRAP = os.path.join(ROOT, 'scripts', 'idfwrap.py')


def _decode(b):
    for enc in ('gbk', 'utf-8', 'latin-1'):
        try:
            return b.decode(enc)
        except Exception:
            pass
    return ''


VIRTUAL_HINTS = ('vEthernet', 'Hyper-V', 'WSL', 'Virtual', 'VMware',
                 'VirtualBox', 'Loopback', 'Bluetooth', 'TAP-', 'Npcap')


def local_ipv4(include_virtual=False):
    """返回 [(接口名, IPv4), ...]，跳过回环；默认也跳过 WSL/Hyper-V 等虚拟网卡。"""
    try:
        out = subprocess.run(['ipconfig'], capture_output=True).stdout
    except Exception as e:
        print('  读取 ipconfig 失败：%s' % e)
        return []
    ips, cur = [], '?'
    for line in _decode(out).splitlines():
        s = line.strip()
        if ('适配器' in s or 'adapter' in s.lower()) and s.endswith(':'):
            cur = s.rstrip(':')
        m = re.search(r'IPv4[^:]*:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)', s)
        if m and not m.group(1).startswith('127.'):
            if not include_virtual and any(h in cur for h in VIRTUAL_HINTS):
                continue
            ips.append((cur, m.group(1)))
    return ips


TEMPLATE = '''/* =====================================================================
 * 本地私密配置 —— 本文件已被 .gitignore 忽略，不会提交到仓库
 *
 * 由 scripts/set_wifi.py 自动生成，可放心重跑覆盖。
 * ===================================================================== */

#define APP_WIFI_SSID   "{ssid}"
#define APP_WIFI_PASS   "{password}"

#define APP_SERVER_HOST "{host}"
#define APP_SERVER_PORT {port}

#define APP_DEVICE_ID   "{device}"
'''


def main():
    ap = argparse.ArgumentParser(description='写入板端 WiFi 配置到 app_config.local.h')
    ap.add_argument('--ssid', required=True, help='WiFi 名称（ESP32-S3 仅支持 2.4GHz）')
    ap.add_argument('--pass', dest='password', default='', help='WiFi 密码；开放网络留空')
    ap.add_argument('--host', help='运行 server.js 的电脑 IP（不填则自动检测）')
    ap.add_argument('--port', default='8080', help='服务端端口，默认 8080')
    ap.add_argument('--device', default='S3EYE-GROUP01', help='设备标识，须与服务端 expectedDeviceId 一致')
    ap.add_argument('--all-ips', action='store_true', help='连虚拟网卡（WSL/Hyper-V）也一起列出')
    ap.add_argument('--build', action='store_true', help='写完顺便编译')
    ap.add_argument('--flash', action='store_true', help='写完顺便编译并烧录')
    args = ap.parse_args()

    host = args.host
    if not host:
        ips = local_ipv4(include_virtual=args.all_ips)
        if not ips:
            print('× 没找到可用的本机 IPv4，请用 --host 手动指定')
            return 2
        print('本机可用 IPv4：')
        for i, (name, ip) in enumerate(ips, 1):
            print('  %d) %-38s %s' % (i, name[:38], ip))
        if len(ips) == 1:
            host = ips[0][1]
            print('→ 只有一个地址，自动选用 %s' % host)
        else:
            print('\n× 有多个地址，请用 --host 指定「板子能访问到的那个」')
            print('  提示：板子连哪个网，就填电脑在那个网里的地址。')
            print('  例：python scripts/set_wifi.py --ssid "%s" --host <上面的某个IP>' % args.ssid)
            return 2

    if '\\' in args.ssid or '"' in args.ssid:
        print('× SSID 里不能有反斜杠或双引号')
        return 2
    if '"' in args.password:
        print('× 密码里不能有双引号')
        return 2

    with open(LOCAL_H, 'w', encoding='utf-8') as f:
        f.write(TEMPLATE.format(
            ssid=args.ssid, password=args.password,
            host=host, port=args.port, device=args.device))

    print('\n√ 已写入 %s' % os.path.relpath(LOCAL_H, ROOT))
    print('  SSID   = %s' % args.ssid)
    print('  密码   = %s' % ('(开放网络，空)' if not args.password else '(%d 个字符)' % len(args.password)))
    print('  服务器 = %s:%s' % (host, args.port))
    print('  设备   = %s' % args.device)

    if not (args.build or args.flash):
        print('\n下一步：npm run firmware:build   然后   npm run firmware:flash')
        print('（或加 --flash 让本脚本直接编译烧录）')
        return 0

    if not os.path.exists(IDF_PY):
        print('× 找不到 ESP-IDF 的 Python：%s' % IDF_PY)
        return 3
    cmd = [IDF_PY, IDFWRAP, 'flash' if args.flash else 'build', '-p', 'COM4'] \
        if args.flash else [IDF_PY, IDFWRAP, 'build']
    print('\n$ %s' % ' '.join(cmd))
    rc = subprocess.call(cmd, cwd=os.path.join(ROOT, 'firmware', 's3eye_imu_idf'))
    print('\n%s 退出码 %d' % ('√ 完成' if rc == 0 else '× 失败', rc))
    if rc == 0 and args.flash:
        print('提示：烧录后可用  npm run firmware:monitor  看开机扫描日志，')
        print('      确认目标 SSID 出现在 2.4GHz 列表里、且出现「WiFi 已连接，IP=…」。')
    return rc


if __name__ == '__main__':
    sys.exit(main())
