# 服务端（第 1 周）

学生自建的最小接收 / 存储 / 查询服务，扮演课程里的「VPS」角色。

## 运行

    python server/app.py

默认监听 0.0.0.0:8000，数据写入 server/data/observations.jsonl（已 gitignore）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/observations | 板端上报一条观测记录；服务端补 received_at、server_seq |
| GET | /api/observations?limit=50&device_id=&sensor= | 查询历史记录 |
| GET | /api/stats | 首页统计：总数、最后接收时间、最大上报间隔、最新值 |
| GET | /api/health | 健康检查 |

## 记录字段（第 1 周最小集合）

板端上报：device_id、sensor、record_id、seq、status、unit、observed_at、time_quality、value{ax,ay,az,magnitude}、rssi_dbm、fw_version
服务端补充：server_seq、received_at、received_epoch

**采集时间与接收时间分开存储**：设备无可靠墙钟时 observed_at 为 uptime_ms=... 且 time_quality=uncalibrated，绝不把接收时间伪装成精确采集时间。
