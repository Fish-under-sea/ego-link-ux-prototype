# 历史进度并入说明

- 并入日期：2026-09-28
- 来源：`imu-monitor-代码与经验-2026-09-28.zip`（原项目路径 `D:\workBUDDY\esp32\imu-monitor`，原 git `20484ff`，分支 master，累计 32 个提交，首个提交 2026-09-14）
- 并入方式：**原样保留目录结构**，统一放在 `prev/` 下，未做任何重排或改写

## 一、并入了什么

    prev/
    ├── 代码与经验总结.md          你的工程经验沉淀（7478 行代码的说明书）
    └── imu-monitor/               完整可运行工程（43 个受版本控制的文件）
        ├── server.js              Node 服务端：串口管理 + HTTP + WebSocket + NDJSON 落盘
        ├── public/                前端：原生 JS，零框架，实时曲线 + 分页路由
        ├── firmware/s3eye_imu_idf/ ESP-IDF 固件：IMU + 按键 + LED + LCD 中文 + 摄像头 MJPEG
        ├── docs/                  第 2 周 / 第 3 周文档（协议、状态图、时序图、实测记录）
        ├── scripts/               idfwrap.py（IDF 构建封装）、set_wifi.py（一键配网）
        └── test/                  9 个测试脚本，全套 110 项

## 二、覆盖的课程进度（对照课程标准）

| 周次 | 你的实现 | 证据文件 |
|---|---|---|
| 第 1 周 | 真实 IMU 采集 → WiFi 独立网络上报 → NDJSON 落盘 → 查询接口 → 网页展示；三态显示（实时/停采保留/离线清空）；`expectedDeviceId` 本组身份校验；停采保留旧时间 | `ASSIGNMENT.md` §0 逐条对照、README 二/三节 |
| 第 2 周 | 远程采集指令闭环：`request_id` 回环 + 板端 seq 递增 + 时间先后 + 页面只认 id；状态机 submitted→dispatched→acked→completed/timeout/failed；暂停周期上报时命令通道独立保持 | `docs/week2-remote-collect.md` |
| 第 3 周 | 教学求助闭环：板载按键（ADC GPIO1）→ 本地 LED/屏幕即时反馈 → 远端显示 → 查看者回应；断网时本地仍确认；无远端证据不显示「对方已收到」 | `docs/week3-button-feedback.md`、`docs/week3-flash-evidence.txt` |
| 扩展 | 板载 OV2640 摄像头实时画面（MJPEG）+ 单张抓拍；WiFi 下行命令轮询通道（拔掉 USB 仍可下发） | README 六之三/六之五/§11 |

## 三、仓库里现在有两套实现，关系要说清

本仓库是**同一个课程工程按周演进**的载体，目前并存两条技术栈：

| 维度 | `prev/imu-monitor`（你的历史进度） | `board/` + `server/` + `web/`（本次新建） |
|---|---|---|
| 板端 | ESP-IDF 工程（`main.c` 1452 行，含摄像头/LCD/按键） | PlatformIO + Arduino（`main.cpp`，IMU 采集与上传） |
| 服务端 | Node.js（`server.js` 1927 行，串口 + WiFi 双通道、WebSocket） | Python 标准库（`app.py`，HTTP 指令队列） |
| 前端 | 原生 JS 单页多分页（曲线、历史、求助、摄像头） | 单页监控面板 |
| 覆盖周次 | 第 1—3 周 + 摄像头扩展 | 第 1 周（已验收提交）、第 2 周（进行中） |
| 测试 | 110 项（`test/*.js`） | 当堂验证脚本（`docs/week-01-验收记录.md`） |
| 本机可构建 | ❌ ESP-IDF 未安装且工具链源被墙 | ✅ PlatformIO 已装通并成功烧录 |

**这不是"两个项目"，而是同一门课的两种实现路径**，建议后续明确以哪条为主线，避免证据重复与口径不一。

## 四、本次实测发现的一处硬件出入（建议核对）

你的文档与固件把板载 IMU 记为 **QMA7981**。本次用板子直接实测，读到的是：

- `WHO_AM_I`（寄存器 0x00）= **0x90**
- I2C 地址 = **0x12**，SDA = GPIO4，SCL = GPIO5
- 静止合矢量 ≈ **0.95 g**，三轴读数稳定

按乐鑫官方驱动 `esp-bsp/components/qma6100p` 的常量定义：`QMA6100P_WHO_AM_I_VAL = 0x90`、`QMA6100P_I2C_ADDRESS = 0x12`。因此本板实际器件应为 **QMA6100P**（两者寄存器布局相近，故驱动能跑通、量程也一致为 ±2g / 4096 LSB/g，问题不影响功能，只影响文档准确性与答辩时的器件陈述）。

顺带一处细节：你的固件解析为 `(int16_t)((HIGH << 8) + LOW) / 4`——这与官方驱动一致；本次我一开始写成对 12 位做算术右移 4 位，导致合矢量只有 0.236 g，已按官方实现修正。

**建议**：把 `prev/imu-monitor` 里的 QMA7981 表述统一改为 QMA6100P（或至少加注），并在下一版固件注释中记录实测的 WHO_AM_I 值与合矢量基线。

## 五、并入后的验证状态

| 项目 | 状态 |
|---|---|
| 文件完整性 | 44 个文件全部纳入版本控制（`git ls-files prev/ | wc -l` = 44） |
| 凭据安全 | `app_config.h` 中为占位符（`YOUR_WIFI_SSID` / `YOUR_WIFI_PASSWORD`），真实凭据在你本地被忽略的 `app_config.local.h` 中，**未入库** |
| 忽略规则冲突 | 已修复：顶层 `.gitignore` 原有的 `*.log`、`*.map`、`build/` 会误伤子项目文件，已改为目录限定（`server/*.log`、`board/build/` 等） |
| Node 服务端 | 未在本机运行验证（需 `npm install`，依赖 `serialport`/`ws`） |
| ESP-IDF 固件 | 未在本机重新编译（本机无 ESP-IDF 工具链） |
