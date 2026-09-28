# ESP32 传感器实时 Web 监控平台

通过 USB 串口（或 WiFi）读取 ESP32 开发板的真实传感器数据，实时展示在网页上。
**开发板拔掉后，页面立即清空所有数值并提示"未检测到开发板"——平台不含任何模拟/随机/占位数据。**

## 一、快速开始

### 1. 启动平台

双击 `start.bat`，或在项目目录执行：

```bash
npm start          # 等价于 node server.js
```

启动后浏览器访问 <http://localhost:8080>

### 2. 烧录固件到 ESP32-S3-EYE

本项目当前使用 **ESP-IDF 工程** `firmware/s3eye_imu_idf/`（Arduino 草稿为早期版本，已不用）。

先填配置 —— **WiFi 密码不要写进 `app_config.h`**（该文件会提交到仓库），
复制模板到本地私密文件（已被 `.gitignore` 忽略）：

```bash
cd firmware/s3eye_imu_idf/main
cp app_config.local.h.example app_config.local.h   # 然后编辑它，填 WiFi / 服务器 IP / 设备 ID
```

然后：

```bash
npm run firmware:build     # 编译
npm run firmware:flash     # 编译并烧录到 COM4
npm run firmware:monitor   # 串口监视（Ctrl+] 退出）
```

> 烧录前请在网页点「**释放串口**」——Windows 串口是独占的。
> 这三个脚本走 `scripts/idfwrap.py`，它已处理好 MSYS 与 ESP-IDF Python 环境，无需手动 export。

### 3. 接线（可选）

**各芯片的 ADC 引脚完全不同**，固件已按型号自动切换（不用手动改代码）：

| 芯片 | ADC1 可用引脚 | 固件默认值 |
|---|---|---|
| **ESP32-S3** | GPIO1~GPIO10 | **GPIO4、GPIO5** |
| ESP32（经典款） | GPIO32~GPIO39 | GPIO34、GPIO35 |
| ESP32-C3 / C6 / H2 | GPIO0~GPIO4（GPIO0 是启动脚，别用） | GPIO3、GPIO4 |

> ESP32-S3 注意：**不要**用 GPIO26~32（Flash/PSRAM）和 GPIO33~37（八线 PSRAM）。
> DHT22 默认接 GPIO4 —— 若与上面的 ADC0 冲突，改 `DHT_PIN` 或 `ADC_PIN_0` 即可。

信号范围 **0~3.3V，超过会烧 IO**。

### 4. 查看数据

开发板上电后，平台会自动识别串口并连接，页面顶部状态变为绿色「已连接 · 串口」，随后显示实时数值、趋势曲线与原始数据日志。

## 二、断开行为（关键）

平台区分**三种状态**，由 `config.json` 的 `stalePolicy` 控制停采后的行为（默认 `keep`，契合作业「停采后保留旧时间、提示未更新」要求）：

| 状态 | 触发 | 页面表现 |
|---|---|---|
| **实时**(live) | 持续收到真实数据 | 绿色「已连接」，数值与曲线实时刷新 |
| **停采保留**(stale) | 收到过数据但超过 `staleAfterMs`（默认 5s）无新数据 | 黄色「已停采 · 保留末次数据」+「未更新」徽章，**保留最后一次真实值与旧时间** |
| **离线**(cleared) | 串口 `close`（物理拔线）/ 手动「释放串口」 | 立即清空全部数值与曲线，横幅提示「未检测到开发板」，**无任何模拟数据** |

> `stalePolicy: 'clear'` 时，停采超过 `offlineAfterMs`（默认 15s）会进一步清空（满足"拔线即无数据"的原始要求）。物理拔线/手动释放**在任何策略下都立即清空**。

| 情况 | 页面表现 |
|---|---|
| 拔掉 USB（串口 close） | 立即清空全部数值与曲线，横幅提示「未检测到开发板」 |
| 驱动未上报拔线 | 超过 `offlineAfterMs`（默认 15s）无任何数据 → 判定设备已移除，同样清空 |
| 上报非 JSON / 无数值 | 只记入「原始数据」日志，**不作为数据显示** |

离线时所有卡片显示占位符，重新插上开发板后自动重连并恢复显示。

## 三、目录结构

```
imu-monitor/                    # ← 本项目即一个自包含文件夹，所有文件都在此目录内
├── server.js                 # 后端：串口管理 + HTTP + WebSocket 推送 + NDJSON 落盘
├── config.json               # 配置文件（端口、波特率、超时、字段单位与中文名）
├── README.md                 # 本文件：运行/接线/验证说明
├── ASSIGNMENT.md             # 课程作业提交说明（分工/单位时间核对/风险/部署/一人一记录）
├── package.json
├── start.bat                 # 一键启动（双击即可）
├── .gitignore                # 排除构建产物 / 依赖 / 运行时数据
├── scripts/
│   ├── idfwrap.py            # ESP-IDF 构建/烧录封装（自动注入工具链环境）
│   └── set_wifi.py           # 一键切换板端 WiFi 配置（自动检测本机 IP，写入 gitignore 的本地文件）
├── docs/
│   ├── week2-remote-collect.md  # 第 2 周：远程采集协议、状态图、时序图、实测记录
│   └── week3-button-feedback.md # 第 3 周：按键触发与物理反馈闭环（协议/状态图/时序图/实测）
├── data/                     # NDJSON 原始记录（持久化存储，运行后生成）
├── recordings/               # 录制导出的 CSV（运行后生成）
├── public/
│   ├── index.html            # 监控页面（分页：实时监控 / 远程采集 / 记录与设备）
│   ├── style.css
│   └── app.js                # WebSocket 接收、卡片渲染、Canvas 绘制（含滑动平均）、记录查询、分页路由
├── firmware/
│   ├── s3eye_imu_idf/        # ★ 当前使用：ESP-IDF 工程（QMA6100P 三轴 + 10Hz 上报 + 校准）
│   │   ├── CMakeLists.txt
│   │   ├── sdkconfig.defaults
│   │   ├── tools/
│   │   │   └── gen_font.py   # LCD 点阵字模生成脚本（输出 lcd_font.h + 预览图）
│   │   └── main/
│   │       ├── main.c        # 主程序：IMU / JSON 组帧 / USB-CDC + WiFi 上报 / 按键 / LED / LCD
│   │       ├── lcd_font.h    # 自动生成的点阵字模（中文 32×32 × 25 字 + ASCII 8×16）
│   │       └── app_config.h  # ★ 唯一需要改的配置：WiFi 凭据 / 服务器 IP / 设备 ID
│   ├── esp32_monitor.ino       # （旧）Arduino USB 串口版草稿
│   ├── esp32_monitor_wifi.ino  # （旧）Arduino 通用 WiFi 版草稿
│   └── s3eye_imu_wifi/          # （旧）Arduino S3-EYE 专用草稿
│       └── s3eye_imu_wifi.ino
└── test/
    ├── acceptance-test.js    # 全链路验收：固件帧→落盘→页面→停采（隔离端口 8096）
    ├── e2e-test.js           # 链路自检：空状态 / 上报解析 / 停采保留 / 断开清空
    ├── verify-test.js        # 本组身份校验：device ↔ expectedDeviceId（隔离端口 8095）
    ├── feature-test.js       # 诊断接口 / 录制导出 / CSV
    ├── parse-test.js         # 通用解析：JSON / 键值 / 中文键
    ├── storage-test.js       # 持久化 + 查询 + 停采保留
    ├── ws-test.js            # WebSocket sample/stale/cleared 推送结构
    ├── help-test.js          # 第 3 周：教学求助闭环（状态不前进 / 回执确认 / 不污染数据链路）
    └── listen.js COM4 25     # 原样监听某串口 N 秒，看板子在发什么
```

> 所有文件均在本目录内；除 ESP-IDF 工具链（`C:\Espressif`）与本机 Node.js 外，
> 项目不依赖任何目录外资源。整体复制本文件夹即可迁移。

## 四、配置说明（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `httpPort` | 8080 | Web 服务端口 |
| `host` | 0.0.0.0 | 监听地址。默认 `0.0.0.0` 允许局域网设备（开发板）直接上报；仅本机调试可改为 `127.0.0.1` |
| `baudRate` | 115200 | 串口波特率，须与固件一致 |
| `portPath` | null | 指定串口（如 `COM3`）；`null` = 自动识别 |
| `autoDetect` | true | 自动扫描 ESP32（按 VID 打分：Espressif > CP210x > CH34x > FTDI） |
| `autoReconnect` | true | 断开后自动重连 |
| `staleAfterMs` | 5000 | 超过此时间无数据 → 标记「设备无数据」 |
| `offlineAfterMs` | 15000 | 超过此时间无数据 → 判定设备已移除并清空 |
| `wifiTimeoutMs` | 8000 | WiFi 上报心跳超时（预留，停采阈值统一用 `staleAfterMs`） |
| `stalePolicy` | `keep` | 停采策略：`keep`=保留末次数据与旧时间并提示"未更新"（作业默认）；`clear`=超时后清空 |
| `expectedDeviceId` | null | **本组设备身份校验**：设为固件里的 `DEVICE_ID` 后，平台标记每帧数据是否来自本组（前端显示 ✓本组/⚠非本组），避免邻组数据混显 |
| `storageEnabled` | true | 是否把每帧真实采样落盘为 NDJSON（`data/records.ndjson`） |
| `storageMaxMb` | 32 | 单记录文件超过该大小自动滚动归档 |
| `fieldUnits` / `fieldLabels` | — | 字段单位与中文显示名映射 |

修改后重启服务生效（也可通过 `POST /api/config` 热更新部分字段）。

**环境变量**（部署 VPS 时常用，覆盖配置里的端口/监听）：`PORT=8080`、`HOST=0.0.0.0`（允许局域网/外网访问）。

## 五、接入自己的传感器

固件只需保证每隔一段时间向串口 `print` 一行 JSON：

```cpp
Serial.println("{\"temperature\":26.5,\"humidity\":58.2,\"soil\":1890}");
```

页面会**自动识别所有数值字段**并生成卡片与曲线，无需改前端。
若字段名不在 `config.json` 的 `fieldLabels` 中，会按原始 key 显示（可自行补映射）。

### 5.1 已有固件、不想重烧？用通用解析

平台不只认 JSON。`config.json` 里的 `parseMode` 控制解析策略：

| parseMode | 支持 |
|---|---|
| `auto`（默认） | JSON，以及 `键=值` / `键: 值` 形式 |
| `json` | 只认 JSON |
| `kv` | 只认 `键=值` / `键: 值` |
| `csv` | 纯数字序列，按 `ch1…chN` 命名（可能把日志里的数字误当数据，慎用） |

以下格式都能直接出卡片和曲线：

```
Temp=25.3,Hum=60.1
Temp: 25.3 C  Hum: 60.1 %
temperature:26.5 humidity:58.2
温度: 26.5 湿度: 58.2
```

必须是"有标签"的键值形式；`[info] connected in 1234 ms`、`Time: 12:34:56` 这类不会被误当成传感器值（已有测试覆盖）。

## 六、HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 当前连接状态与最新字段 |
| GET | `/api/ports` | 可用串口列表 |
| POST | `/api/connect` | `{portPath, baudRate, autoDetect}` 连接设备 |
| POST | `/api/disconnect` | 断开 |
| GET/POST | `/api/config` | 读写配置 |
| GET | `/api/diag` | 诊断信息：串口列表、开关状态、字节数、报文统计、排查建议 |
| POST | `/api/probe` | `{portPath, ms}` 波特率探测，返回每个波特率收到的字节与样例 |
| POST | `/api/record` | `{action:'start'\|'stop'}` 录制真实数据；`stop` 返回 CSV 文件名 |
| GET | `/api/record/download?file=` | 下载录制好的 CSV |
| POST | `/api/data` | WiFi 上报入口（ESP32 或其他设备推送 JSON，支持 `device`/`mac`/`ts`/`iso` 元数据） |
| GET | `/api/records?device=&limit=&since=&until=` | 查询 VPS 落盘的真实记录（一帧观测一条） |
| GET | `/api/devices` | 列出所有出现过的设备（计数、首次/末次出现） |
| GET | `/api/records.csv?device=&limit=` | 导出原始记录为 CSV（BOM） |
| POST | `/api/collect` | **远程采集**：创建一次采集请求并下发到开发板，返回 `request_id` |
| GET | `/api/collect` | **远程采集**：最近请求列表（页面刷新后恢复显示）+ 通道状态 + `mockDevice` |
| GET | `/api/collect/:id` | **远程采集**：查询单个请求的完整状态 |
| POST | `/api/report` | **周期上报开关**：`{action:'pause'\|'resume'}`（命令通道保持可用） |
| GET | `/api/help` | **教学求助**：当前求助状态 + 命令通道状态 |
| POST | `/api/help` | **教学求助**：`{action:'ack'\|'cancel'\|'reset'}` 查看者回应 / 取消 / 复位 |
| GET | `/api/cmd?device=` | **下行命令轮询（WiFi 通道）**：开发板定期来取待执行命令；无命令返回 `{}` |
| WS | `/ws` | 实时推送 `sample` / `status` / `raw` / `cleared` / `stale` / `hello` / `collect` / `help` |

## 六之一、ESP32-S3-EYE 专项说明

ESP32-S3-EYE（含 SUB_V1.1 子板）有三个与其他板子不同的关键点：

**1. 没有 USB-UART 桥接芯片**
通信完全靠 ESP32-S3 内置 USB Serial/JTAG（GPIO19/20）。所以 COM 口的 VID 一定是 `303A`，**这是唯一通道，没有第二个串口可选**。

**2. 所有 GPIO 都已被占用**
摄像头 OV2640、1.3" LCD（SPI）、I2S 数字麦克风、MicroSD、QMA6100P 加速度计（I2C）、6 个按键已占满全部 GPIO，官方文档明确写明 *"all GPIOs ... have already been used"*。
→ **外接 ADC 传感器在这块板上不可行**。可用的是芯片内部数据源：`temperatureRead()`（内部温度）、`ESP.getFreeHeap()`、`millis()`；若要用加速度计/麦克风需自行驱动其总线。

**3. 出厂固件是 ESP-IDF + ESP-WHO，console 可能不在 USB 口**
ESP-IDF 默认把 console 输出到 UART0；只有 menuconfig 里设为 `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG` 才会走 USB 口。**出厂固件若未在 USB 口输出，平台必然收不到任何字节** —— 这与平台无关。

**判定方法**：平台连接状态下按一下板上的 **RST** 键，看页面「原始数据」里有没有 ESP-IDF 启动日志。
- 有日志 → console 在 USB 口，把日志贴出来，我按它的实际格式配置解析
- 完全没有 → console 在 UART0，不重新烧录就无法从这个口取到数据

**烧录恢复方法**（此板无桥接芯片，程序跑飞时）：按住 **BOOT** → 按一下 **RST** → 松开 RST → 再松开 BOOT，进入 Firmware Download 模式。

## 六之二、ESP32-S3 专项说明

S3 用的是**原生 USB Serial/JTAG 口**（VID 303A / PID 1001），不是外挂的 CH340/CP210x。由此带来三点必须注意：

**1. 必须开启 USB CDC On Boot**
`工具 → USB CDC On Boot: Enabled`。不开的话 `Serial` 会被映射到 GPIO 的 TX/RX 引脚，USB 口上一个字节都收不到 —— 这是"插着板子却完全没数据"的最常见原因。开启后重新烧录并按 RESET。

**2. 波特率对它是无意义的**
USB CDC 是虚拟串口，115200 还是 921600 都一样。所以"波特率探测全 0"不等于波特率不对，而是固件没输出到这个口。

**3. 烧录前必须释放串口**
Windows 的串口是独占的。平台正占着 COM4 时，Arduino IDE 打不开它。流程：

```
平台点「释放串口」→ Arduino IDE 上传固件 → 平台点「连接设备」
```

**看不到数据时的自检顺序：**
1. 页面点「诊断」→ 看 `bytesReceived`
2. 是 0 → 先点「释放串口」，再用 Arduino IDE 打开串口监视器看有没有 `chip=ESP32-S3` 之类的启动横幅
3. 串口监视器有输出、平台没有 → 检查是不是忘了关串口监视器（它会独占串口）
4. 串口监视器也没输出 → USB CDC On Boot 没开，或固件没烧进去

## 六之三、远程采集（第 2 周）

Web 页「**远程采集**」标签页可向开发板**下发一次立即采集命令**，并追踪这条请求的执行结果。

### 为什么能证明是「新采集」

页面**不读数据库的最后一条**当结果，只认**带本次 `request_id` 的观测**——
数据库里的旧记录根本没有这个 id，物理上无法冒充。四条证据：

1. **`request_id` 回环**：服务端生成 → 下发 → 板端原样回传
2. **板端 `seq` 严格递增**：证明是新采样，不是重发旧帧
3. **时间先后**：观测到达时刻晚于命令下发时刻
4. **页面只认 id**：超时则明确显示「本次没有收到新观测」，**绝不回退显示旧值**

界面上 1~3 会逐条打勾展示。

### 协议（叠加在现有串口之上，未改底层）

```jsonc
// 下行
{"cmd":"collect_once","request_id":"req-..."}
{"cmd":"pause"} / {"cmd":"resume"} / {"cmd":"ping"}
// 上行
{"type":"ack","request_id":"req-...","seq":926,"status":"received"}
{"device":"...","seq":927,"request_id":"req-...","acc_x_g":...}   // 观测 = 数据帧 + request_id
```

> 观测帧就是普通数据帧多带一个 `request_id`，落盘/展示/历史查询全部复用，无需新增解析分支。

### 状态机

`已提交 → 已下发 → 设备已接收 → 完成`，异常分支 `超时` / `失败`。
**超时 ≠ 硬件故障**，也不代表旧值有效。

### 当堂验证（一键复现）

1. 点「**暂停周期上报**」→ 曲线停止刷新，命令通道保持
2. 保持暂停，点「**采集一次最新数据**」→ 应收到**新观测**（带 `request_id`，seq 递增）
3. 改变开发板姿态后再次采集 → 数值随姿态变化
4. 关闭/断开设备后采集 → 等待后**超时**，观测区为空
5. 连续点击多次 → 每次独立 `request_id`，各自采样

### 模拟模式（无板联调）

`config.json` 里 `mockDevice: true` 可让服务端自答回执与观测。
**所有模拟结果都带 `simulated` 标记**，界面显示红色「模拟」徽章，绝不冒充实物命令。

> 完整说明（含状态图、时序图、实测记录）见 [`docs/week2-remote-collect.md`](docs/week2-remote-collect.md)。

## 六之四、教学求助（第 3 周）

Web 页「**教学求助**」标签页与开发板上的**功能按键 + LED + 屏幕**组成一个物理反馈闭环。

### 三种反馈，三层含义

| 阶段 | 谁看到 | 形式 | 依赖网络？ |
|------|--------|------|-----------|
| ① 本地确认 | 佩戴者 | 板端 **LED 快闪** + 屏幕「求助已发送」 | ❌ 不依赖 |
| ② 远端接收 | 查看者 | 网页出现求助 + 导航红点 | ✅ |
| ③ 查看者回应 | 双方 | 网页点「我已收到」→ 板端 **LED 慢闪** + 屏幕「对方已收到」 | ✅ |

### 两条硬指标（当堂验证）

1. **断开外网后，本地仍能确认按键已触发** —— 板端 LED/屏幕在按下瞬间变化，上报失败不影响它们。
2. **无远端接收证据时，绝不显示「对方已收到」** ——
   - 服务端只有真正收到板端求助事件才把状态置为 `received`；
   - 网页只有**命令确实写出串口**才显示"回应已下发"；
   - 板端**只有收到 `viewer_ack` 命令**才显示「对方已收到」，并回执 `ack_shown` 供网页确认。

### 硬件（ESP32-S3-EYE v2.2 官方资料）

| 用途 | 引脚 | 约束 |
|------|------|------|
| 功能按键（ADC 电阻分压） | GPIO1 (ADC1_CH0) | 上电自适应校准阈值 |
| Module Power LED | **GPIO3** | ★ **必须开漏输出**，拉高会烧 LED |
| LCD 1.3" 240×240 ST7789 | PCLK=21 / MOSI=47 / DC=43 / CS=44 / 背光=48 | SPI3 |
| 蜂鸣器 | **板载没有** | 实体反馈用 LED + 屏幕实现 |

### 协议

```jsonc
// 上行（板端 → 服务端，复用数据帧同一条链路）
{"type":"help","event":"request","help_id":"help-...","device":"...","seq":130,...}
{"type":"help","event":"cancel","help_id":"help-...",...}
// 下行（服务端 → 板端）
{"cmd":"viewer_ack","request_id":"help-..."}
{"cmd":"help_cancel","request_id":"help-..."}
// 板端回执
{"type":"ack","request_id":"help-...","status":"ack_shown"}
```

### 界面

- 导航「教学求助」上的**红点**：有待回应的求助时提示
- 三个按钮：**我已收到** / **取消求助** / **清除记录**
- **状态时间线** + **证据链**（本地反馈 / 服务端接收时刻 / 板端时间偏差 / 命令是否送达 / 板端是否回执）

> 完整说明（含板端与服务端状态图、时序图、实测记录、迁移说明）见
> [`docs/week3-button-feedback.md`](docs/week3-button-feedback.md)。

## 六之五、WiFi 下行通道（拔掉 USB 也能下发命令）

开发板是**纯 HTTP 客户端**——只会主动往服务端 POST，服务端连不上它。
所以下行（服务端 → 板）原本只能走 USB 串口，**拔掉 USB 后「远程采集」和「求助回应」就送不到板子**。

现在补上了第二条下行通道：**板端定期来取命令**。

```
板端每 400ms：GET http://<服务器>:8080/api/cmd?device=S3EYE-GROUP01
   → 有命令返回该命令（如 {"cmd":"collect_once","request_id":"..."}）
   → 没有返回 {}
板端取到后走与串口命令【完全相同】的处理逻辑，回执照旧经上行回传
```

### 两条下行通道如何共存

| 情况 | 走哪条 | 说明 |
|------|--------|------|
| 串口已连接 | **USB 串口**（优先） | 低延迟；队列为空，板端来取只会拿到 `{}` |
| 串口未连接、板端在轮询 | **WiFi 轮询** | 延迟约 400ms |
| 两者都不可用 | 命令**入队等待** | 15 秒内板端上线就能取走；否则作废，请求按超时处理 |

**不会重复执行**：串口在线时服务端只写串口、不写队列，板端来取永远是空的。

### 诚实性保证（不变）

- 命令**入队 ≠ 已送达**。只有「串口写出成功」或「板端确实在轮询」才算可送达；
- 否则如实提示"尚未送达设备"，**绝不声称对方已收到**；
- 板端回执 `ack_shown` 回来后，才把 `ack_delivered` 置为 true。

### 要真正用起来，需要两件事

1. **填 WiFi 凭据**：一条命令搞定（会自动检测本机 IP 并写入被 `.gitignore` 忽略的
   `app_config.local.h`，密码不会进仓库）：

   ```bash
   # 只写配置
   npm run wifi:set -- --ssid "你的热点名"

   # 指定服务器 IP（多网卡时）
   npm run wifi:set -- --ssid "你的热点名" --pass "密码" --host 192.168.137.1

   # 写完直接编译并烧录
   npm run wifi:set -- --ssid "你的热点名" --flash
   ```

   也可以手工：复制 `app_config.local.h.example` 为 `app_config.local.h` 再填。

2. **放行防火墙**：服务器电脑允许 8080 入站（仅需一次，需管理员权限）：

   ```
   netsh advfirewall firewall add rule name="IMU Monitor 8080 LocalSubnet" dir=in action=allow protocol=TCP localport=8080 remoteip=localsubnet profile=any
   ```

> ⚠️ **ESP32-S3 只支持 2.4GHz**。若目标热点只广播 5GHz，板子扫不到它。
> 烧录后看开机扫描日志：目标 SSID 会标 `★ 目标`；若提示"未在 2.4GHz 发现"，
> 说明该热点是 5GHz-only，需要改用 2.4GHz 的热点（手机热点注意开"最大兼容性"）。

改完就可以**拔掉 USB 线**，完整跑通「实时数据 + 远程采集 + 教学求助」闭环。
`APP_SERVER_HOST` 填服务器电脑的局域网 IP；轮询间隔由 `CMD_POLL_INTERVAL_MS` 控制（默认 400ms）。

> 点「诊断」按钮可查看下行状态：`downlink: {serial, wifiPolling, queued, sentViaSerial, sentViaWifi}`。

### 板端自带诊断命令（现场排查用，无需重烧固件）

直接向板子发命令即可（串口或 WiFi 轮询通道都行）：

```jsonc
{"cmd":"wifi_status","request_id":"x"}   // 问清当前 WiFi 状态
{"cmd":"wifi_scan","request_id":"x"}     // 重扫 2.4GHz 并打印可见 AP（短暂断开后自动重连）
```

`wifi_status` 回执示例与含义：

| 回执 | 含义 |
|------|------|
| `linked=1 ip=10.1.41.x rssi=-28 up=12 fail=0` | 一切正常 |
| `linked=1 ip=- rssi=-28 up=0 fail=0` | **已关联但拿不到 IP** → 问题在 AP/网络侧（DHCP 未响应），与 SSID/密码无关 |
| `linked=0 ip=- ...` | 没关联上 → SSID/密码错，或该热点只在 5GHz 广播 |

> 这两条命令是排查"连上了却传不出去"时最有效的第一步——先分清是**关联失败**还是 **DHCP 失败**，两者排查方向完全不同。

## 七、排查：板子插上了但没数据

页面上有两个按钮专门解决这个问题：

- **诊断**：列出所有串口及其 VID/score、当前串口是否打开、已收字节数、报文统计（总/有效/无效），并直接给出排查建议。
- **波特率探测**：对该串口依次用 9600 → 921600 各监听 1.5 秒，报告哪个波特率能收到数据、收到什么内容，并自动把建议波特率填回下拉框。

常见结论：

| 现象 | 含义 |
|---|---|
| 找不到 score > 0 的串口 | 数据线是纯充电线，或驱动未装（CH340/CP210x） |
| 串口打开但 0 字节 | 波特率不对，或程序没在用 `Serial.println()` |
| 所有波特率都 0 字节 | 板子没烧程序 / 程序无串口输出 / S3、C3 需开启 `USB CDC On Boot` / 板子在下载模式 |
| 有字节但 0 行有效 JSON | 输出不是以 `{` 开头的 JSON，或没换行 |
| 串口是 VID 303A（原生 USB Serial/JTAG） | **波特率对它无意义**，扫波特率没用。收不到数据 = 固件没输出到该口：Arduino IDE 里把 **USB CDC On Boot 设为 Enabled** 后重新烧录，再按 RESET |

> 判断方法：诊断里若某个串口 `vid=303A score=100`，说明是 ESP32-S3/S2/C3/C6/H2 的**原生 USB 口**（虚拟串口，波特率无效）；若是 `1a86`(CH340) 或 `10c4`(CP210x)，则是外挂 USB 转串口芯片，波特率必须与固件一致。

> 注意：Arduino IDE 的**串口监视器**和**烧录器**都会独占串口，用本平台前请先关掉监视器；要烧录则先点平台的「释放串口」。

## 八、真实数据录制

点击 **开始记录** → 平台把设备实际上报的每一条采样记在内存里 → 点 **停止并下载** 导出 CSV（含 BOM，Excel 直接打开不乱码）。

- 只在设备真实上报时写入，**离线期间不产生任何行**
- 录制期间一条数据都没有 → 不生成文件
- 上限 20 万行，超出丢弃最早的

## 九、自检

全套 **110 项**。测试实例统一使用 `test/.test-config.json` 隔离配置（`autoDetect:false`），
所以**开发板插着也能跑**，不会互相干扰（此前板子在线会导致"停采保留"类断言假失败，已修复）。

```bash
# 下面三个需要先在 8080 起服务：npm start
node test/e2e-test.js      # 数据链路：空状态 / 上报解析 / 离线清空 / 非法报文过滤（14 项）
node test/feature-test.js  # 诊断接口 / 录制导出 / CSV 内容（14 项）
node test/parse-test.js    # 通用解析：JSON / 键值 / 中文键 / 误解析防护（10 项）

# 以下自带服务，无需先启动（各自独立端口）
node test/help-test.js     # 第 3 周：教学求助闭环（端口 8097，26 项）
node test/listen.js COM4 25  # 原样监听某个串口 25 秒，看板子到底在发什么
```

## 八、常见问题

**串口打不开 / 一直「未检测到开发板」**
- 确认 Arduino IDE 的串口监视器已关闭（串口被独占）
- 确认波特率与固件一致（默认 115200）
- 在页面串口下拉框手动选择端口

**页面一直显示「串口已打开 · 等待数据」**
- 固件未烧录或未运行；打开串口监视器看是否有 JSON 输出
- 开发板上的程序可能用了 `Serial.print` 但没换行——必须是 `println`

**数值字段显示为原始 key**
- 在 `config.json` 的 `fieldLabels` 里补上映射即可
