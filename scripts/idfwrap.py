#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ESP-IDF 调用包装器（用于在 MSYS/Git Bash 等环境下正确运行 idf.py）

背景：在 Git Bash(MSYS) 里直接跑 ESP-IDF 的 Windows Python 会出两个问题：
  1) 'MSYSTEM' 环境变量让 idf.py 判定为 MSYS 环境（仅警告，不致命）；
  2) PROCESSOR_ARCHITECTURE 为空 -> platform.machine() 返回 '' ->
     平台串变成 'Windows-'，idf_tools.py 报 "Support for platform 'Windows-' ..."。
本脚本在 Python 进程内修正这两点，再应用 idf_tools.py export 的环境变量，最后运行 idf.py。

用法：
    python scripts/idfwrap.py --version
    python scripts/idfwrap.py -p COM4 flash monitor
"""
import os
import sys
import subprocess
import runpy

IDF_PATH = os.environ.get('IDF_PATH', r'C:\Espressif\frameworks\esp-idf-v5.4.4')
IDF_TOOLS_PATH = os.environ.get('IDF_TOOLS_PATH', r'C:\Espressif')
PY = os.environ.get(
    'IDF_PYTHON',
    r'C:\Espressif\python_env\idf5.4_py3.11_env\Scripts\python.exe',
)


def fix_env():
    # 1) 去掉 MSYS 痕迹
    for k in list(os.environ):
        if k.startswith('MSYSTEM') or k.startswith('MINGW') or k.startswith('MSYS'):
            os.environ.pop(k, None)
    # 2) 补上 PROCESSOR_ARCHITECTURE（MSYS 下常为空）
    if not os.environ.get('PROCESSOR_ARCHITECTURE'):
        os.environ['PROCESSOR_ARCHITECTURE'] = 'AMD64'
    os.environ['IDF_PATH'] = IDF_PATH
    os.environ['IDF_TOOLS_PATH'] = IDF_TOOLS_PATH
    os.environ.pop('PYTHONPATH', None)
    os.environ.pop('PYTHONHOME', None)
    os.environ['PYTHONNOUSERSITE'] = 'True'


def apply_idf_env():
    """调用 idf_tools.py export 拿到 PATH/IDF_PYTHON_ENV_PATH 等并写入当前进程环境。"""
    script = os.path.join(IDF_PATH, 'tools', 'idf_tools.py')
    try:
        out = subprocess.check_output(
            [PY, script, 'export', '--format', 'key-value'],
            text=True, env=dict(os.environ),
        )
    except subprocess.CalledProcessError as e:
        sys.stderr.write('idf_tools.py export 失败: %s\n' % e)
        return
    for line in out.splitlines():
        if '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ[k.strip()] = v.strip()


def main():
    fix_env()
    apply_idf_env()
    tools_dir = os.path.join(IDF_PATH, 'tools')
    # runpy 不会像直接执行脚本那样把脚本目录放进 sys.path，需手动补齐
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    sys.argv = ['idf.py'] + sys.argv[1:]
    runpy.run_path(os.path.join(tools_dir, 'idf.py'), run_name='__main__')


if __name__ == '__main__':
    main()
