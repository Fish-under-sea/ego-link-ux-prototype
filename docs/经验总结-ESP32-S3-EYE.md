# ESP32-S3-EYE 三轴 IMU 实时监控平台 —— 代码目录与工程经验总结

> **生成日期**：2026-09-28
> **对应代码版本**：git `20484ff`（分支 `master`，累计 32 个提交，首个提交 2026-09-14）
> **原始项目路径**：`D:\workBUDDY\esp32\imu-monitor`
> **本文档用途**：交付/存档用的"代码目录说明书 + 工程经验沉淀"。配套压缩包里含完整可运行源码。

---

## 0. 怎么读这份文档

| 你想知道 | 直接跳到 |
|---|---|
| 这东西到底是干什么的 | §1 项目概览 |
| 哪个文件负责什么功能 | §2 代码目录详解 |
| 怎么把它跑起来 | §3 运行与构建 |
| 硬件有哪些坑、别把板子烧了 | §4 硬件要点与致命坑 |
| **踩过哪些坑、怎么排查的** | §5 工程经验（本文档最核心） |
| 正常时应该是什么数值 | §6 实测基线数据 |
| 还有哪些没做完 | §7 已知限制与未完成项 |
| 出问题了从哪查 | §8 排障速查表 |

**一句话前提**：本平台**只显示真实硬件数据**，不生成任何模拟/占位数据。拔掉设备页面立刻进入"无数据"状态。这是设计红线，也是所有取舍的出发点。

---

## 1. 项目概览

### 1.1 一句话定位

把 **ESP32-S3-EYE** 板载 **QMA6100P 三轴加速度计**的真实数据，经 **WiFi 独立网络**（USB 仅用于调试）上报到**本机自建的 Node.js 服务端**，落盘存储，并在网页上**实时**显示姿态、趋势曲线、原始记录，另附远程采集指令、教学求助闭环、板载摄像头直播等扩展功能。

### 1.2 数据链路

```
┌──────────────────────────────┐
│  ESP32-S3-EYE (ESP32-S3R8)   │
│  ├ QMA6100P 三轴加速度计 I2C   │   ← 真实传感源
│  ├ OV2640 摄像头 (DVP)        │
│  ├ ST7789 240×240 LCD (SPI)   │   ← 本地反馈
│  ├ ADC 按键 ×6 + BOOT         │
│  └ LED (GPIO3, 开漏)          │
│                              │
│  主循环 100ms：读 IMU → 组帧   │
└───────┬──────────────┬───────┘
        │              │
   USB 串口         WiFi (2.4GHz)
   (调试用)         (★ 主用，独立网络)
        │              │
        │  JSON 行     │  POST /api/data
        │              │  GET  /api/cmd  ← 下行命令轮询(400ms)
        └──────┬───────┘
               ▼
┌──────────────────────────────────────┐
│  Node.js 服务端  server.js            │
│  （本机即服务器，无 VPS）              │
│  ├ 串口管理 / 自动识别(VID 打分)       │
│  ├ JSON 解析 + 字段抽取 + 元数据       │
│  ├ 双通道去重（串口优先 + seq 兜底）   │
│  ├ NDJSON 落盘 data/records.ndjson    │
│  ├ HTTP API + WebSocket 推送          │
│  └ 命令下发（串口优先 / WiFi 队列）    │
└───────┬──────────────────────────────┘
        │  HTTP :8080  +  WS /ws
        ▼
┌──────────────────────────────────────┐
│  浏览器（原生 JS，零前端框架）          │
│  #live 实时监控 / #collect 远程采集    │
│  #help 教学求助 / #records 记录与设备  │
└──────────────────────────────────────┘
```

### 1.3 三方分工（作业要求）

| 角色 | 职责 |
|---|---|
| **开发板** | 采集真实三轴数据 → 组 JSON 帧 → 主动上报（HTTP 客户端，**不开 HTTP 服务**） |
| **服务端（本机）** | 接收 / 校验 / 去重 / 落盘 / 查询 / 转发 / 命令下发 |
| **浏览器** | 实时显示 + 历史查询 + 操作入口；**只认服务端推送，不自行造数** |

### 1.4 硬件清单

| 项 | 型号/规格 |
|---|---|
| 开发板 | **ESP32-S3-EYE v2.2**（主板 MB v2.2 + 子板 SUB_V1.1） |
| 主控 | ESP32-S3R8（8MB Flash + **8MB Octal PSRAM**） |
| IMU | **QMA6100P** 三轴加速度计，I2C 地址 `0x12` |
| 摄像头 | OV2640（200 万像素，DVP 并口） |
| 屏幕 | 1.3 寸 240×240 ST7789（SPI3） |
| 麦克风 | 数字 MEMS 麦克风（I2S），**无扬声器/蜂鸣器** |
| USB | ESP32-S3 内置 USB-Serial-JTAG（**无桥接芯片**，VID `303A` PID `1001`） |

### 1.5 代码规模

| 部分 | 文件 | 行数 |
|---|---|---|
| 服务端 | `server.js` | 1927 |
| 前端 | `public/app.js` | 1476 |
| 前端 | `public/index.html` | 381 |
| 前端 | `public/style.css` | 452 |
| 固件 | `firmware/s3eye_imu_idf/main/main.c` | 1452 |
| 固件 | `firmware/s3eye_imu_idf/main/cam_stream.c` | 187 |
| 固件 | `firmware/s3eye_imu_idf/main/app_config.h` | 66 |
| 固件 | `firmware/s3eye_imu_idf/main/lcd_font.h` | 675（自动生成，勿手改） |
| 测试 | `test/*.js`（9 个脚本） | ~1100 |
| **合计（.c/.h/.js/.py/.ino）** | — | **约 7478 行** |

---

## 2. 代码目录详解

### 2.1 完整目录树

> 下列为 `git archive` 导出的 **43 个受版本控制的文件**，即"干净可运行源码"的完整边界。
> 运行时才产生的目录（`data/` `recordings/`）与构建产物（`build/` `node_modules/`）**不在包内**。

```
imu-monitor/
├── server.js                       ★ 后端全部逻辑（单文件，1927 行）
├── config.json                     ★ 服务端配置（端口/超时/字段映射/设备校验）
├── package.json                    启动与固件构建脚本入口
├── package-lock.json
├── start.bat                       一键启动（双击即可，动态查找 node）
├── .gitignore                      排除构建产物 / 依赖 / 运行时数据 / 私密配置
├── README.md                       运行·接线·验证说明（27KB，最完整的功能文档）
├── ASSIGNMENT.md                   课程作业提交说明（41KB，教师要求逐条对照）
│
├── scripts/
│   ├── idfwrap.py                  ESP-IDF 构建/烧录封装（自动注入工具链环境）
│   └── set_wifi.py                 一键切换板端 WiFi 配置（自动探测本机 IP）
│
├── docs/
│   ├── week2-remote-collect.md     第 2 周：远程采集协议 + mermaid 状态图/时序图 + 实测
│   ├── week3-button-feedback.md    第 3 周：按键与物理反馈闭环（协议/状态图/实测）
│   ├── week3-flash-evidence.txt    第 3 周烧录与现场取证流程
│   └── help-page.png               求助页截图存档
│
├── public/                         ★ 前端（原生 JS，零依赖零框架）
│   ├── index.html                  页面骨架（hash 路由：4 个分页 + 常驻外壳）
│   ├── style.css
│   └── app.js                      WebSocket 接收 / 卡片渲染 / Canvas 曲线 / 分页路由
│
├── firmware/
│   ├── s3eye_imu_idf/              ★ 当前使用：ESP-IDF 工程
│   │   ├── CMakeLists.txt
│   │   ├── sdkconfig               实际构建配置（已提交，保证可复现）
│   │   ├── sdkconfig.defaults      默认配置（分区表 1.5MB / PSRAM Octal 等）
│   │   ├── tools/
│   │   │   ├── gen_font.py         LCD 点阵字模生成（→ lcd_font.h + 预览图）
│   │   │   └── font_preview.png
│   │   └── main/
│   │       ├── main.c              ★ 主程序：IMU/组帧/上报/按键/LED/LCD/命令处理
│   │       ├── cam_stream.c        摄像头抓帧与 JPEG→base64 编码
│   │       ├── cam_stream.h
│   │       ├── app_config.h        配置入口（自动 include 本地私密文件）
│   │       ├── app_config.local.h.example  ← 私密配置模板（复制为 .local.h 填真实值）
│   │       ├── lcd_font.h          点阵字模（自动生成：中文 32×32 × 25 字 + ASCII 8×16）
│   │       ├── CMakeLists.txt      ★ 显式列出源文件（新增 .c 必须手动加）
│   │       └── idf_component.yml   组件依赖（esp32-camera 等）
│   ├── s3eye_imu_wifi/s3eye_imu_wifi.ino   （旧）Arduino 版草稿，留档
│   ├── esp32_monitor_wifi.ino              （旧）Arduino 通用 WiFi 草稿，留档
│   └── esp32_monitor.ino                   （旧）Arduino USB 串口草稿，留档
│
└── test/                           自检脚本（共 110 项断言，全通过）
    ├── acceptance-test.js          全链路验收（隔离端口 8096）
    ├── e2e-test.js                 链路自检（空状态/上报/停采/断开）
    ├── verify-test.js              本组身份校验（隔离端口 8095）
    ├── feature-test.js             诊断接口 / 录制导出 / CSV
    ├── parse-test.js               通用解析：JSON / 键值 / 中文键
    ├── storage-test.js             持久化 + 查询 + 停采保留
    ├── ws-test.js                  WebSocket sample/stale/cleared 推送结构
    ├── help-test.js                第 3 周求助闭环（26 项）
    ├── listen.js COM4 25           原样监听串口 N 秒（看板子在发什么）
    └── .test-config.json           测试夹具（★ 必须提交，见 §5.6）
```

### 2.2 关键文件职责

#### `server.js`（后端核心，1927 行）

单文件承载全部后端逻辑，**不依赖 Express**（只用内置 `http` + `serialport` + `ws` 三个依赖）。

| 模块 | 说明 |
|---|---|
| 串口管理 | 自动扫描 + 按 VID 打分：Espressif(`303a`) > CP210x(`10c4`) > CH34x(`1a86`) > FTDI(`0403`） |
| 解析链路 | 行缓冲 → JSON / 键值 / CSV 三种模式 → 只保留数值字段 → 抽取元数据 |
| 元数据 | `device`/`mac` → 身份；`ts`/`iso` → 板端时间；`seq` → 序号（**不画成传感器卡片**） |
| 双通道去重 | 「串口优先」规则 + `(device, seq)` 5 秒窗口兜底（见 §5.4） |
| 落盘 | `data/records.ndjson`，一帧观测一条；超 `storageMaxMb` 自动滚动归档 |
| 状态三态 | `live` 实时 / `stale` 停采保留（末值+旧时间+未更新徽章）/ `cleared` 清空 |
| 命令下发 | 串口优先，不可用时入 WiFi 队列（15s TTL），板端 400ms 轮询取走 |
| 请求状态机 | 远程采集 `REQUESTS` Map：已提交→已下发→设备已接收→完成/失败/超时 |

#### `public/app.js`（前端核心，1476 行）

- **零框架**：原生 DOM + Canvas 手绘曲线，字段由数据驱动动态生成卡片
- **hash 路由分页**：`#live` / `#collect` / `#help` / `#records`，刷新停在当前页
- **曲线绘制要点**：固定窗口 100 点（约 10 秒）、滑动平均 9 点、二次贝塞尔平滑、
  去直流（AC 耦合）、固定量程/自动量程切换、暂停冻结
- 包在 IIFE 里（外部读不到内部变量，调试时需注意，见 §5.5）

#### `firmware/s3eye_imu_idf/main/main.c`（固件核心，1452 行）

| 子系统 | 要点 |
|---|---|
| IMU | QMA6100P，I2C `0x12`，X=`0x01`/Y=`0x03`/Z=`0x05`，量程寄存器 `0x0F`，14bit 左对齐 |
| 组帧上报 | 100ms 周期；USB-Serial-JTAG `printf` 与 WiFi `POST /api/data` 双通道 |
| 命令任务 | `fgets(stdin)` 阻塞读行 → `handle_command()`（与 WiFi 轮询**共用同一函数**） |
| 按键 | ADC 电阻分压 → GPIO1，上电自适应校准 + 去抖 |
| LED | GPIO3，**开漏模式**（快闪/慢闪） |
| LCD | ST7789 SPI3，显示求助状态等本地反馈 |
| 摄像头 | `cam_task` 推流 + `cam_take_snapshot()` 抓拍（`s_cam_mtx` 互斥锁串行化） |

### 2.3 协议一览

#### 上行数据帧（板端 → 服务端）

```jsonc
{
  "device": "S3EYE-GROUP01",
  "mac": "94A9901C70D0",
  "seq": 1771,
  "ts": 1790562579162,          // 板端时间（NTP 对时后才有）
  "iso": "2026-09-28T02:29:39.162Z",
  "acc_x_raw": -23, "acc_y_raw": 12, "acc_z_raw": 8191,
  "acc_x_g": -0.0056, "acc_y_g": 0.0029, "acc_z_g": 2.0,
  "acc_x_ms2": -0.055, "acc_y_ms2": 0.028, "acc_z_ms2": 19.6,
  "temp_c": 38.0, "rssi": -52, "heap": 123456,
  "upload_ok": 1771, "upload_fail": 248
}
```

落盘后的一条记录（`data/records.ndjson`）：

```jsonc
{"seq":1,"recv_ts":1790562579169,"recv_iso":"2026-09-28T02:29:39.169Z",
 "device_id":"S3EYE-GROUP01","device_mac":"...","transport":"wifi","src_ip":"...",
 "board_ts":1790562579162,"board_iso":null,"skew_ms":-7,
 "fields":{"acc_x_raw":-23,"acc_x_g":-0.0056, ...}}
```

> `skew_ms` = 板端时间 − 服务端接收时间，用于**当堂时间核对**。
> 一帧观测 = 一条记录（作业硬要求）。

#### 下行命令（服务端 → 板端，每行一条 JSON）

| 命令 | 作用 | 回执 status |
|---|---|---|
| `collect_once` | 立即采集一帧（带 `request_id`） | `received` |
| `pause` / `resume` | 暂停/恢复周期上报（命令通道保持） | `paused` / `resumed` |
| `ping` | 心跳 | `pong` |
| `viewer_ack` | 查看者已收到求助 | `ack_shown` / `no_active_help` |
| `help_cancel` / `help_reset` | 取消求助 / 复位 | `cancelled` / `idle` |
| `cam_on` / `cam_off` | 开启/关闭推流 | `cam_on` / `cam_off` / `no_camera` |
| `cam_shot` | 抓拍一张高分辨率快照 | `shot`（**仅表示命令收到，不代表抓拍成功**） |
| `cam_set` | 设置分辨率/质量 | 参数串 / `no_camera` |
| `cam_status` | 查询摄像头状态 | 状态串 |
| `wifi_status` / `wifi_scan` | 板端自带 WiFi 诊断（无需重烧固件） | 状态串 / `scanning` |

#### HTTP API（节选，完整表见 `README.md` §六）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 当前连接状态与最新字段 |
| GET | `/api/diag` | 诊断：串口列表、开关、字节数、报文统计、排查建议 |
| POST | `/api/data` | **WiFi 上报入口** |
| GET | `/api/records` | 查询落盘记录（device/limit/since/until） |
| GET | `/api/records.csv` | 导出 CSV（带 BOM，Excel 直开） |
| POST | `/api/collect` | 创建远程采集请求 |
| POST | `/api/help` | 求助回应 `ack` / `cancel` / `reset` |
| GET | `/api/cmd?device=` | **下行命令轮询（WiFi 通道）** |
| GET | `/api/cam.mjpg` | 摄像头 MJPEG 实时流 |
| WS | `/ws` | 推送 `sample`/`status`/`raw`/`cleared`/`stale`/`hello`/`collect`/`help` |

---

## 3. 运行与构建

### 3.1 环境要求

| 项 | 要求 |
|---|---|
| Node.js | 18+（实测 v22.22.2） |
| ESP-IDF | **v5.4.4**（实测路径 `C:\Espressif`） |
| Python（IDF 用） | venv 为 `idf5.4_py3.11_env` |
| 依赖包 | 仅 `serialport@^13` + `ws@^8`（无 Express） |

### 3.2 启动平台

```bash
cd D:\workBUDDY\esp32\imu-monitor
npm install            # 首次
npm start              # 或双击 start.bat
# 浏览器打开 http://localhost:8080
```

局域网访问（开发板上报用）：`http://<本机IP>:8080`，服务端默认 `host=0.0.0.0`。

### 3.3 编译与烧录固件

> ★ **首选项目自带入口**，已封装好工具链环境问题，实测可用：

```bash
npm run firmware:build     # 编译
npm run firmware:flash     # 烧录（默认 COM4）
npm run firmware:monitor   # 串口监视
npm run wifi:set -- --ssid "你的2.4G热点" --pass "密码"   # 一键改 WiFi 配置
```

### 3.4 切换板端 WiFi 配置

```bash
npm run wifi:set -- --ssid "431" --pass "88888888"
```

`scripts/set_wifi.py` 会**自动探测本机局域网 IP** 并写入
`firmware/s3eye_imu_idf/main/app_config.local.h`（该文件被 `.gitignore` 忽略，**不会提交**）。

### 3.5 自检

```bash
npm test                   # 全链路验收
npm run test:help          # 求助闭环（26 项）

# 以下脚本自带服务、用独立端口，无需先启动 npm start
node test/acceptance-test.js   # 12 项
node test/help-test.js         # 26 项
node test/storage-test.js      # 19 项
node test/ws-test.js           # 9 项
node test/verify-test.js       # 6 项
node test/parse-test.js        # 10 项
node test/feature-test.js      # 14 项
E2E_PORT=8081 node test/e2e-test.js   # 14 项（隔离模式）
```

**合计 110 项，当前全部通过。**

---

## 4. 硬件要点与致命坑

### 4.1 ESP32-S3-EYE v2.2 引脚分配

| 外设 | 引脚 |
|---|---|
| LED（唯一一颗） | **GPIO3** —— 必须**开漏模式**，拉高会烧毁 |
| 按键 ×6 | ADC 电阻分压网络 → **GPIO1**（ADC1_CH0），阈值 2410/1980/820/380 |
| BOOT 键 | GPIO0 |
| LCD ST7789 | PCLK=21 / DATA=47 / DC=43 / CS=44 / BL=48 |
| 摄像头 OV2640 | XCLK=15 / PCLK=13 / VSYNC=6 / HREF=7，D0–D7 = 11,9,8,10,12,18,17,16 |
| 摄像头 PWDN/RESET | **未连接 → 必须填 `-1`** |
| IMU QMA6100P | I2C，SDA=4 / SCL=5，地址 `0x12` |

### 4.2 三个会"烧板子/搞坏屏幕"的坑

| # | 坑 | 后果 | 正解 |
|---|---|---|---|
| 1 | LED 当普通推挽输出用 | **烧毁 GPIO3** | 必须开漏（`OpenDrain: 1`） |
| 2 | 照抄 esp32-camera 测试文件的 `PWDN=43 / RESET=44` | **撞 LCD 的 DC/CS，屏幕坏** | S3-EYE 上这两个引脚未连接，填 `-1` |
| 3 | PSRAM 模式配成 Quad | 8MB PSRAM 用不了 | 必须 `CONFIG_SPIRAM_MODE_OCT=y`（S3R8 是 Octal） |

### 4.3 分区表

加摄像头组件后固件从 ~913KB 涨到 **1.04MB**，默认 `single-app` 只给 1MB →
`app partition is too small`。
已在 `sdkconfig.defaults` 改为 `CONFIG_PARTITION_TABLE_SINGLE_APP_LARGE=y`（1.5MB）。

### 4.4 跑飞了怎么救

S3-EYE **无 USB-UART 桥接芯片**，恢复方法：

```
按住 BOOT → 按一下 RST → 松开 RST → 再松开 BOOT
→ 进入 Firmware Download 模式，可重新烧录
```

> ⚠️ 烧录会**覆盖出厂固件**（ESP-IDF + ESP-WHO 人脸检测/语音唤醒）。这是不可逆操作，
> 动手前必须知情。

---

## 5. 工程经验（核心章节）

### 5.1 方法论：先核实，再动手

这是本项目最贵的一条经验，用**四次真实翻车**换来的。

**规则**：凡是要下结论的地方 —— 原因推断、性能断言、数据解读、硬件/库假设、方案选择 ——
都要先核实。核实手段按成本从低到高，选够用的那档：

1. **读源头** —— 代码、头文件、官方文档、器件手册。不靠记忆，不靠网上二手资料
2. **量一次** —— 真跑一遍、打点计时、数一遍
3. **做对照** —— 只改一个变量做 A/B。单次测量会被噪声带偏
4. **复测** —— 同一条件再来一次，看结果稳不稳

**什么时候可以先做后说**：纯粹的格式转换、明确的机械操作；或者核实本身必须先执行一下
才知道的情况 —— 此时要**说明"这是试探"，不要伪装成结论**。

#### 四次翻车实录

| # | 我的错误结论 | 怎么发现的 | 真相 |
|---|---|---|---|
| 1 | "板端每帧新建 HTTP 连接是性能瓶颈，应该开 keep-alive" | 用户追问"能提升什么"，去测量 | 实测帧间隔中位数 **108ms ≈ 100ms 目标周期** → 单帧开销根本不是瓶颈，优化毫无必要 |
| 2 | "IMU 速率只有 6.2 条/秒" | 做对照实验 + 复测 | 实测 **7.1~8.0 条/秒**；6.2 和 2.2 都是瞬态拥塞下的单次测量 |
| 3 | "优化把曲线改坏了"（图表显示"等待设备数据"） | 换掉无头浏览器虚拟时钟 | `--virtual-time-budget` 让虚拟时钟跑得比 WebSocket 真实到达快 → **假象** |
| 4 | "串口优先规则已经足够，双通道不会重复" | 服务重启后重复率飙到 47% | 单通道测出的结论**不能**推广到双通道（详见 §5.4） |

**两条可复用的教训**：
- **先量再改，先读再断言**。不要从"实现方式"倒推"性能瓶颈" —— 那是猜。
- 发现自己的旧结论错了，要**主动纠正**（改文档、改记忆），不要让它留着误导人。
  本项目为此专门提交过两次文档纠错（`87f8c46`、`7d229fa`）。

### 5.2 硬件 / 驱动类踩坑

| 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|
| **IMU WHO_AM_I 不匹配** | 三轴数据整个缺失 | 板载 QMA6100P 读到 ID `0x90`，非资料里的 `0xE7` | 放宽 ID 校验 + 加诊断字段 |
| **QMA6100P 灵敏度偏高 31%** | 静止 \|a\| = 1.32g（应 ≈1.0g） | 该批传感器灵敏度高于标准 4096 LSB/g | 加 `QMA_CALIBRATION = 0.765f` + 显式设量程寄存器 `0x0F` → 校准后 1.0014g（偏差 0.1%） |
| **静止 \|a\| 随朝向变化 0.93~1.01g** | 看着像漂移 | 零偏（zero-g offset）与朝向相关，非漂移 | 彻底修需 6 面标定；用户明确不需要 → 保留现状，显示层用前端「水平归零」按钮解决 |
| **I2C 驱动冲突** | 摄像头初始化失败 | IMU 用新版 `i2c_master` 驱动，esp32-camera 的 `sccb.c` 用旧版 `driver/i2c.h`，两套不能同装一个端口 | IDF≥5.4 会编译 `sccb-ng.c`（走新版驱动），并支持 `pin_sccb_sda=-1 + sccb_i2c_port=N` **复用已有总线** |
| **符号冲突** | 报 `cam_hal: cam_init(538): config pointer is invalid`（指针看着非空却报 NULL） | 本模块 `cam_init`/`cam_deinit` 与 esp32-camera 导出的同名公开符号撞车 | 全部加 `cam_stream_` 前缀 |
| **`framesize_t` 索引表照抄网络资料** | 请求 QVGA 却得到 240x240 | esp32-camera ^2.0.0 在 3 处插入 `QCIF`、7 处插入 `320X320`，索引整体后移，网上流传的是旧表 | **直接读组件头文件** `driver/include/sensor.h`；实测对照：5→240x240、6→320x240、8→400x296、10→640x480 |
| **`set_framesize()` 后 `sensor->status` 说谎** | 上报 320x240，实际输出 240x240 | 驱动状态字段不可信 | 服务端改为**直接解析 JPEG 头（SOF0）拿真实尺寸**，不信上报值 |
| **`cam_stream_set_params()` 忽略返回值** | 日志打印"参数已更新：640x480"但切换可能失败 | 未检查 `set_framesize()` 返回值 | 日志不能当成功证据，要另找判据 |
| **连续抓拍第 2 次起卡死** | 首次正常，之后 `snapshotAt` 不再变化 | 推流任务与抓拍命令**并发访问摄像头**，帧缓冲是单份全局状态；`cam_stream_capture()` 开头会 `cam_stream_release()` 把对方正在用的缓冲提前归还 | 新增互斥锁 `s_cam_mtx` 串行化所有摄像头访问 |
| **抓拍高分辨率静默失败** | 命令"已下发"但永远等不到新帧 | base64 缓冲内存分配不足；`cam_send_frame_locked()` 有 4 条 `return 0` 路径，其中 3 条**完全没有日志** | 改用 `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` + 失败回退；三条静默路径全补 `ESP_LOGE`；抓拍改返回 int + 最多重试 3 次 |

> **抓拍失败率随内存需求单调上升** —— 这是定位的关键证据：
> QVGA(6) 3/3 成功、CIF(8) 3/3、VGA(10) 1/3、SVGA(11) 0/3。

### 5.3 固件编译环境类踩坑

| 坑 | 解法 |
|---|---|
| `export.ps1` 默认找 py3.13，实际 venv 是 `idf5.4_py3.11_env` | 显式设 `IDF_PYTHON_ENV_PATH` |
| PowerShell 脚本执行策略拦路 | `Set-ExecutionPolicy -Scope Process Bypass -Force` |
| `CreateProcess failed`（ninja 拉不起 ccache） | `idf.py -DCCACHE_ENABLE=0 reconfigure`（**沙箱环境特有**，正常终端不受影响） |
| 重新生成 sdkconfig 后 ccache 又被启用 | 同上，再关一次 |
| 给 main 组件加 `REQUIRES` | **千万别加** —— 会覆盖默认依赖，导致 `esp_timer.h` 找不到 |
| `main/CMakeLists.txt` 是显式列源文件（非 GLOB） | 新增 `.c` **必须手动加进去**，否则静默不编译 |
| 编译必须在**前台**执行 | 后台任务会被沙箱拦住子进程（gcc 无法 spawn） |

> ★ **纠错**：早期我记录"必须关闭 ccache"，后来发现那只适用于**手工 PowerShell export** 的路径。
> 用项目自带的 `npm run firmware:build`（底层 `scripts/idfwrap.py`）时 ccache 完全正常。
> **首选项目自带入口**。

### 5.4 服务端 / 协议类踩坑

#### ★ 最隐蔽的一个：串口数据被误标为 wifi，同一帧记录两次

**现象**：USB 与 WiFi 同时在线（调试常态）时，`/api/diag` 显示 228 行里 **107 行重复（约 47%）**。

**根因**：串口读取处调用 `handleLine` 时**没声明来源**：

```js
handleLine(line.replace(/\r$/, ''));   // ← 缺 source
```

而内部是 `const transport = (source && source.transport) || state.transport || 'serial';`
→ 串口帧继承了 `state.transport`，而 `/api/data`（WiFi 入口）会先把它设成 `'wifi'`：

1. 串口数据来源字段被标错
2. 更致命：「串口优先」规则的判据 `state.transport === 'serial'` **永远不成立**，
   WiFi 副本再也不会被忽略 → 同一帧进两次

**为什么"时好时坏"**：取决于服务启动时哪一路先到。
串口先到 → 规则生效无重复；WiFi 先到 → `transport` 被钉死在 `'wifi'` → 持续重复。

**修复**：串口读取处显式传 `{ transport: 'serial' }`；
另加 `isDuplicateFrame()` 按不可变的 `(device, seq)` 在 5 秒窗口内去重，与 `state.transport` 无关。

**教训**：
- `state.transport` 这种**共享可变标志当判据非常脆弱**
- **单通道测出的结论不能推广到双通道**（我最初的 A/B 测试恰好撞上"串口先到"的良性分支，
  得出"规则已足够"的错误结论，直到服务重启才暴露）

#### 其他服务端坑

| 坑 | 根因 | 解法 |
|---|---|---|
| 曲线下拉框被假字段 `SDA` 占据 | 固件有 7 处含 `=` 的日志行（`扫描 I2C 总线 (SDA=4 SCL=5)` 等）被键值解析器**误当成传感器字段** | `handleLine` 开头加 ESP-IDF 日志行拦截 `/^[IWEDV] \(\d+\)/` → 只进原始日志 |
| 正则误吃时间 | `(-?\d+)(?!\s*:\d)` 被 `Time: 12:34:56` 绕过（回溯成只吃 `1`） | 补 `(?![\d.])` 保证数字完整匹配 |
| 静态路由吞掉 API | `^\/[A-Za-z0-9._\-/]*$` 会匹配 `/api/*` | API 路由必须放在静态之前 |
| 环境变量污染持久化配置 | 测试用 `PORT=8095` 启动 → `saveConfig()` 把 8095 写回 `config.json` | 加 `_fileConfig` 快照，保存时回写文件原始 `httpPort`/`host` |
| `/api/config` 新键不生效 | 该接口有**键白名单** | 新增配置键必须同步加进白名单 |
| `sendCommand()` 对串口"乐观返回" | `port.write()` 异步，回调里的错误只记进 `stats.lastError`，函数**已经 return true** | 诚实性设计：只有"串口写出成功"或"板端 2s 内确实在轮询"才算送达 |
| 板端 ack 被忽略 | `cam_shot` 命令**不带 `request_id`** → `REQUESTS.get(undefined)` | 有意不改协议（风险大），改用日志让失败可见 |

#### 下行通道的诚实性设计（重要）

开发板是**纯 HTTP 客户端**（只 `POST /api/data`），服务端连不上它。
所以拔掉 USB 后命令送不到板子 → 新增 **WiFi 轮询下行**：板端每 400ms `GET /api/cmd?device=...`。

**关键原则**：**入队 ≠ 已送达**。只有"串口写出成功"或"板端确实在轮询（2s 内）"才返回成功，
否则如实提示"尚未送达设备"。这条让"无远端证据不得显示『对方已收到』"的硬指标仍然成立。

### 5.5 前端 / 性能类踩坑

#### 卡顿的三个"每帧级"元凶（都在前端）

| # | 问题 | 修复 |
|---|---|---|
| 1 | `renderImu()` 每帧 `innerHTML = ...` 重建整块 DOM（~15 节点 × 10 次/秒） | 结构只建一次，之后只改文本/进度条；值相同不写 DOM |
| 2 | `appendRaw()` 逐条 `appendChild` + 给 `scrollTop` 赋值（**强制同步布局**） | 入队 + rAF 合并成一次 `DocumentFragment` 批量写入 |
| 3 | `fitCanvas()` 每帧 `getBoundingClientRect()`（**强制同步布局**） | 缓存画布尺寸，仅在 resize / 切页时失效重测 |

> **通用教训**：`scrollTop` 赋值和 `getBoundingClientRect()` 都会触发**强制同步布局**，
> 在每秒十几次的渲染路径里出现就是卡顿元凶。
> 服务端配套：原始日志 WS 广播合并为 250ms 一批（消息数 164 → 114 条/10 秒）。

#### 曲线显示的连环修复（12 轮迭代）

| 问题 | 根因 | 修复 |
|---|---|---|
| 曲线"不断堆积、不流畅" | 开头抖动数据一直留在缓冲区，把 Y 轴撑到 1.87g | 固定窗口 100 点 + 稳健定标（分位数替代 min/max） |
| Y 轴刻度显示 `-1.76e-3` | `fmtNum` 对 \|v\|<0.01 用 `toExponential(2)` | 新增 `fmtAxis(v, span)` 按量程选小数位 |
| 轻微晃动看着波动很大 | Y 轴自动缩放把小幅度放大到满屏 | 加固定量程档位（±0.5g/±1g/±2g/自动） |
| **整体**抖动（不是单点跳） | ① 去直流基准（中位数）跳变 ② 自动量程分位数跳变 ③ X 轴用 `Date.now()` 受事件循环抖动 | ①② 加指数平滑跟随；③ 改用**服务端采样时刻** `m.ts` |
| **同一段数据在不同位置观感不同** | `smooth()` 是**因果滑动平均**，而平滑是在"截取后的窗口"上做的 → 窗口最左端平滑窗口残缺，噪声裸露看着幅度变大 | 改为**先对整段历史平滑，再截取显示窗口** |
| 离开摄像头页仍卡顿 | `renderCam()` 只在摄像头页被调用，离开后 `<img>` 的 src 没摘 → 浏览器后台持续解码 JPEG，板端也白推流抢 IMU 带宽 | `showPage()` 里目标页不是 cam 就摘掉 src |

> **验证手法**（很干净）：看服务端 `/api/cam` 的 `viewers` 计数 ——
> 停在摄像头页 `viewers=1`，切到实时页 `viewers=0` ✅

#### 无头浏览器验证前端（可复用手法）

本机**没有** playwright（`playwright-cli` 缺依赖包，装它要下浏览器，太重），
但**系统自带 Chrome / Edge**，可以直接用来验证：

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"

# 1) 截图 + 导出 DOM
"$CHROME" --headless=new --disable-gpu --no-proxy-server \
  --virtual-time-budget=9000 --window-size=1600,1200 \
  --user-data-dir=<临时目录> --screenshot=out.png "http://127.0.0.1:8080/"

# 2) 抓 JS 异常：开远程调试，用 node + ws 走 CDP
"$CHROME" --headless=new --disable-gpu --no-proxy-server \
  --remote-debugging-port=9222 --user-data-dir=<临时目录> "http://127.0.0.1:8080/" &
# node 连 http://127.0.0.1:9222/json/list 拿 webSocketDebuggerUrl
```

**★ 关键坑：`--virtual-time-budget` 对 WebSocket 驱动的页面不可用。**
虚拟时钟飞快推进，但 WS 消息按真实时间到达 —— 页面以为过了 10 秒、实际只收到几帧，
图表显示"等待设备数据…"，**看起来像 bug，其实是假象**。
**正确做法**：不用 virtual-time，开远程调试 + **真实时间等待**若干秒后再截图。

**另一个坑**：本项目 `app.js` 包在 IIFE 里，`Runtime.evaluate` 读不到内部变量。
要读内部状态得临时注入 `window.onerror` 钩子把错误写进 `document.title`，
dump DOM 时读标题。**用完记得还原。**

### 5.6 测试 / 环境类踩坑

#### ★ 测试"假失败"根因：板子在线会污染自动化测试

**现象**：板子插着 COM4 且正在上报时，跑测试出现一批"停采保留"类失败：

| 测试 | 板子在线 | 关闭串口探测后 |
|---|---|---|
| storage-test | 16 通过 / **3 失败** | **19 / 0** ✅ |
| ws-test | 7 / **2 失败** | **9 / 0** ✅ |
| verify-test | 4 / **2 失败** | **6 / 0** ✅ |

失败断言都是同一类：`停采后 live=false 但保留连接`。

**根因**：`test/.test-config.json` 里 `autoDetect: true`。测试实例启动时会**自动打开真实板子的 COM4**，
板子以 10Hz 持续上报 → `state.live` 永远是 `true` → 测试想验证的"停采"场景根本没法成立。

**修复**：把 `autoDetect/autoReconnect` 改为 `false`，
并**把该文件纳入版本控制**（原本被 `.gitignore` 忽略 —— 它是被 6 个测试引用的夹具，
无敏感信息；不提交的话 clone 后测试退回默认配置，修复形同失效）。

**决定性对照实验**（不依赖任何测试脚本）：起一个 `autoDetect=false` 的服务，
POST 两帧后等 7 秒 → `connected=true, live=false, stalePolicy=keep, 末值保留` ——
与测试期望完全一致，**证明业务逻辑本身没坏，是测试环境被污染**。

#### 环境坑（都会浪费大量时间）

| 坑 | 表现 | 正解 |
|---|---|---|
| 后台 node 进程跨调用被回收 | 下次调用 `ECONNREFUSED` | "先起服务再发请求"必须写在**同一次** Bash 调用里 |
| `curl` 默认走系统代理 | 连 `127.0.0.1` 报"目标计算机积极拒绝"，看着像服务挂了 | 加 `--noproxy '*'` |
| Git Bash 里 `/tmp/xxx` | 被解析成 `D:\tmp\xxx`（当前盘符根），跨调用对不上 | 统一用 `D:/tmp/...` 这种明确路径 |
| `A && B &` | 把 `cd` 一起放进后台，前台目录不变 → `MODULE_NOT_FOUND`（`requireStack: []`）看着像缺模块 | `cd xxx` 单独一行，再 `(cmd &)` |
| MSYS 路径传给 native node | `node.exe /d/workBUDDY/...` 被当成 `D:\d\...` | 先 `cd`，再用**相对路径** |
| `pkill -f "node.exe server.js"` 杀不掉 | 重启时 `EADDRINUSE`，新代码"看似没生效" | 用 TaskStop |
| **盲目 `taskkill` 所有 node.exe** | **差点杀掉 WorkBuddy 自己的 MCP 服务** | 先看命令行，只杀 `CommandLine -like '*server.js*'` 的那个 |

#### 引用工具链路径的教训

`start.bat` 里写死了托管 node 路径 `22.22.2-2`，而托管运行时会**静默升级**到 `22.22.2-3`
（旧目录被删除）→ 兜底分支必然失败。
**教训：引用工具链路径时不要写死版本号**，改用 `for /d` 动态查找。

### 5.7 网络 / 部署类踩坑

#### GitHub 推送：HTTPS 走不通，SSH 可以

| 路径 | 结果 |
|---|---|
| 直连 `github.com:443` | ❌ 超时（被墙） |
| 本地代理 `127.0.0.1:54799`（GET） | ✅ HTTP 200 |
| 同一代理的 CONNECT 隧道（git 用） | ❌ 502 |
| **SSH `github.com:22`** | ✅ **可连** |

→ **结论：以后推送一律用 SSH**。仓库 `git@github.com:linzizhen/esp-web.git`。
> 注意：仓库在 **`linzizhen`** 名下（不是 `linzizhen0601`），SSH 公钥要加到正确的账号。

#### WiFi 独立网络（作业硬指标）

**2026-09-23 排查结论（历史记录）**：

| 检查项 | 结果 |
|---|---|
| 电脑网卡 | **只有有线网卡**（Realtek 2.5GbE，`10.1.41.112/24`），**没有无线网卡** |
| 学校 WiFi `SZIT-WLAN` | 开放网络但**只广播 5GHz** → ESP32-S3（仅 2.4GHz）**连不上** |
| 手机能打开 `http://10.1.41.112:8080` | 学校 WiFi 与有线网有路由、无客户端隔离 |
| 防火墙 | 已加规则 `IMU Monitor 8080 LocalSubnet`（域/专用/公用，仅本地子网） |

**2026-09-28 后续实测：已跑通**（板子换了 2.4GHz 热点 `431`，板端 IP `10.1.41.123`）。

**★ 最直接的验证手法**：调 `POST /api/disconnect` **释放串口**（等价于"拔掉 USB"），
再观察 `seq` 是否继续增长 —— 增长即证明数据来自 WiFi 独立网络。

---

## 6. 实测基线数据（以后对照用）

> 这些数字是**实测值**，不是理论值。改动后如果偏离太多，说明有回归。

### 6.1 IMU 上报速率

| 场景 | 速率 |
|---|---|
| 摄像头关闭 | **7.1 ~ 8.0 条/秒**（复测两次） |
| QVGA@5fps 推流中 | 7.6 条/秒 |
| QVGA@2fps 推流中 | 6.5 条/秒 |
| 240x240@2fps 推流中 | 4.5 条/秒（更省的分辨率反而更低） |
| 目标周期 | 100ms |
| **实测帧间隔中位数** | **108ms** ← 决定性证据，说明单帧开销不是瓶颈 |

### 6.2 摄像头

| 项 | 值 |
|---|---|
| 单帧大小（QVGA） | 2.7 ~ 5.3 KB |
| 单帧耗时 | **26 ms** |
| 推流帧率（USB） | 5 fps 稳定 |
| 推流帧率（WiFi） | 约 **2.8 fps**（带宽限制，板端自动降速，符合设计） |
| 抓拍（VGA） | 640x480 / 约 13.8 KB |
| 抓拍（SVGA） | 失败率高（内存分配不足，已修） |

### 6.3 摄像头对 IMU 的影响

| 场景 | IMU 速率 |
|---|---|
| 摄像头关闭 | 6.2 条/秒（同一时段测量） |
| 摄像头推流中（QVGA@5fps） | 4.3 条/秒（**保留约 70%**） |

两者共用同一条上行链路，推流会抢带宽。**需要完整采样率时先停推流。**

### 6.4 传感器读数

| 项 | 值 |
|---|---|
| 静止 \|a\|（校准后） | 1.0014g（偏差 0.1%） |
| 静止 \|a\|（随朝向） | 0.93 ~ 1.01g（零偏效应） |
| 芯片温度 | 约 38 °C |
| 重力方向 | 水平放置时 Z ≈ ±1g ≈ ±9.8 m/s²（单位核对基准） |

### 6.5 固件产物

| 项 | 值 |
|---|---|
| 固件大小（第 3 周版） | `0xec050` = 966736 字节（分区余 8%） |
| 固件大小（加摄像头后） | 约 1.04 MB（分区已扩到 1.5MB） |

### 6.6 测试

| 项 | 值 |
|---|---|
| 断言总数 | **110 项**，全部通过 |
| 分布 | acceptance 12 / help 26 / storage 19 / ws 9 / verify 6 / parse 10 / feature 14 / e2e 14 |

---

## 7. 已知限制与未完成项

### 7.1 传感器层面（用户明确不做）

- **\|a\| ≈ 0.93~1.01g 随朝向变化** —— QMA6100P 零偏（zero-g offset）的硬件特性。
  彻底修正需**6 面标定**（用户旋转板子取 6 个朝向）。用户明确表示不需要，已停止该项工作。
  显示层面的倾斜由前端「水平归零」按钮解决（不改上报数值，只改显示参考系）。
- 历史数据朝向分散度仅 0.111（几乎同一姿势），**无法用历史数据做椭球拟合**。

### 7.2 第 3 周实物验证（部分未完成）

已确认：**按键 → 板端上报 → 服务端接收 → 网页显示求助** 这一环跑通。

**仍未验证（4 项）**：

1. 板端 LED 快闪 + 屏幕「求助已发送」的**目视确认**
2. 网页点「我已收到」→ 板端显示「对方已收到」
3. 求助中再按键 → 板端「已取消」
4. ★ **拔掉网线后按键，本地反馈照常**（当堂硬指标① 的最终证据）

**取证限制**：服务端求助事件只存**内存**（`help.history`，不落盘），服务重启即清零。
要留可提交的证据，需在服务运行中**重按一次并同时抓板端串口日志**（`npm run firmware:monitor`）。
取证流程已写入 `docs/week3-flash-evidence.txt`。

### 7.3 代码层面

- **板端"抓拍失败回执"未做**（有意为之）：需要动协议三处 —— `cam_shot` 命令不带
  `request_id`，板端 ack 到服务端会被 `onDeviceAck()` 直接忽略。改协议风险大，
  先用日志让失败可见。
- **抓拍内存修复待烧录验证**：`heap_caps_malloc(MALLOC_CAP_SPIRAM)` 的改动已提交
  （`20484ff`），但**尚未烧录到板子上实测**。
- `cam_stream_set_params()` 忽略了 `set_framesize()` 的返回值 —— 日志"参数已更新"
  不代表切换真的成功。
- 远程采集的**首版状态图**（作业要求提交）—— 已用 mermaid 写在 `docs/week2-remote-collect.md`。

### 7.4 仓库状态

- 本地领先 `origin/master` **2 个提交**（`205b976`、`20484ff`），**未推送**
- 按项目约定：**未经用户明确同意不得主动 `git push`**

---

## 8. 排障速查表

| 现象 | 先查这里 | 常见原因 |
|---|---|---|
| 板子插着但没数据 | `GET /api/diag` | VID `303A` + 0 字节 → 固件 console 在 UART0，或 USB CDC 未启用 |
| 串口扫不到设备 | `npm run ports` | 被别的程序占用（串口独占） |
| 数据在涨但页面不动 | 浏览器 F12 Console | WebSocket 未连上 / JS 异常 |
| 页面显示"等待设备数据" | 曲线字段选择 | 用了无数据的字段（曾被日志假字段占据） |
| 双通道下记录重复 | `/api/diag` 的 duplicate 计数 | 串口帧来源未声明（见 §5.4） |
| 抓拍没反应 | 板端串口日志 | 抓帧失败（现已补日志，不再静默） |
| 板子连不上 WiFi | 板端命令 `wifi_scan` / `wifi_status` | 目标是 5GHz（ESP32-S3 只支持 2.4GHz） |
| 命令下发了但板子没动 | `GET /api/help` 的通道状态 | 串口没开 + 板端未在轮询 → 如实报"尚未送达" |
| 测试批量失败 | 板子是否在线 | 测试环境被真实板子污染（见 §5.6） |
| 端口被占 `EADDRINUSE` | 上一個 node 进程 | 用 TaskStop，别用 pkill |
| 固件编译报 `CreateProcess failed` | ccache | `-DCCACHE_ENABLE=0 reconfigure` |
| 固件报 `esp_timer.h` 找不到 | `main/CMakeLists.txt` | 误加了 `REQUIRES` |

---

## 9. 附录：提交历史（32 个提交，节选关键节点）

| 提交 | 内容 |
|---|---|
| `20484ff` | 固件：修复高分辨率抓拍静默失败（base64 缓冲内存分配不足） |
| `205b976` | 修复：自检脚本误连真实板子，造成"停采"类假失败 |
| `1516c9d` | 修复：`start.bat` 写死的托管 node 路径已失效 |
| `7d229fa` | 文档纠错：§6.2 里残留的 IMU 速率旧数据一并修正 |
| `87f8c46` | 文档纠错：修正 IMU 上报速率的错误结论（并撤回一个不必要的优化建议） |
| `d3445e9` | 性能：离开摄像头页时断开 MJPEG，避免后台持续解码 |
| `de77c39` | 修复：实时监控页卡顿 + 连续抓拍失效 |
| `d05d923` | 文档：更新过时结论 —— WiFi 独立网络已跑通；补充摄像头功能说明 |
| `911d777` | 修复：串口数据被误标为 wifi，导致双通道下同一帧被记录两次 |
| `a92cc8a` | 抓拍一帧：做成真正可用的"高清单张快照"（之前是半成品） |
| `a8e9bb6` | 修正：摄像头分辨率索引表错了，导致"请求 QVGA 得到 240x240" |
| `feb84e8` | 新增：板载摄像头（OV2640）实时画面，Web 端可看直播 |
| `fe028d8` | 第 3 周：按键触发与物理反馈闭环 |
| `18d0bb4` | 第 2 周：远程采集指令与执行结果反馈 |
| `5622c33` | 趋势曲线改为三轴同屏：叠加显示、暂停、量程与平滑优化 |

> 完整历史：`git log --oneline`（仓库 `git@github.com:linzizhen/esp-web.git`）

---

## 10. 一句话总结

这个项目的技术难点**不在"把数据传上去"**，而在：

1. **如实性** —— 不造数、不冒充、失败就如实报失败（停采保留旧值并标"未更新"、
   命令入队不等于送达、抓拍 ack 只代表收到）
2. **双通道的一致性** —— 同一帧可能从串口和 WiFi 各来一次，去重判据必须建立在
   **不可变字段**（`device` + `seq`）上，而不是共享可变状态
3. **先核实再动手** —— 本项目四次真实翻车（性能误判、单次测量误判、无头模式假象、
   单通道结论外推）全部靠"读源头 / 量一次 / 做对照 / 复测"纠正回来

---

*文档结束。配套源码见同目录 `imu-monitor/`。*
