# 整合记录：历史进度 imu-monitor 并入本仓库

- 日期：2026-09-28
- 来源：`imu-monitor-代码与经验-2026-09-28.zip`（原项目 `D:\workBUDDY\esp32\imu-monitor`，原 git `20484ff`）
- 原则：**保留你的设计与实现，只做必要的对接修正**，不重排、不重写你的逻辑

## 一、整合后的仓库结构

```
ego-link-ux-prototype/
├── server.js                  ★ 主服务端（Node.js，你的实现）
├── config.json                  服务端配置（端口/超时/字段映射/设备校验）
├── package.json / start.bat     启动入口（npm start / 双击）
├── public/                    ★ 前端（原生 JS，实时曲线 + 远程采集 + 教学求助 + 记录）
├── test/                      ★ 110 项自检（9 个脚本）
├── scripts/                     idfwrap.py（ESP-IDF 构建封装）、set_wifi.py（一键配网）
├── firmware/                  ★ 板端固件
│   ├── s3eye_imu_idf/           主用：ESP-IDF 工程（IMU/按键/LED/LCD/摄像头）
│   ├── esp32_monitor*.ino       早期 Arduino 草稿（留档）
│   └── s3eye_imu_wifi/          早期 S3-EYE Arduino 草稿（留档）
├── board/                     备用固件：PlatformIO + Arduino（本次新增）
│   └── src/main.cpp             与主平台同格式的扁平帧，可独立编译烧录
├── server/ + web/             备用服务端：Python 标准库（本次新增）
├── docs/                      文档：周记录、性格总结、第 2/3 周设计文档
│   ├── 经验总结-ESP32-S3-EYE.md
│   ├── week2-remote-collect.md / week3-button-feedback.md
│   └── week-01-验收记录.md
└── ASSIGNMENT.md              课程作业逐条对照（你的原文）
```

原 `prev/` 暂存层已取消——实现直接放在仓库根，与你的原工程布局一致。

## 二、本次做的三处对接修正（其余原样保留）

### 1. IMU 型号与解析修正（**重要，影响数据正确性**）

| 项 | 你的原实现 | 修正后 | 依据 |
|---|---|---|---|
| 器件 | QMA7981（ID 期望 0xE7） | **QMA6100P**（ID = 0x90） | 本板实测 WHO_AM_I = 0x90；乐鑫 `esp-bsp/components/qma6100p` 常量 `QMA6100P_WHO_AM_I_VAL = 0x90` |
| 数据解析 | `x16 >> 2`（按 14bit 左对齐） | `x16 / 4`（整数除法得设备值） | 官方驱动 `qma6100p_get_raw_acce`：`(int16_t)((HIGH << 8) + LOW) / 4` |
| 换算 | `raw * 2 / 8191 * 0.765` | `raw / 4096`（±2g，4096 LSB/g） | 官方驱动 `qma6100p_get_acce_sensitivity`：±2g → 4096 |
| 量程寄存器 | 写 0x0F = 0x00 | 写 0x0F = **0x01**（±2g = 0b0001） | 官方驱动 `ACCE_FS_2G = 0b0001`；0x00 不是合法档位 |
| 上电命令 | 0x11 = 0xC0 | 0x11 = **0x84** | 官方驱动 active 值 |
| 校准系数 | `QMA_CALIBRATION 0.765f` | **已移除** | 该系数是为掩盖"记错型号导致的 4 倍偏差"而引入；正确解析后无需校准 |

**实测证据**（改正后在本板直接读取）：静止合矢量 **0.95—0.97 g**，三轴稳定，无需任何校准系数。

### 2. 串口解析兼容性修正（server.js）

原解析器只在**行首是 `{`** 时才解析 JSON，因此形如 `[post] {...}` 的行会被整行丢弃。已改为：

- `extractJsonObject(text)`：整行 JSON 与「日志前缀 + JSON」都能解析；
- `flattenValueObject(obj)`：把嵌套的 `value{ax,ay,az,magnitude}` 提到顶层并映射为
  `acc_x_g / acc_y_g / acc_z_g / acc_mag_g`，与扁平帧共用同一套字段映射与曲线；
- 你的回执（`type:ack`）、求助（`type:help`）、摄像头帧（`type:frame`）分支逻辑**未改动**。

这样两套固件（你的 ESP-IDF 扁平帧 / 备用 PlatformIO 帧）都能被同一平台正确解析。

### 3. 备用固件对齐主平台（board/src/main.cpp）

备用 PlatformIO 固件的串口帧改为与你平台一致的**扁平格式**：

```json
{"device":"S3EYE-GROUP01","mac":"94A9901C701C","seq":78,"ts":...,"iso":"...+0800",
 "acc_x_g":-0.6926,"acc_y_g":-0.6049,"acc_z_g":-0.3015,"acc_mag_g":0.9678,
 "rssi_dbm":-53,"heap":292524}
```

并支持你的下行命令（`GET /api/cmd`）：`collect_once` / `pause` / `resume` / `ping`，
回执用 `{"type":"ack",...}`，远程采集观测带 `request_id`。

## 三、整合验证结果

### 平台解析真实帧（板端 → 平台 → 接口）

| 项 | 实测值 |
|---|---|
| `connected` / `live` / `transport` | true / true / **serial** |
| `deviceId` | **S3EYE-GROUP01**（与 `config.json` 的 expectedDeviceId 一致） |
| `deviceVerified` | **true**（本组身份校验通过） |
| `fields` | `acc_x_g: -0.6926, acc_y_g: -0.6049, acc_z_g: -0.3015, acc_mag_g: 0.9678, rssi_dbm: -53, heap: 292524` |
| `/api/diag` | `bytesReceived: 2176`、`lines.valid: 16/16`、`invalid: 0` |
| `/api/records` | 正常落盘，含 `device_id / device_mac / transport / board_ts / skew_ms / fields` |

### 自检套件

| 测试 | 结果 | 备注 |
|---|---|---|
| `test/acceptance-test.js` | **12 / 12** | 全链路验收（自带服务，隔离端口 8096） |
| `test/help-test.js` | **26 / 26** | 教学求助闭环（自带服务） |
| `test/storage-test.js` | **19 / 19** | 持久化与停采保留 |
| `test/ws-test.js` | **9 / 9** | WebSocket 推送结构 |
| `test/parse-test.js` | **10 / 10** | 通用解析与误解析防护 |
| `test/feature-test.js` | **14 / 14** | 诊断接口 + 录制导出 |
| `test/e2e-test.js` | **14 / 14** | 数据链路与离线清空 |
| **合计** | **110 / 110** | |

说明：`feature-test` / `e2e-test` 断言的是「**未插设备**」场景（`bytesReceived=0`、有排查建议、空录制不产文件）。
板子在插着并持续上报时会必然失败——这不是回归。已用指向不存在端口的隔离配置
（`CONFIG_PATH` + `portPath: COM77`、`autoDetect: false`）公平复现该前提，两次均为满分。
建议在你的 README 里补一句：跑这两个测试前先拔掉开发板，或用隔离配置。

## 四、仍未完成 / 待你在本机确认的项

1. **ESP-IDF 固件未在本机重新编译**：本机无 ESP-IDF 工具链（`C:\Espressif` 那套在你的机器上）。
   改的是 `main.c` 里的型号常量、寄存器值、解析与换算，请在你有 IDF 的机器上
   `npm run firmware:flash` 烧录后确认：开机日志应打印
   `IMU = QMA6100P (WHO_AM_I=0x90，与官方驱动常量一致)`，且静止 `|a|` 应约 **1.0 g**（不再是 1.32 g）。
2. **4G/Wi-Fi 双链路**：本课第 14 周需要断网/恢复；本板只有 Wi-Fi，按课程备用路径处理。
3. **摄像头/LCD 未在本次验证**：属于你的扩展功能，需在你的 IDF 环境实测（本机无法编译）。
4. 备用 PlatformIO 固件已实测可用（本机完成编译烧录与端到端数据验证），可作为
   "IDF 环境不可用时的兜底通道"。

## 五、收尾修正（第二轮）

1. **备用固件不再发送 ts**：平台的 ts 被当作板端时间戳（秒），用于计算与接收时间的偏差。
   备用固件原先把 ts 填成 epoch 秒，与平台口径不一致，导致页面显示巨额「时间偏差」。
   现改为只发 iso（含时区，如 2026-09-28T12:15:17+0800）与 uptime_ms，
   页面「板端时间 / 时间偏差」显示为空（—），不再误导。
2. **页面标题的型号表述**：public/index.html 副标题由「QMA7981 加速度计」改为
   「QMA6100P 加速度计（WHO_AM_I=0x90 实测）」，与固件注释、文档口径统一。

修正后实测：deviceVerified 为 true，字段为
acc_x_g/-0.6929、acc_y_g/-0.6043、acc_z_g/-0.3、acc_mag_g/0.9672、rssi_dbm/-53、heap/292572，
页面正常渲染（截图存档 _dl/shots/final.png）。
