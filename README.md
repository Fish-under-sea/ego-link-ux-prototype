> **🟢 活跃维护** · 最近更新：2026-09-28
>
> 课程进行中，按周增量提交。

<div align="center">

# Ego Link · AI 交互原型

**ESP32-S3-EYE → 服务端 → Web 的最小交互闭环**

《AI 交互原型与用户体验设计》课程工程 · S2 实验班 · 18 周 × 4 学时

<sub>贯穿样例：**Ego Link 随身智能终端** —— 本仓库承载它的最小可行闭环，并按周演进。</sub>

</div>

---

## 📌 这个仓库在做什么

把一块 ESP32-S3-EYE 开发板、一台服务端和一张网页接成一条**能跑通的链路**：

```
┌─────────────────────┐        ┌──────────────────┐        ┌─────────────────┐
│   ESP32-S3-EYE      │        │   服务端          │        │   Web 页面      │
│   板端采集与反馈     │ ─────► │  接收·存储·查询   │ ─────► │  操作与状态展示  │
│  （摄像头 + IMU +   │  串口/ │  （学生自建 VPS   │  HTTP  │                 │
│   LCD + 麦克风）    │  网络  │    角色）         │        │                 │
└─────────────────────┘        └──────────────────┘        └─────────────────┘
```

课程按**六个单元 / 18 周**推进，每个单元一个主题，每周一个可验证的增量。

## 🎯 六单元进度

| 单元 | 周次 | 主题 | 状态 |
|:----:|:----:|------|------|
| 1 | 1—3 | 最小交互闭环与设备反馈 | ✅ **第 1—3 周已验收** |
| 2 | 4—6 | 自然语言与语音任务交互 | 🔄 **第 4 周已验收**，进行中 |
| 3 | 7—9 | 视觉感知与事件反馈 | ⬜ 未开始 |
| 4 | 10—12 | 多源状态与主动交互 | ⬜ 未开始 |
| 5 | 13—15 | 端云协同与异常恢复 | ⬜ 未开始 |
| 6 | 16—18 | 技术体验测试与原型迭代 | ⬜ 未开始 |

## 🧰 硬件与环境

| 项 | 规格 |
|----|------|
| 开发板 | **ESP32-S3-EYE** |
| 主控 | ESP32-S3-WROOM-1-**N8R8**（8MB Flash / 8MB PSRAM） |
| 摄像头 | **OV2640** |
| 显示屏 | **ST7789** 240×240 LCD |
| 姿态传感 | **QMA6100P** 六轴 IMU |
| 音频 | 板载麦克风 |
| 存储 | microSD |
| 串口 | **COM4**（ESP32-S3 原生 USB 串口，VID:PID = `303A:1001`） |

**技术栈**：

| 层 | 实现 |
|----|------|
| 板端 | PlatformIO + Arduino/ESP32-S3 |
| 服务端 | **Python 标准库 `http.server`**（`ThreadingHTTPServer`，零第三方依赖 —— 课堂任意机器可直接运行） |
| 前端 | 原生 HTML / JS（由服务端托管，见 `web/`） |
| 辅助工具 | Node.js —— `imu-monitor`（`serialport` + `ws`，串口监视与推送） |

**`package.json` 提供的脚本**（`imu-monitor`）：

| 脚本 | 作用 |
|------|------|
| `npm start` | 启动串口监视服务 |
| `npm run ports` | 列出可用串口 |
| `npm run test` | 运行测试 |
| `npm run firmware:build` | 编译固件 |
| `npm run firmware:flash` | 烧录固件 |
| `npm run firmware:monitor` | 串口监视 |
| `npm run wifi:set` | 配置 Wi-Fi |

## 🚀 快速开始

### 1️⃣ 板端（PlatformIO）

```bash
cd board
cp src/secrets.example.h src/secrets.h   # 首次：填入 Wi-Fi 与服务器地址
pio run -t upload -t monitor
```

> `secrets.h` 已被 `.gitignore` 忽略，**不会**进入版本库 —— 凭据只留在你本机。

### 2️⃣ 服务端 + 页面

```bash
python server/app.py                     # 监听 0.0.0.0:8000，同时托管 web/
```

浏览器打开 `http://本机IP:8000/` 查看传感数据。

## 📁 目录结构

| 目录 | 作用 |
|------|------|
| `board/` | 板端应用（PlatformIO + Arduino/ESP32-S3） |
| `server/` | 接收 + 存储 + 查询服务（学生自建的 VPS 角色） |
| `web/` | 操作与状态页面 |
| `docs/` | 周报、测试记录、接口与状态说明 |
| `firmware/`、`public/`、`scripts/`、`test/` | 固件、静态资源、辅助脚本与测试 |

## 📅 周验收记录

每周的验收过程都留了档，可逐周回看：

| 周次 | 记录 |
|:----:|------|
| 第 1 周 | [`docs/week-01-验收记录.md`](docs/week-01-验收记录.md) |
| 第 2 周 | [`docs/week-02-验收记录.md`](docs/week-02-验收记录.md) |
| 第 3 周 | [`docs/week-03-验收记录.md`](docs/week-03-验收记录.md) |
| 第 4 周 | [`docs/week-04-验收记录.md`](docs/week-04-验收记录.md) |

补充文档：

- [`docs/imu-monitor-README.md`](docs/imu-monitor-README.md) —— IMU 监测说明
- [`docs/week2-remote-collect.md`](docs/week2-remote-collect.md) —— 第 2 周远程采集
- [`docs/week3-button-feedback.md`](docs/week3-button-feedback.md) —— 第 3 周按键反馈
- [`docs/经验总结-ESP32-S3-EYE.md`](docs/经验总结-ESP32-S3-EYE.md) —— 开发板踩坑经验
- [`ASSIGNMENT.md`](ASSIGNMENT.md) · [`INTEGRATION.md`](INTEGRATION.md) —— 作业要求与集成说明

## 📝 提交约定

**每周一个独立 commit**，顺序铁律：

```
完成本周任务  →  当堂验证通过  →  提交本周  →  再进入下一周
```

提交信息格式：`feat(w0N): 中文简述`

## 🔒 安全约定

- 密钥、服务器口令、真实行踪**不进**源码、截图与报告（见 `.gitignore`）
- 摄像头**按请求/事件触发**，不持续拍摄；教学场景不含个人敏感信息
- **未核验的能力不写成「已通过」**；模拟与回放结果必须明确标注

---

<sub>课程页：https://ai.openkub.com/courses/ai-interaction-ux/ · 本仓库为课程工程，按周增量提交</sub>