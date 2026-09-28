# 第 2 周验收记录：Web 远程采集指令与执行结果反馈

- 日期：2026-09-28
- 环境：ESP32-S3-EYE 真板（ESP-IDF 固件，含 QMA6100P 修正，构建提交 2c69694）；服务端 server.js 常驻 8080；下行通道 serial 打开且 WiFi 轮询在线（channel: portOpen=true, wifiDownlink=true, kind=serial）
- 方法：脚本化当堂验证，真板在线；超时语义在隔离服务端（无设备）复验
- 配置：mockDevice=false，全程真实数据

## 一、验收结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| T2-1 | 远程采集闭环：下发 → 板端执行 → 新观测回传，状态推进到 completed | 通过 | stages=[dispatched, completed]；seq 17→18；request_id=req-20260928-141848-0001 |
| T2-1b | 观测与请求关联（request_id 回环） | 通过 | 请求对象与落盘记录一一对应（见 T2-8） |
| T2-2 | 暂停周期上报，命令通道独立保持 | 通过 | POST /api/report pause → ok=true，channel=serial |
| T2-3 | 暂停后周期帧停止（seq 冻结）且状态如实 | 通过 | 两次采样 seq=22 不变；reportPaused=true |
| T2-4 | 暂停期间点击采集仍得到新观测 | 通过 | stages=[dispatched, completed]；seq 22→23 |
| T2-5 | 恢复后周期上报继续 | 通过 | seq 22→42（10 Hz）；reportPaused=false |
| T2-6 | 连点 3 次相互独立 | 通过 | 3 个 request_id；均 completed；观测 seq=43/45/47 互不相同 |
| T2-7 | 无设备时请求按超时结束，不以旧值冒充本次结果 | 通过 | 隔离服务（8099，collectTimeoutMs=2000）：stages=[submitted, timeout]，observation=null |
| T2-8 | 远程采集观测落盘携带 request_id | 通过 | data/records.ndjson 共 12594 条，其中 5 条带 request_id，与本次 5 次请求一一对应（seq 4014/4019/4039/4041/4043） |

合计：9 / 9 通过。

## 二、对照课程当堂验证要求

- 「暂停周期上报、保持命令通道、改变设备状态后点击采集」→ T2-3 / T2-4：暂停期间 seq 冻结，采集仍返回 seq 递增的新观测。
- 「关闭设备后请求等待/超时，旧值不能改标为本次完成」→ T2-7：超时时观测为空，接口与页面不回退旧值；超时 ≠ 硬件故障。
- 「重复点击可暂禁用或逐次编号，任务必须可区分」→ T2-6：3 个独立 request_id，各自采样、各自完成。
- 「区分刷新已存数据与采集一次最新数据」→ T2-1 / T2-8：本次结果只认带本次 request_id 的观测；库中旧记录不含该 id，物理上无法冒充。

## 三、历史实测依据（原会话，存档在库）

- docs/week2-remote-collect.md：协议、mermaid 状态图与时序图、原会话实测（含关机超时、暂停采集、模拟模式标注规则）。
- 本次复验在整合后的系统上复现了相同结论，且全部为真板真实数据。

## 四、边界与说明

- 超时用例今日在隔离服务端复验（真板在线无法「关机」）；原会话的关机实测见 week2 文档。
- 验证脚本未入库（一次性当堂取证）；如需复现可按第一节表格逐项用 curl 复核，或重跑 test/acceptance-test.js（12/12，隔离端口）。
