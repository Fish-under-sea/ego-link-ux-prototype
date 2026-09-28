# Ego Link · AI 交互原型（ego-link-ux-prototype）

《AI 交互原型与用户体验设计》课程工程（S2 实验班，18 周 × 4 学时）。
贯穿样例：**Ego Link 随身智能终端**；本仓库承载「开发板 → 服务端 → Web」最小交互闭环，并按周演进。

- 课程页：https://ai.openkub.com/courses/ai-interaction-ux/
- 开发板：**ESP32-S3-EYE**（ESP32-S3-WROOM-1-N8R8、OV2640 摄像头、ST7789 240×240 LCD、QMA6100P 六轴 IMU、板载麦克风、microSD）
- 串口：COM4（ESP32-S3 原生 USB 串口，VID:PID = 303A:1001）

## 目录

    board/    板端应用（PlatformIO + Arduino/ESP32-S3）
    server/   接收 + 存储 + 查询服务（学生自建的 VPS 角色）
    web/      操作与状态页面
    docs/     周报、测试记录、接口与状态说明

## 六单元进度

| 单元 | 周次 | 主题 | 状态 |
|---|---|---|---|
| 1 | 1—3 | 最小交互闭环与设备反馈 | 第 1—3 周已验收 |
| 2 | 4—6 | 自然语言与语音任务交互 | 未开始 |
| 3 | 7—9 | 视觉感知与事件反馈 | 未开始 |
| 4 | 10—12 | 多源状态与主动交互 | 未开始 |
| 5 | 13—15 | 端云协同与异常恢复 | 未开始 |
| 6 | 16—18 | 技术体验测试与原型迭代 | 未开始 |

## 运行方式

板端（PlatformIO）：

    cd board
    cp src/secrets.example.h src/secrets.h   # 首次：填入 Wi-Fi 与服务器地址
    pio run -t upload -t monitor

服务端 + 页面：

    python server/app.py                     # 监听 0.0.0.0:8000，同时托管 web/

浏览器打开 http://本机IP:8000/ 查看传感数据。

## 周验收记录

| 周次 | 记录 |
|---|---|
| 第 1 周 | docs/week-01-验收记录.md |
| 第 2 周 | docs/week-02-验收记录.md |
| 第 3 周 | docs/week-03-验收记录.md |

## 提交约定

**每周一个独立 commit**，顺序铁律：完成本周任务 → 当堂验证通过 → 提交本周 → 再进入下一周。
提交信息格式：feat(w0N): 中文简述。

## 安全约定

- 密钥、服务器口令、真实行踪不进源码、截图与报告（见 .gitignore）
- 摄像头按请求/事件触发，不持续拍摄；教学场景不含个人敏感信息
- 未核验的能力不写成「已通过」；模拟与回放结果必须明确标注
