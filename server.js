/**
 * ESP32 传感器实时监控平台 —— 后端服务
 *
 * 设计原则（重要）：
 *   本服务【不生成、不模拟、不补插任何数据】。
 *   所有数值必须来自真实的硬件来源：
 *     1) USB 串口：ESP32 通过 Serial.println(JSON) 主动上报
 *     2) WiFi HTTP：ESP32 通过 POST /api/data 上报（可选）
 *   串口关闭 / 设备拔出 / 心跳超时 时，立刻清空前端数据并标记为离线。
 */

'use strict';

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const RECORD_DIR = path.join(ROOT, 'recordings');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'records.ndjson');

// 设备身份元数据键：出现在数据帧里、但不作为传感器数值展示
const META_KEYS = new Set(['device', 'mac', 'src', 'ver', 'ver_', 'fw', 'id',
  'imu_ok', 'imu_id', 'imu_scan']); // 板端诊断字段，仅记录不展示
// 这些键是"板端时间戳/序号"，属于元数据，不画成传感器卡片
const META_NUMERIC_KEYS = new Set(['ts', 'seq', 'uptime_ms', 'boot_ms']);

const DEFAULT_CONFIG = {
  httpPort: 8080,
  host: '0.0.0.0',   // 电脑即服务器：监听所有网卡，开发板可经局域网/WiFi 直接上报
  baudRate: 115200,
  portPath: null,        // 指定串口，如 'COM3'；null = 自动识别
  autoDetect: true,      // 自动扫描并连接 ESP32
  autoReconnect: true,   // 断开后自动重连
  scanIntervalMs: 2500,  // 离线时的端口扫描间隔
  parseMode: 'auto',     // auto|json|kv|csv —— 兼容已烧好的、输出非 JSON 的固件
  staleAfterMs: 5000,    // 超过该时间无数据 => 判定为"静默"（仍连接）
  offlineAfterMs: 15000, // 超过该时间仍无任何数据 => 判定设备已移除，清空并重新扫描
  wifiTimeoutMs: 8000,   // WiFi 上报的心跳超时
  historyMax: 600,       // 前端图表的历史点数上限（由后端下发限制）
  // ---- 远程采集（第 2 周）----
  mockDevice: false,     // true = 模拟板端（服务端自答回执与观测），仅供无板联调；
                         //        所有模拟结果都会带 simulated 标记，绝不冒充实物命令
  collectTimeoutMs: 8000,// 下发采集命令后，多久没等到新观测判超时
  // ---- 持久化存储（作业要求：VPS 原始记录可查）----
  storageEnabled: true,  // 是否把每一帧真实数据落盘为 NDJSON，便于核对"一帧观测对应一条记录"
  storageMaxMb: 32,       // 单个记录文件超过该大小后滚动归档
  // ---- 停采策略（作业要求：停采后保留旧时间与值，提示"未更新"）----
  //   keep  = 超时/停采后保留最后一次真实值与旧时间，前端显示"未更新"（课程默认）
  //   clear = 超时超过 offlineAfterMs 后判定离线并清空（满足"拔线即无数据"原始要求）
  //   无论哪种：物理拔线（串口 disconnected 事件）或手动释放串口，必定清空。
  stalePolicy: 'keep',
  // ---- 本组设备身份校验（作业要求：核对数据来自"本组"设备，避免邻组数据混显）----
  //   设为固件里的 DEVICE_ID（如 "S3EYE-GROUP01"）后，平台会校验每帧上报的 device 是否匹配；
  //   不匹配则标记 deviceVerified=false，前端给出"⚠ 非本组设备"提示，但不丢弃（便于排查）。
  //   null = 不校验（接受任意设备，适合调试）。
  expectedDeviceId: null,
  // 单位与显示名映射（未列出的字段按原始 key 显示）
  fieldUnits: {
    temp_c: '°C', temperature: '°C', temp: '°C',
    humidity: '%', pressure: 'hPa', altitude: 'm',
    voltage: 'V', lux: 'lx', rssi: 'dBm', uptime: 's',
    hall: '', adc0: '', adc1: '', adc: '',
  },
  fieldLabels: {
    temp_c: '芯片温度', temperature: '温度', humidity: '湿度',
    pressure: '气压', altitude: '海拔',
    adc0: 'ADC0 (GPIO34)', adc1: 'ADC1 (GPIO35)', adc: 'ADC 原始值',
    voltage: '电压', hall: '霍尔传感器', lux: '光照度',
    rssi: 'WiFi 信号强度', uptime: '运行时长', millis: '运行时间',
  },
};

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      for (const k of Object.keys(user)) {
        if (k === 'fieldUnits' || k === 'fieldLabels') {
          cfg[k] = Object.assign({}, cfg[k], user[k] || {});
        } else if (user[k] !== undefined && user[k] !== null) {
          cfg[k] = user[k];
        }
      }
    }
  } catch (e) {
    console.warn('[config] 读取失败，使用默认配置：', e.message);
  }
  return cfg;
}

function saveConfig() {
  try {
    // 防止环境变量覆盖（PORT/HOST）污染持久化文件：
    // 保存时恢复文件原始值，只在运行时使用环境变量值。
    const toSave = { ...config };
    if (process.env.PORT !== undefined) toSave.httpPort = _fileConfig.httpPort;
    if (process.env.HOST !== undefined) toSave.host = _fileConfig.host;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('[config] 保存失败：', e.message);
    return false;
  }
}

let config = loadConfig();

// 快照文件原始配置（env 覆盖不会写入文件）
const _fileConfig = JSON.parse(JSON.stringify(config));

// 环境变量覆盖：部署 VPS 或并行测试时可设 PORT=8099 / HOST=0.0.0.0 改变监听
if (process.env.PORT) config.httpPort = Number(process.env.PORT) || config.httpPort;
if (process.env.HOST) config.host = process.env.HOST;

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */

const state = {
  connected: false,     // 是否有真实硬件在线
  live: false,          // 是否在"实时流动"状态（区别于停采保留）
  transport: null,      // 'serial' | 'wifi'
  device: null,         // 设备描述信息（串口路径 / WiFi IP）
  deviceId: null,       // 设备身份标识（来自固件上报的 device 字段，用于"核对数据来自本组设备"）
  deviceMac: null,      // 设备 MAC（辅助身份核对）
  deviceVerified: null, // 是否通过本组身份校验（expectedDeviceId 为空或匹配时为 true）
  lastDataAt: null,     // 最近一次收到真实数据的时间戳（服务端接收时刻）
  boardTs: null,        // 最近一次数据帧里的板端时间戳（毫秒，UTC）
  boardIso: null,       // 最近一次数据帧里的板端 ISO 时间
  seq: null,            // 板端自增序号（用于核对不丢帧）
  fields: {},           // 最新的真实字段值 { key: number }
  wifiSource: null,     // WiFi 上报来源 { ip }
  reportPaused: false,  // 周期上报是否被远程命令暂停（命令通道保持可用）
  camStreaming: false,  // 板端是否正在推摄像头画面
};

let port = null;            // 当前 SerialPort 实例
let lineBuffer = '';        // 串口行缓冲
let scanTimer = null;
let manualClose = false;    // 是否是用户主动断开
let openingPath = null;     // 正在打开的端口，防重入
let portOpenedAt = null;    // 端口打开时刻（用于判断"开了但一直没数据"）
const rawLog = [];          // 最近若干条原始上报（仅真实数据）
const RAW_LOG_MAX = 200;

// 真实数据录制（只写入设备实际上报的采样，不生成任何数据）
const recording = { active: false, rows: [], startedAt: null, maxRows: 200000 };

function writeRecording() {
  if (!recording.rows.length) return null;
  if (!fs.existsSync(RECORD_DIR)) fs.mkdirSync(RECORD_DIR, { recursive: true });

  const keys = [];
  const seen = new Set();
  for (const r of recording.rows) {
    for (const k of Object.keys(r.f)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  const esc = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['timestamp_ms', 'iso_time', ...keys].join(',');
  const lines = recording.rows.map((r) =>
    [r.ts, new Date(r.ts).toISOString(), ...keys.map((k) => (r.f[k] !== undefined ? esc(r.f[k]) : ''))].join(',')
  );
  const stamp = new Date(recording.startedAt || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `esp32_${stamp}.csv`;
  // ﻿：BOM，保证 Excel 打开中文不乱码
  fs.writeFileSync(path.join(RECORD_DIR, name), '\uFEFF' + [header, ...lines].join('\n'), 'utf8');
  return name;
}

// ------------------------------------------------------------------ //
// 持久化存储：把每一帧真实数据落盘为 NDJSON，供 VPS 原始记录核对        //
// 仅写入设备实际上报的采样，绝不生成/补插任何数据。                     //
// ------------------------------------------------------------------ //

let nlAssist = null;   // 第 4 周：自然语言助手（见 nl_assistant.js）
let storageSeq = 0; // 服务端自增序号，与板端 seq 区分

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 追加一条真实采样记录到 NDJSON 文件（同步、简单、足够课程演示） */
function appendRecord(rec) {
  if (!config.storageEnabled) return;
  try {
    ensureDataDir();
    // 文件过大则滚动归档，避免单文件无限增长
    if (fs.existsSync(RECORDS_FILE)) {
      const sz = fs.statSync(RECORDS_FILE).size;
      if (sz > config.storageMaxMb * 1024 * 1024) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        fs.renameSync(RECORDS_FILE, path.join(DATA_DIR, `records.${ts}.ndjson`));
      }
    }
    fs.appendFileSync(RECORDS_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    console.error('[storage] 写入失败：', e.message);
  }
}

/** 读取并筛选 NDJSON 记录。返回数组（默认按接收时间倒序） */
function readRecords({ device = null, limit = 200, since = null, until = null, order = 'desc' } = {}) {
  if (!config.storageEnabled || !fs.existsSync(RECORDS_FILE)) return [];
  const out = [];
  const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n');
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch (_) { continue; }
    if (device && r.device_id !== device) continue;
    if (since != null && (r.recv_ts || 0) < since) continue;
    if (until != null && (r.recv_ts || 0) > until) continue;
    out.push(r);
  }
  out.sort((a, b) => (order === 'asc' ? (a.recv_ts || 0) - (b.recv_ts || 0) : (b.recv_ts || 0) - (a.recv_ts || 0)));
  if (limit && limit > 0 && out.length > limit) out.length = limit;
  return out;
}

/** 列出所有出现过的设备：计数、首次/末次出现、末次板端时间 */
function listDevices() {
  if (!config.storageEnabled || !fs.existsSync(RECORDS_FILE)) return [];
  const map = new Map();
  const lines = fs.readFileSync(RECORDS_FILE, 'utf8').split('\n');
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch (_) { continue; }
    const id = r.device_id || '(unknown)';
    let e = map.get(id);
    if (!e) { e = { device_id: id, count: 0, first_recv: r.recv_ts, last_recv: r.recv_ts, last_board: r.board_ts || null, transport: r.transport || null }; map.set(id, e); }
    e.count++;
    if (r.recv_ts > e.last_recv) { e.last_recv = r.recv_ts; e.last_board = r.board_ts || e.last_board; e.transport = r.transport || e.transport; }
    if (r.recv_ts < e.first_recv) e.first_recv = r.recv_ts;
  }
  return Array.from(map.values()).sort((a, b) => b.last_recv - a.last_recv);
}

// 链路统计，仅用于诊断，不参与任何数据展示
const stats = {
  bytesReceived: 0,
  linesTotal: 0,
  linesValid: 0,
  linesInvalid: 0,
  lastError: null,
  lastOpenError: null,
  startedAt: Date.now(),
};

/* ------------------------------------------------------------------ */
/* WebSocket 广播                                                      */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

/* ------------------------------------------------------------------ */
/* 远程采集请求（第 2 周）：请求 → 设备回执 → 新观测                    */
/*                                                                     */
/* 证明「是新采集、不是库里旧值」的四条证据：                            */
/*   ① request_id 回环：服务端生成 → 下发 → 板端原样回传；               */
/*      库里旧记录没有这个 id，物理上无法冒充                            */
/*   ② 板端 seq 严格递增：观测的 seq 必须大于下发前的 seq                 */
/*   ③ 时间先后：观测到达时刻必须晚于下发时刻                            */
/*   ④ 前端只认 request_id：只展示带该 id 的观测，绝不读库里最后一条       */
/* ------------------------------------------------------------------ */
const REQUESTS = new Map();          // request_id -> request
const REQUEST_KEEP = 50;             // 内存中保留最近 N 条
const collectTimeoutMs = () => config.collectTimeoutMs || 8000;   // 下发后多久没等到新观测 → 超时
let requestCounter = 0;

function newRequestId() {
  requestCounter = (requestCounter % 9999) + 1;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `req-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-${String(requestCounter).padStart(4, '0')}`;
}

function publicRequest(r) {
  return {
    request_id: r.request_id,
    device_id: r.device_id,
    status: r.status,                 // submitted|dispatched|acked|completed|failed|timeout
    simulated: !!r.simulated,
    created_at: r.created_at,
    dispatched_at: r.dispatched_at || null,
    acked_at: r.acked_at || null,
    completed_at: r.completed_at || null,
    timeout_at: r.timeout_at || null,
    ack_status: r.ack_status || null,
    channel: r.channel || null,       // serial | wifi —— 命令走的是哪条下行通道
    seq_before: r.seq_before ?? null,
    seq_observed: r.seq_observed ?? null,
    observation: r.observation || null,
    error: r.error || null,
    note: r.note || null,
  };
}

function pushRequest(r) { broadcast({ type: 'collect', request: publicRequest(r) }); }

function trimRequests() {
  while (REQUESTS.size > REQUEST_KEEP) REQUESTS.delete(REQUESTS.keys().next().value);
}

function recentRequests(n = 20) {
  return [...REQUESTS.values()].slice(-n).reverse().map(publicRequest);
}

/* ------------------------------------------------------------------ */
/* 下行命令：两条通道                                                    */
/*                                                                     */
/*   ① 串口（首选，低延迟）：板子插着 USB 时直接写串口                    */
/*   ② WiFi 轮询（兜底）：板子是纯 HTTP 客户端，服务端连不上它，           */
/*      因此把命令放进队列，等板端 GET /api/cmd 来取（默认 400ms 一次）   */
/*                                                                     */
/* 两者互斥：串口在线时只写串口、队列为空，板端来取也拿不到东西，         */
/* 因此不会重复执行。板子拔掉 USB 后，闭环仍能完整跑通。                  */
/* ------------------------------------------------------------------ */
const CMD_QUEUE_MAX = 20;
const CMD_TTL_MS = 15000;      // 超过 15s 没被取走就作废，避免陈旧命令突然执行
const cmdQueue = [];           // { id, obj, device, queued_at, ttl }
let cmdSeq = 0;

function queueCommand(obj, device) {
  const item = { id: ++cmdSeq, obj, device: device || null, queued_at: Date.now(), ttl: CMD_TTL_MS };
  cmdQueue.push(item);
  while (cmdQueue.length > CMD_QUEUE_MAX) cmdQueue.shift();
  return item;
}

function dropExpiredCommands() {
  const now = Date.now();
  while (cmdQueue.length && now - cmdQueue[0].queued_at > cmdQueue[0].ttl) cmdQueue.shift();
}

/* 板端来取命令：返回一条匹配本设备的命令，没有则 null */
function takeCommand(device) {
  dropExpiredCommands();
  if (!cmdQueue.length) return null;
  const i = cmdQueue.findIndex((c) => !c.device || !device || c.device === device);
  if (i < 0) return null;
  return cmdQueue.splice(i, 1)[0];
}

/* WiFi 下行是否"活着"：板端最近 2 秒内来取过命令 */
function wifiDownlinkActive() {
  return !!stats.lastCmdPollAt && (Date.now() - stats.lastCmdPollAt) < 2000;
}

/* 下发一行命令。
 * 返回 true = 【当前确实能送达】（串口写出成功，或板端正通过 WiFi 轮询来取）。
 * 串口不在线时命令仍会入队，这样板端一旦上线就能取走，不会丢；
 * 但若板端当前并未轮询，则返回 false —— 调用方据此如实提示"未送达"，
 * 绝不在没有任何送达证据时声称已下发。 */
function sendCommand(obj, device) {
  if (config.mockDevice) return false;       // 模拟模式不走真实通道
  if (port && port.isOpen) {
    try {
      port.write(JSON.stringify(obj) + '\n', (err) => {
        if (err) stats.lastError = String(err.message || err);
      });
      stats.cmdSent = (stats.cmdSent || 0) + 1;
      stats.cmdViaSerial = (stats.cmdViaSerial || 0) + 1;
      return true;
    } catch (e) {
      stats.lastError = String(e.message || e);
      return false;
    }
  }
  // 串口不在线 → 入队，等板端经 WiFi 来取
  queueCommand(obj, device);
  stats.cmdViaWifi = (stats.cmdViaWifi || 0) + 1;
  return wifiDownlinkActive();
}

/* 创建一次采集请求并下发 */
function createCollectRequest() {
  const r = {
    request_id: newRequestId(),
    device_id: state.deviceId || null,
    status: 'submitted',
    created_at: Date.now(),
    seq_before: state.seq ?? null,
    simulated: false,
  };
  REQUESTS.set(r.request_id, r);
  trimRequests();
  pushRequest(r);

  const sent = sendCommand({ cmd: 'collect_once', request_id: r.request_id }, r.device_id);
  if (sent) {
    r.status = 'dispatched';
    r.dispatched_at = Date.now();
    r.channel = (port && port.isOpen) ? 'serial' : 'wifi';
    r.timer = setTimeout(() => onRequestTimeout(r.request_id), collectTimeoutMs());
  } else if (config.mockDevice) {
    // 模拟板端：明确标注 simulated，绝不冒充实物命令
    r.simulated = true;
    r.status = 'dispatched';
    r.dispatched_at = Date.now();
    r.note = '模拟模式：未走真实串口，由服务端自答回执与观测（仅供联调/演示）';
    r.timer = setTimeout(() => onRequestTimeout(r.request_id), collectTimeoutMs());
    mockDeviceReply(r.request_id);
  } else {
    // 命令通道不可用（设备关闭 / 串口未连接）：
    // 不伪造完成，也不立刻判死 —— 按作业要求「请求等待 / 超时」处理，
    // 但立刻给出原因提示，避免用户干等。
    r.status = 'submitted';
    r.error = '命令通道不可用（串口未打开，开发板也未在轮询）';
    r.note = '已提交，但命令尚未送达设备（串口未打开、开发板也未通过 WiFi 取命令）。命令已入队，若开发板在 15 秒内上线会被取走；否则按超时处理。超时≠硬件故障。';
    r.timer = setTimeout(() => onRequestTimeout(r.request_id), collectTimeoutMs());
  }
  pushRequest(r);
  return r;
}

/* 模拟板端：先回执，再给一条带 request_id 的观测（明确标注模拟） */
function mockDeviceReply(request_id) {
  setTimeout(() => onDeviceAck(request_id, 'received', state.seq, true), 300);
  setTimeout(() => {
    const r = REQUESTS.get(request_id);
    if (!r || r.status === 'completed' || r.status === 'timeout') return;
    const f = state.fields || {};
    const obsFields = {
      acc_x_g: f.acc_x_g ?? null, acc_y_g: f.acc_y_g ?? null, acc_z_g: f.acc_z_g ?? null,
      temp_c: f.temp_c ?? null,
    };
    onObservation(request_id, obsFields, Date.now(), (state.seq || 0) + 1, true);
  }, 900);
}

/* 板端回执 */
function onDeviceAck(request_id, status, seq, simulated) {
  /* 板端回执：求助相关（help-*）路由到求助模块，不进采集请求表 */
  if (typeof request_id === 'string' && request_id.startsWith('help-')) {
    onHelpAck(request_id, status);
    return;
  }
  const r = REQUESTS.get(request_id);
  if (!r) return;
  if (r.status === 'completed' || r.status === 'timeout' || r.status === 'failed') return;
  r.status = 'acked';
  r.acked_at = Date.now();
  r.ack_status = status || 'received';
  if (simulated) r.simulated = true;
  if (typeof seq === 'number') r.ack_seq = seq;
  pushRequest(r);
}

/* 收到带 request_id 的观测 —— 这才是「新采集」的实证 */
function onObservation(request_id, fields, recvTs, seqOverride, simulated) {
  const r = REQUESTS.get(request_id);
  if (!r) return;
  if (r.status === 'completed' || r.status === 'timeout') return;
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }

  const seq = typeof seqOverride === 'number' ? seqOverride
    : (typeof state.seq === 'number' ? state.seq : null);
  const dispatched = r.dispatched_at || r.created_at;
  const checks = {
    arrived_after_dispatch: recvTs >= dispatched,
    seq_increased: (r.seq_before == null || seq == null) ? null : seq > r.seq_before,
  };

  r.status = 'completed';
  r.completed_at = recvTs;
  r.seq_observed = seq;
  r.observation = { recv_ts: recvTs, seq, fields, checks };
  if (simulated) r.simulated = true;
  pushRequest(r);
}

/* 超时：不把旧值标成本次完成，也不判定硬件故障 */
function onRequestTimeout(request_id) {
  const r = REQUESTS.get(request_id);
  if (!r || r.status === 'completed') return;
  r.timer = null;
  r.status = 'timeout';
  r.timeout_at = Date.now();
  r.note = '未在限定时间内收到本次新观测。超时≠硬件故障，也不代表旧值有效。';
  pushRequest(r);
}

/* ------------------------------------------------------------------ */
/* 教学求助（第 3 周）：按键 → 本地反馈 → 远端显示 → 回应 / 取消        */
/*                                                                     */
/* 当堂验证的两条硬指标，靠这里的数据流保证：                            */
/*   ① 本地确认不依赖网络：板端 LED/LCD 在按下瞬间就变，与本模块无关；   */
/*      本模块只记录「服务端确实收到了求助事件」这一事实。                */
/*   ② 无远端接收证据不得显示「对方已收到」：                            */
/*      - 服务端只有【真正收到】板端 help 事件，才把状态置为 received；   */
/*      - 网页只有【命令确实写出串口】才显示「回应已下发」；              */
/*      - 板端只有【收到 viewer_ack 命令】才显示「对方已收到」；          */
/*      - 板端回执 ack_shown 回来后，才把 ack_delivered 标为 true。       */
/* ------------------------------------------------------------------ */
const HELP_KEEP = 20;
const help = {
  active: false,
  help_id: null,
  device_id: null,
  status: 'idle',          // idle | received | acknowledged | cancelled
  event: null,             // request | cancel
  received_at: null,       // 服务端收到求助的时刻
  board_ts: null,          // 板端时间戳（毫秒 UTC）
  seq: null,               // 板端序号
  ack_sent_at: null,       // 网页点「已收到」的时刻
  ack_channel_ok: null,    // 回应命令是否成功写出串口
  ack_delivered: null,     // 板端回执确认已显示（true/false/null=等待）
  cancelled_at: null,
  note: null,
  history: [],             // 最近 N 条事件（时间 + 事件名）
};

function publicHelp() {
  return {
    active: help.active,
    help_id: help.help_id,
    device_id: help.device_id,
    status: help.status,
    event: help.event,
    received_at: help.received_at,
    board_ts: help.board_ts,
    seq: help.seq,
    ack_sent_at: help.ack_sent_at,
    ack_channel_ok: help.ack_channel_ok,
    ack_channel: help.ack_channel || null,   // serial | wifi
    ack_delivered: help.ack_delivered,
    cancelled_at: help.cancelled_at,
    note: help.note,
    history: help.history.slice(-HELP_KEEP),
    mockDevice: !!config.mockDevice,
    // 下行是否可用：串口在线，或板端正通过 WiFi 轮询来取命令
    channelReady: !!(port && port.isOpen) || wifiDownlinkActive(),
    channelKind: (port && port.isOpen) ? 'serial' : (wifiDownlinkActive() ? 'wifi' : null),
    pendingCommands: cmdQueue.length,
  };
}

function pushHelp() { broadcast({ type: 'help', help: publicHelp() }); }

function helpLog(ev, detail) {
  help.history.push({ at: Date.now(), ev, detail: detail || null });
  if (help.history.length > HELP_KEEP) help.history.shift();
}

/** 板端上报的求助事件（request / cancel）—— 这是「远端接收」的唯一证据来源 */
function onHelpEvent(obj) {
  const ev = obj.event === 'cancel' ? 'cancel' : 'request';
  if (ev === 'request') {
    help.active = true;
    help.help_id = obj.help_id || null;
    help.device_id = obj.device || state.deviceId || null;
    help.status = 'received';
    help.event = 'request';
    help.received_at = Date.now();
    help.board_ts = typeof obj.ts === 'number' ? obj.ts : null;
    help.seq = typeof obj.seq === 'number' ? obj.seq : null;
    help.ack_sent_at = null; help.ack_channel_ok = null; help.ack_delivered = null;
    help.cancelled_at = null;
    help.note = '已收到板端求助 —— 这是「远端接收」的证据。等待查看者回应。';
    helpLog('received', obj.help_id);
    console.log(`[help] 收到求助 ${obj.help_id} ← ${help.device_id}`);
  } else {
    help.active = false;
    help.status = 'cancelled';
    help.event = 'cancel';
    help.cancelled_at = Date.now();
    help.note = '佩戴者已取消求助（板端本地已显示「已取消」）。';
    helpLog('cancelled', obj.help_id);
    console.log(`[help] 收到取消 ${obj.help_id}`);
  }
  pushHelp();
}

/** 网页回应：把 viewer_ack 下发到板端 */
function createHelpAck() {
  if (!help.active || help.status === 'cancelled') {
    return { ok: false, note: '当前没有待回应的求助。' };
  }
  const rid = help.help_id || `help-${Date.now()}`;
  const ok = sendCommand({ cmd: 'viewer_ack', request_id: rid }, help.device_id);
  help.ack_sent_at = Date.now();
  help.ack_channel_ok = ok;
  help.ack_channel = ok ? ((port && port.isOpen) ? 'serial' : 'wifi') : null;
  if (ok) {
    help.status = 'acknowledged';
    help.ack_delivered = null;   // 等板端回执
    help.note = '回应已下发到设备，等待板端回执确认显示。';
    helpLog('ack_sent', rid);
  } else if (config.mockDevice) {
    help.status = 'acknowledged';
    help.ack_delivered = null;
    help.note = '模拟模式：回应未走真实串口（仅供联调，不代表板端已显示）。';
    helpLog('ack_mock', rid);
  } else {
    help.status = 'received';    // 未送达 → 状态不前进
    help.note = '⚠ 回应尚未送达设备（串口未打开，开发板也未在轮询）。命令已入队，若开发板在 15 秒内上线会被取走；在此之前板端不会显示「对方已收到」。';
    helpLog('ack_failed', rid);
  }
  pushHelp();
  return { ok, note: help.note };
}

/** 网页取消 */
function createHelpCancel() {
  if (!help.active && help.status === 'idle') {
    return { ok: false, note: '当前没有进行中的求助。' };
  }
  const rid = help.help_id || `help-${Date.now()}`;
  const ok = sendCommand({ cmd: 'help_cancel', request_id: rid }, help.device_id);
  help.status = 'cancelled';
  help.active = false;
  help.cancelled_at = Date.now();
  help.note = ok ? '查看者已取消，取消命令已下发到设备。'
                 : '已标记取消（命令通道不可用，板端未收到取消命令）。';
  helpLog('cancel_sent', rid);
  pushHelp();
  return { ok, note: help.note };
}

/** 板端回执：确认「对方已收到」是否真的已在板端显示 */
function onHelpAck(help_id, status) {
  if (help.help_id && help_id && help.help_id !== help_id) return;
  if (status === 'ack_shown') {
    help.ack_delivered = true;
    help.status = 'acknowledged';
    help.note = '板端已回执：屏幕已显示「对方已收到」。';
    helpLog('ack_delivered', help_id);
  } else if (status === 'no_active_help') {
    help.ack_delivered = false;
    help.note = '板端回执：当前没有进行中的求助，未显示「对方已收到」。';
    helpLog('ack_rejected', help_id);
  } else if (status === 'cancelled') {
    helpLog('cancel_delivered', help_id);
  }
  pushHelp();
}

function resetHelp() {
  help.active = false; help.help_id = null; help.status = 'idle'; help.event = null;
  help.received_at = null; help.board_ts = null; help.seq = null;
  help.ack_sent_at = null; help.ack_channel_ok = null; help.ack_delivered = null;
  help.cancelled_at = null; help.note = null;
  helpLog('reset', null);
  pushHelp();
}

function pushStatus(reason) {
  broadcast({
    type: 'status',
    connected: state.connected,
    live: state.live,           // true=实时流动；false=停采保留（保留旧值旧时间）
    portOpen: !!(port && port.isOpen),
    wifiDownlink: wifiDownlinkActive(),   // 板端正通过 WiFi 轮询取命令
    downlinkKind: (port && port.isOpen) ? 'serial' : (wifiDownlinkActive() ? 'wifi' : null),
    transport: state.transport,
    device: state.device,
    deviceId: state.deviceId,   // 设备身份标识（核对数据来自本组设备）
    deviceMac: state.deviceMac,
    deviceVerified: state.deviceVerified, // 是否通过本组身份校验
    expectedDeviceId: config.expectedDeviceId,
    lastDataAt: state.lastDataAt,
    boardTs: state.boardTs,     // 板端时间戳（毫秒 UTC）
    boardIso: state.boardIso,
    seq: state.seq,
    reportPaused: !!state.reportPaused,
    stale: isStale(),
    stalePolicy: config.stalePolicy,
    config: {
      portPath: config.portPath,
      baudRate: config.baudRate,
      autoDetect: config.autoDetect,
      autoReconnect: config.autoReconnect,
      storageEnabled: config.storageEnabled,
    },
    serverTime: Date.now(),
    reason: reason || null,
  });
}

function isStale() {
  if (!state.connected || !state.live || !state.lastDataAt) return false;
  return Date.now() - state.lastDataAt > config.staleAfterMs;
}

/** 离线 -> 清空全部数据（关键：拔出开发板/手动释放后不再显示任何值） */
function goOffline(reason) {
  state.connected = false;
  state.live = false;
  state.transport = null;
  state.device = null;
  state.deviceId = null;
  state.deviceMac = null;
  state.deviceVerified = null;
  state.lastDataAt = null;
  state.boardTs = null;
  state.boardIso = null;
  state.seq = null;
  state.fields = {};
  state.wifiSource = null;
  broadcast({ type: 'cleared', reason: reason || 'disconnected' });
  pushStatus(reason);
}

/**
 * 停采/静默 -> 保留最后一次真实值与旧时间，仅标记"未更新"。
 * 与 goOffline 的区别：不清空数值，前端据此显示"停采保留"状态。
 */
function goStale(reason) {
  state.live = false;
  broadcast({ type: 'stale', reason: reason || 'no-data-timeout', lastDataAt: state.lastDataAt, boardTs: state.boardTs });
  pushStatus(reason);
}

/* ------------------------------------------------------------------ */
/* 数据处理                                                            */
/* ------------------------------------------------------------------ */

/* 原始日志的 WS 广播做批量合并。
 *
 * 性能要点：每收到一帧都会有一条原始日志，若逐条广播，10Hz 下就是每秒 10 条
 * WS 消息（内容还与 sample 消息重复）。合并成每 250ms 一批后，消息数降到约 1/4，
 * 客户端也能一次性批量写 DOM，避免逐条 append 造成的重排。 */
let rawBatch = [];
let rawBatchTimer = null;
const RAW_BATCH_MS = 250;

function pushRaw(text, ok) {
  if (!ok) stats.lastError = text;
  rawLog.push({ ts: Date.now(), text, ok: !!ok });
  if (rawLog.length > RAW_LOG_MAX) rawLog.shift();

  rawBatch.push({ ts: Date.now(), text, ok: !!ok });
  if (!rawBatchTimer) {
    rawBatchTimer = setTimeout(() => {
      rawBatchTimer = null;
      const items = rawBatch;
      rawBatch = [];
      if (items.length) broadcast({ type: 'raw-batch', items });
    }, RAW_BATCH_MS);
  }
}

/**
 * 以指定波特率打开串口监听一小段时间，返回收到的字节数与前几行文本。
 * 只读探测，用于排查"板子插着但没数据"。
 */
function probeOnce(target, baudRate, ms) {
  return new Promise((resolve) => {
    let p;
    try {
      p = new SerialPort({ path: target, baudRate, autoOpen: false });
    } catch (e) {
      return resolve({ baudRate, error: e.message, bytes: 0, sample: [] });
    }
    let bytes = 0, buf = '', finished = false;
    const done = (extra) => {
      if (finished) return;
      finished = true;
      try { p.removeAllListeners(); } catch (_) {}
      try { if (p.isOpen) p.close(() => {}); } catch (_) {}
      resolve(Object.assign({
        baudRate, bytes,
        sample: buf.split('\n').map((s) => s.replace(/\r$/, '')).filter(Boolean).slice(0, 5),
      }, extra || {}));
    };
    p.on('data', (c) => { bytes += c.length; if (buf.length < 2000) buf += c.toString('utf8'); });
    p.on('error', (e) => done({ error: e.message }));
    p.open((err) => {
      if (err) return done({ error: err.message });
      setTimeout(() => done(), ms);
    });
  });
}

/**
 * 处理一行来自设备的文本，尝试解析为 JSON 传感器数据。
 * 只有解析成功且至少包含一个数值字段，才算"真实数据"。
 */
/**
 * 从 "键=值" / "键: 值" 形式的文本中提取数值。
 * 适配已经烧好的、输出非 JSON 格式的固件，例如：
 *   Temp=25.3,Hum=60.1
 *   Temp: 25.3 C  Hum: 60.1 %
 *   temperature:26.5 humidity:58.2
 * 只提取设备真实发来的数字，不做任何补值或换算。
 */
function tryKeyValue(line) {
  // 两个排除条件，缺一不可：
  //   (?![\d.])   —— 数字必须完整匹配，防止 "12:34:56" 回溯成只吃到一个 "1"
  //   (?!\s*:\d)  —— 后面紧跟 ":数字" 的是时间戳，不是传感器值
  const re = /([A-Za-z_一-龥][\w.一-龥]*)\s*[:=]\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\d.])(?!\s*:\d)/g;
  const out = {};
  let m;
  while ((m = re.exec(line)) !== null) {
    const v = Number(m[2]);
    if (Number.isFinite(v)) out[m[1]] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** 纯数字序列（CSV），按 ch1..chN 命名。仅在 parseMode 显式设为 csv 时启用。 */
function tryCsv(line) {
  const nums = [];
  for (const tok of line.split(/[,;\t]+/)) {
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*[A-Za-z%℃µ°]*$/.exec(tok.trim());
    if (m) nums.push(Number(m[1]));
  }
  if (!nums.length) return null;
  const out = {};
  nums.forEach((v, i) => { out['ch' + (i + 1)] = v; });
  return out;
}

/**
 * 处理一行来自设备的文本，尝试解析为传感器数据。
 * 只有解析成功且至少包含一个数值字段，才算"真实数据"。
 *
 * @param {string} line   一行原始文本
 * @param {object} [source] 来源上下文：{ transport:'serial'|'wifi', ip?:string }
 */
/* ------------------------------------------------------------------ */
/* 摄像头（OV2640）：板端把 JPEG 以 base64 内联在 JSON 里上报            */
/*                                                                     */
/*   {"type":"frame","device":"...","seq":N,"size":"320x240",           */
/*    "len":6076,"jpeg":"<base64>"}                                    */
/*                                                                     */
/* 服务端只保留最近一帧，并向所有 MJPEG 订阅者推送。                     */
/* 之所以用 MJPEG 而不是 WebSocket：浏览器 <img src="/api/cam.mjpg">    */
/* 原生支持 multipart/x-mixed-replace，零 JS 即可显示实时画面。          */
/* ------------------------------------------------------------------ */
const cam = {
  latest: null,      // Buffer：最近一帧 JPEG（直播流）
  latestAt: 0,
  latestSeq: 0,
  size: null,
  frames: 0,
  clients: new Set(),// MJPEG 订阅者
  // 手动抓拍的单张快照（与直播流分开存，页面上单独展示、可下载）
  snapshot: null,
  snapshotAt: 0,
  snapshotSize: null,
  snapshotBytes: 0,
};

/* 从 JPEG 字节流里解析真实宽高（SOF0/1/2 段）。
 * 为什么要这么做：实测板端 set_framesize(QVGA) 后 sensor->status 仍报 320x240，
 * 而实际输出是 240x240 —— 与其信上报值，不如直接读字节，永远不会谎报。 */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xC0 || m === 0xC1 || m === 0xC2) {
      return { h: (buf[i + 5] << 8) | buf[i + 6], w: (buf[i + 7] << 8) | buf[i + 8] };
    }
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len <= 0) break;
    i += 2 + len;
  }
  return null;
}

function onCameraFrame(obj) {
  if (typeof obj.jpeg !== 'string' || !obj.jpeg.length) return;
  let buf;
  try { buf = Buffer.from(obj.jpeg, 'base64'); } catch (_) { return; }
  if (!buf.length) return;

  const sz = jpegSize(buf);
  cam.latest    = buf;
  cam.latestAt  = Date.now();
  cam.latestSeq = obj.seq || 0;
  cam.size      = sz ? `${sz.w}x${sz.h}` : (obj.size || null);
  cam.bytes     = buf.length;
  cam.frames++;

  // 手动抓拍：单独存一份快照，页面上与直播流分开展示（可下载）
  if (obj.shot === 1 || obj.shot === true) {
    cam.snapshot      = buf;
    cam.snapshotAt    = Date.now();
    cam.snapshotSize  = cam.size;
    cam.snapshotBytes = buf.length;
  }

  // 推给所有正在观看的浏览器（直播流不含快照帧，避免抓拍瞬间画面尺寸突变）
  for (const res of cam.clients) {
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      res.write(buf);
      res.write('\r\n');
    } catch (_) { cam.clients.delete(res); }
  }
}

/* ------------------------------------------------------------------
 * 双通道去重（安全网）
 *
 * 背景：板端每一帧同时走两条路上报 —— printf → USB 串口，http_post → WiFi。
 * 两路都连着时，服务端本可能收到同一帧两次，破坏「一帧观测 = 一条记录」。
 *
 * 现状（2026-09-28 实测）：/api/data 里已有一条「串口优先」规则
 * （串口在线时忽略 WiFi 上报），受控 A/B 测试显示它已经足够：
 *     纯 WiFi 95 条/12 秒  vs  双通道 92 条/12 秒（比值 0.97）
 * 因此本去重当前不会触发，属于**额外保险**，而非必需项。
 *
 * 那为什么还留着：那条规则依赖 state.transport 这个共享可变标志 ——
 * 串口刚重连的一瞬间，transport 还停留在 'wifi'，此时到达的 WiFi 帧会被
 * 放行；等串口帧把它改回 'serial' 之后才恢复拦截。这个竞态窗口内就可能
 * 产生重复。本函数以不可变的 (device, seq) 为键，与标志位无关，能兜住它。
 *
 * 窗口取 5 秒：足以覆盖两路之间的到达间隔，又能在板子重启后 seq 归零重来
 * 时不被误判为重复。
 * ------------------------------------------------------------------ */
const DEDUP_WINDOW_MS = 5000;
const dedupSeen = new Map();     // "device#seq" -> 首次到达时间戳

function isDuplicateFrame(device, seq) {
  if (typeof seq !== 'number' || !device) return false;
  const key = `${device}#${seq}`;
  const now = Date.now();
  const seenAt = dedupSeen.get(key);
  if (seenAt != null && now - seenAt < DEDUP_WINDOW_MS) return true;
  dedupSeen.set(key, now);
  if (dedupSeen.size > 500) {    // 顺手清理过期项，避免无限增长
    for (const [k, t] of dedupSeen) if (now - t > DEDUP_WINDOW_MS) dedupSeen.delete(k);
  }
  return false;
}

/** 从一行文本中取出 JSON 对象：支持整行 JSON，也支持「日志前缀 + JSON」的行。 */
function extractJsonObject(text) {
  const i = text.indexOf('{');
  if (i < 0) return null;
  const cand = i === 0 ? text : text.slice(i);
  try {
    const o = JSON.parse(cand);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
  } catch (_) { return null; }
}

/** 把嵌套的 value{ax,ay,az,magnitude} 提到顶层，与扁平帧（acc_x_g 等）共用同一套字段映射。 */
function flattenValueObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const v = obj.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return obj;
  const res = Object.assign({}, obj);
  const alias = { ax: 'acc_x_g', ay: 'acc_y_g', az: 'acc_z_g', magnitude: 'acc_mag_g' };
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) continue;
    const key = alias[k] || k;
    if (!(key in res)) res[key] = val;
  }
  return res;
}

function handleLine(line, source) {
  if (!line) return;
  const trimmed = line.trim();
  if (!trimmed) return;
  stats.linesTotal++;

  // 0) 过滤 ESP-IDF 日志行（形如 "I (1234) TAG: ..." / "W (1234) wifi:..."）。
  //    这类日志常含 "SDA=4"、"成功=12" 等片段，若不拦截会被键值解析器
  //    误当成传感器字段，污染展示字段与趋势曲线。日志只进原始日志，不算数据。
  if (/^[IWEDV] \(\d+\)/.test(trimmed)) {
    stats.linesInvalid++;
    pushRaw(trimmed, false);
    return;
  }

  let numbers = null;
  const others = {};     // 非数值字段（字符串/布尔），如 device、mac、iso
  const meta = {};       // 设备身份与板端时间等元数据

  // 1) 优先按 JSON 解析（兼容「日志前缀 + JSON」的行，如 [post] {...}）
  if (trimmed.indexOf('{') >= 0) {
    {
      let obj = extractJsonObject(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        obj = flattenValueObject(obj);
        // 板端回执（远程采集）：单独处理，不当作传感数据，直接返回
        if (obj.type === 'ack') {
          stats.linesValid++;
          pushRaw(trimmed, true);
          onDeviceAck(obj.request_id, obj.status, obj.seq);
          return;
        }
        // 教学求助事件（第 3 周）：板端按键/取消，单独处理，不当作传感数据
        if (obj.type === 'help') {
          stats.linesValid++;
          pushRaw(trimmed, true);
          onHelpEvent(obj);
          return;
        }
        // 摄像头帧：JPEG 以 base64 内联，单独处理。
        // 不 pushRaw 整帧（8KB 会把原始日志刷爆），只记一条摘要。
        if (obj.type === 'frame') {
          stats.linesValid++;
          onCameraFrame(obj);
          return;
        }
        const n = {};
        for (const [k, v] of Object.entries(obj)) {
          if (META_KEYS.has(k) || META_NUMERIC_KEYS.has(k)) meta[k] = v;
          else if (typeof v === 'number' && Number.isFinite(v)) n[k] = v;
          else if (typeof v === 'boolean' || typeof v === 'string') others[k] = v;
        }
        if (Object.keys(n).length) numbers = n;
      }
    }
  }

  // 2) 键=值 / 键: 值（兼容已烧好、非 JSON 的固件；元数据键不在此路径提取，仅 WiFi/JSON 固件带身份）
  if (!numbers && (config.parseMode === 'auto' || config.parseMode === 'kv')) {
    numbers = tryKeyValue(trimmed);
  }

  // 3) 纯 CSV（需显式开启，避免把日志里的数字误当成传感器值）
  if (!numbers && config.parseMode === 'csv') numbers = tryCsv(trimmed);

  if (!numbers || Object.keys(numbers).length === 0) {
    stats.linesInvalid++;
    pushRaw(trimmed, false); // 没有可用数值 -> 只进原始日志，不算数据
    return;
  }

  stats.linesValid++;

  // 更新设备身份与板端时间（来自固件上报的元数据）
  const transport = (source && source.transport) || state.transport || 'serial';
  if (meta.device) state.deviceId = String(meta.device);
  if (meta.mac) state.deviceMac = String(meta.mac);
  // 本组身份校验：未配置期望标识 -> 视为通过；配置后必须与上报 device 完全一致
  state.deviceVerified = !config.expectedDeviceId || state.deviceId === config.expectedDeviceId;
  if (typeof meta.ts === 'number') { state.boardTs = meta.ts; state.boardIso = meta.iso || null; }
  if (typeof meta.seq === 'number') state.seq = meta.seq;

  // 双通道去重：同一帧的串口副本与 WiFi 副本 (device, seq) 相同，只认第一份。
  // 必须在任何副作用（状态更新 / 原始日志 / 落盘 / WebSocket 推送）之前返回。
  if (isDuplicateFrame(meta.device || state.deviceId, meta.seq)) {
    stats.linesDuplicate = (stats.linesDuplicate || 0) + 1;
    return;
  }

  const recvTs = Date.now();
  state.connected = true;
  state.live = true;
  state.transport = transport;
  state.lastDataAt = recvTs;
  // 展示字段：去掉元数据（ts/seq/device/mac/iso 不画成传感器卡片）
  const disp = Object.assign({}, numbers, others);
  for (const k of [...META_KEYS, ...META_NUMERIC_KEYS]) delete disp[k];
  state.fields = disp;
  pushRaw(trimmed, true);

  // 远程采集：帧里带 request_id 即本次请求的「新观测」（数据本身照常落盘）
  if (typeof others.request_id === 'string' && others.request_id) {
    onObservation(others.request_id, disp, recvTs, state.seq);
  }

  // 持久化：一帧真实观测 -> 一条记录（含板端时间与服务端接收时间，用于时间核对）
  storageSeq++;
  const skew = (state.boardTs != null) ? (state.boardTs - recvTs) : null;
  const record = {
    seq: storageSeq,
    recv_ts: recvTs,
    recv_iso: new Date(recvTs).toISOString(),
    device_id: state.deviceId,
    device_mac: state.deviceMac,
    transport,
    src_ip: (source && source.ip) || (state.wifiSource && state.wifiSource.ip) || null,
    board_ts: state.boardTs,
    board_iso: state.boardIso,
    skew_ms: skew,
    fields: disp,
  };
  appendRecord(record);

  broadcast({
    type: 'sample',
    ts: recvTs,
    device_id: state.deviceId,
    device_mac: state.deviceMac,
    device_verified: state.deviceVerified,
    board_ts: state.boardTs,
    board_iso: state.boardIso,
    seq: state.seq,
    reportPaused: !!state.reportPaused,
    skew_ms: skew,
    fields: disp,
  });
  if (recording.active) {
    recording.rows.push({ ts: recvTs, f: disp });
    if (recording.rows.length > recording.maxRows) recording.rows.shift();
  }
}

/* ------------------------------------------------------------------ */
/* 串口管理                                                            */
/* ------------------------------------------------------------------ */

// 常见 USB-UART 芯片厂商 ID：Espressif / CP210x / CH34x / FTDI
const VID_SCORE = {
  '303a': 100, // Espressif Systems
  '10c4': 60,  // Silicon Labs CP210x
  '1a86': 55,  // QinHeng CH34x
  '0403': 40,  // FTDI
};

function scorePort(p) {
  const vid = (p.vendorId || '').toLowerCase();
  let score = VID_SCORE[vid] || 0;
  const text = `${p.manufacturer || ''} ${p.path || ''}`.toLowerCase();
  if (/espressif|esp32|esp8266/.test(text)) score += 50;
  else if (/silicon labs|cp210/.test(text)) score += 20;
  else if (/wch|ch34|usb-serial/.test(text)) score += 10;
  return score;
}

function pickBestPort(ports) {
  const scored = ports.map((p) => ({ p, s: scorePort(p) })).filter((x) => x.s > 0);
  if (!scored.length) return null;
  scored.sort((a, b) => b.s - a.s);
  return scored[0].p;
}

function attachPortHandlers() {
  port.on('data', (chunk) => {
    stats.bytesReceived += chunk.length;
    lineBuffer += chunk.toString('utf8');
    let idx;
    while ((idx = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, idx);
      lineBuffer = lineBuffer.slice(idx + 1);
      // ★ 必须显式声明来源是串口。
      // 否则 handleLine 会退化成 `state.transport`，而 /api/data 的 WiFi 处理器
      // 会先把它设成 'wifi' —— 结果是：串口数据被标成 wifi，且
      // 「串口优先」规则的判断条件 state.transport === 'serial' 永远不成立，
      // WiFi 副本从此再也不会被忽略，同一帧被记录两次。
      handleLine(line.replace(/\r$/, ''), { transport: 'serial' });
    }
    if (lineBuffer.length > 65536) lineBuffer = ''; // 防御性截断
  });

  port.on('error', (err) => {
    console.error('[serial] 错误：', err.message);
    pushRaw(`[串口错误] ${err.message}`, false);
    cleanupPort('error');
  });

  // 拔出开发板 -> 这里会触发
  port.on('close', (err) => {
    const msg = err && err.disconnected ? '设备已拔出' : '串口已关闭';
    console.log(`[serial] ${msg}`);
    cleanupPort(msg);
  });
}

function cleanupPort(reason) {
  if (port) {
    try { port.removeAllListeners(); } catch (_) {}
    port = null;
  }
  lineBuffer = '';
  openingPath = null;
  portOpenedAt = null;
  goOffline(reason || 'closed');
  if (config.autoReconnect && !manualClose) rescanNow();
}

function openSerial(target, baudRate, portInfo) {
  if (!target) return Promise.resolve(false);
  if (port && port.isOpen) return Promise.resolve(true);
  if (openingPath === target) return Promise.resolve(false);
  openingPath = target;

  return new Promise((resolve) => {
    let p;
    try {
      p = new SerialPort({ path: target, baudRate: baudRate || config.baudRate, autoOpen: false });
    } catch (e) {
      openingPath = null;
      stats.lastOpenError = e.message;
      pushRaw(`[串口打开失败] ${e.message}`, false);
      return resolve(false);
    }

    const onFail = (msg) => {
      try { p.removeAllListeners(); } catch (_) {}
      openingPath = null;
      stats.lastOpenError = msg;
      pushRaw(`[串口] ${msg}`, false);
      resolve(false);
    };

    p.open((err) => {
      if (err) return onFail(`无法打开 ${target}：${err.message}`);
      port = p;
      lineBuffer = '';
      portOpenedAt = Date.now();
      stats.bytesReceived = 0;
      stats.lastOpenError = null;
      attachPortHandlers();
      state.transport = 'serial';
      state.connected = false; // 收到第一条真实数据后才置为 true
      state.live = false;
      state.deviceId = null;
      state.deviceMac = null;
      state.seq = null;
      state.device = {
        path: target,
        baudRate: baudRate || config.baudRate,
        vendorId: (portInfo && portInfo.vendorId) || '',
        productId: (portInfo && portInfo.productId) || '',
        manufacturer: (portInfo && portInfo.manufacturer) || '',
      };
      console.log(`[serial] 已打开 ${target} @ ${baudRate || config.baudRate}`);
      pushRaw(`[串口] 已连接 ${target}，等待设备数据…`, false);
      pushStatus('opened');
      openingPath = null;
      resolve(true);
    });
  });
}

async function scanAndConnect() {
  if (port && port.isOpen) return;
  if (manualClose) return;
  try {
    const ports = await SerialPort.list();
    broadcast({ type: 'ports', ports: ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || '',
      vendorId: p.vendorId || '',
      productId: p.productId || '',
      score: scorePort(p),
    })) });

    let target = null;
    if (config.portPath) {
      target = ports.find((p) => p.path === config.portPath) || null;
    } else if (config.autoDetect) {
      const best = pickBestPort(ports);
      target = best || null;
    }
    if (target) await openSerial(target.path, config.baudRate, target);
  } catch (e) {
    console.warn('[scan] 扫描失败：', e.message);
  }
}

function startScanning() {
  if (scanTimer) return;
  scanAndConnect();
  scanTimer = setInterval(scanAndConnect, Math.max(800, config.scanIntervalMs));
}

/** 立即重扫一次：若轮询已在跑就直接触发，避免等待轮询间隔造成"设备消失"的闪烁 */
function rescanNow() {
  if (scanTimer) scanAndConnect();
  else startScanning();
}

function stopScanning() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

async function disconnectSerial(manual = true) {
  manualClose = manual;
  stopScanning();
  if (port && port.isOpen) {
    await new Promise((resolve) => port.close(() => resolve()));
  } else {
    cleanupPort(manual ? '用户断开' : 'closed');
  }
  if (manual) {
    // 用户手动断开后停止自动重连，直到再次点击连接
    state.connected = false;
    goOffline('用户断开');
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) { req.destroy(); reject(new Error('payload too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}

nlAssist = require('./nl_assistant')({
  config, readRecords, createCollectRequest, REQUESTS, state, collectTimeoutMs,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/ws' || p === '/ws/') { res.writeHead(426); return res.end(); }

  // ---- 静态资源（必须放在 /api 路由之后）----
  if (req.method === 'GET' && !p.startsWith('/api/') && (p === '/' || /^\/[A-Za-z0-9._\-/]*$/.test(p))) {
    let rel = p === '/' ? '/index.html' : p;
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // ---- 当前状态 ----
  if (p === '/api/state') {
    return json(res, 200, {
      connected: state.connected,
      live: state.live,
      transport: state.transport,
      device: state.device,
      deviceId: state.deviceId,
      deviceMac: state.deviceMac,
      deviceVerified: state.deviceVerified,
      expectedDeviceId: config.expectedDeviceId,
      lastDataAt: state.lastDataAt,
      boardTs: state.boardTs,
      boardIso: state.boardIso,
      seq: state.seq,
      reportPaused: !!state.reportPaused,
      fields: state.fields,
      stale: isStale(),
      stalePolicy: config.stalePolicy,
      storageEnabled: config.storageEnabled,
      raw: rawLog.slice(-60),
      meta: { units: config.fieldUnits, labels: config.fieldLabels, historyMax: config.historyMax },
    });
  }

  // ---- VPS 原始记录查询（作业要求：采集值、VPS 原始记录、页面变化可对照）----
  if (p === '/api/records') {
    const device = url.searchParams.get('device') || null;
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const since = Number(url.searchParams.get('since')) || null;
    const until = Number(url.searchParams.get('until')) || null;
    const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
    try {
      const rows = readRecords({ device, limit, since, until, order });
      return json(res, 200, { ok: true, count: rows.length, device, rows });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- 设备列表（核对数据来自本组 / 各组独立项目空间）----
  if (p === '/api/devices') {
    try {
      return json(res, 200, { ok: true, devices: listDevices(), storageEnabled: config.storageEnabled });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- 原始记录导出为 CSV（BOM，Excel 友好）----
  if (p === '/api/records.csv') {
    const device = url.searchParams.get('device') || null;
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 1000));
    const since = Number(url.searchParams.get('since')) || null;
    const until = Number(url.searchParams.get('until')) || null;
    try {
      const rows = readRecords({ device, limit, since, until, order: 'asc' });
      if (!rows.length) { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }); return res.end('\uFEFF' + '无记录'); }
      const keys = new Set();
      for (const r of rows) for (const k of Object.keys(r.fields)) keys.add(k);
      const fieldKeys = Array.from(keys);
      const esc = (v) => { const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const header = ['seq', 'recv_iso', 'device_id', 'device_mac', 'transport', 'src_ip', 'board_iso', 'board_ts', 'recv_ts', 'skew_ms', ...fieldKeys].join(',');
      const lines = rows.map((r) => [
        r.seq, r.recv_iso, r.device_id || '', r.device_mac || '', r.transport || '', r.src_ip || '',
        r.board_iso || '', r.board_ts || '', r.recv_ts || '', r.skew_ms == null ? '' : r.skew_ms,
        ...fieldKeys.map((k) => (r.fields && r.fields[k] !== undefined ? esc(r.fields[k]) : '')),
      ].join(','));
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="records_${Date.now()}.csv"`,
      });
      return res.end('\uFEFF' + [header, ...lines].join('\n'));
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- 端口列表 ----
  if (p === '/api/ports') {
    try {
      const ports = await SerialPort.list();
      return json(res, 200, { ports: ports.map((x) => ({
        path: x.path, manufacturer: x.manufacturer || '',
        vendorId: x.vendorId || '', productId: x.productId || '', score: scorePort(x),
      })) });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- 诊断信息（帮助排查"插上板子却没数据"）----
  if (p === '/api/diag') {
    let ports = [];
    try {
      ports = (await SerialPort.list()).map((x) => ({
        path: x.path, manufacturer: x.manufacturer || '',
        vendorId: x.vendorId || '', productId: x.productId || '', score: scorePort(x),
      }));
    } catch (e) { ports = [{ error: e.message }]; }

    const hints = [];
    const usb = ports.filter((x) => (x.score || 0) > 0);
    if (!usb.length) hints.push('未发现 USB 转串口设备，请检查数据线是否是"数据线"而非纯充电线');
    if (!(port && port.isOpen)) hints.push('串口当前未打开');
    else if (stats.bytesReceived === 0) hints.push('串口已打开但一个字节都没收到：检查波特率是否与固件一致（默认 115200），或开发板程序是否在运行');
    else if (stats.linesValid === 0) hints.push(`已收到 ${stats.bytesReceived} 字节但没有一行合法 JSON 数据：确认固件用的是 Serial.println()（必须换行），且输出以 { 开头的 JSON`);
    if (stats.lastOpenError) hints.push(`最近一次打开失败：${stats.lastOpenError}`);

    // 针对 Espressif 原生 USB 串口（VID 303A）的专项提示
    const curPort = ports.find((x) => x.path === (state.device && state.device.path));
    const vid = ((curPort && curPort.vendorId) || (state.device && state.device.vendorId) || '').toLowerCase();
    if (vid === '303a' && stats.bytesReceived === 0) {
      hints.push('检测到 Espressif 原生 USB 串口（VID 303A / USB Serial/JTAG）。这类接口不受波特率影响，收不到数据说明固件没有输出到这个端口。请在 Arduino IDE 把 "USB CDC On Boot" 设为 Enabled 后重新烧录，烧录完按一下开发板上的 RESET 键。');
    } else if (vid && stats.bytesReceived === 0) {
      hints.push('串口已打开但没收到数据。请确认固件已烧录、开发板在运行、且输出用的是 Serial.println()（必须换行）。');
    }

    // 下行通道检查：串口不在线时，只能靠板端经 WiFi 轮询来取命令
    if (!(port && port.isOpen) && !wifiDownlinkActive()) {
      hints.push(`串口未打开，且开发板尚未通过 WiFi 来取命令（GET /api/cmd）。此时远程采集/求助回应只会排队等待。请确认固件已填 WiFi 凭据（app_config.h），且能访问本机 ${config.httpPort} 端口（注意放行防火墙）。`);
    }

    return json(res, 200, {
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      serialportVersion: (() => { try { return require('serialport/package.json').version; } catch (_) { return 'unknown'; } })(),
      serviceUptime: Math.round((Date.now() - stats.startedAt) / 1000),
      ports,
      currentPort: state.device && state.device.path ? state.device.path : null,
      portOpen: !!(port && port.isOpen),
      baudRate: config.baudRate,
      connected: state.connected,
      transport: state.transport,
      bytesReceived: stats.bytesReceived,
      lines: {
        total: stats.linesTotal,
        valid: stats.linesValid,
        invalid: stats.linesInvalid,
        // 双通道（串口 + WiFi 同时在线）时被丢弃的重复帧数。
        // 正常值：只连一路时为 0；两路都连时约等于其中一路的帧数。
        duplicate: stats.linesDuplicate || 0,
      },
      lastError: stats.lastError,
      lastOpenError: stats.lastOpenError,
      recording: { active: recording.active, rows: recording.rows.length },
      downlink: {
        serial: !!(port && port.isOpen),
        wifiPolling: wifiDownlinkActive(),
        lastPollAt: stats.lastCmdPollAt || null,
        pollCount: stats.cmdPollCount || 0,
        pollDevice: stats.cmdPollDevice || null,
        queued: cmdQueue.length,
        sentViaSerial: stats.cmdViaSerial || 0,
        sentViaWifi: stats.cmdViaWifi || 0,
      },
      hints,
    });
  }

  // ---- 第 4 周：自然语言助手（受限工具 + 证据回复）----
  if (p === '/api/ask' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    if (!nlAssist) return json(res, 500, { error: 'nl assistant not ready' });
    return json(res, 200, await nlAssist.ask(body));
  }

  // ---- 远程采集：创建一次请求并下发 ----
  if (p === '/api/collect' && req.method === 'POST') {
    const r = createCollectRequest();
    return json(res, 200, { ok: r.status !== 'failed', request: publicRequest(r) });
  }

  // ---- 远程采集：最近请求列表（页面刷新后恢复显示）----
  if (p === '/api/collect' && req.method === 'GET') {
    return json(res, 200, {
      mockDevice: !!config.mockDevice,
      channel: {
        portOpen: !!(port && port.isOpen),
        wifiDownlink: wifiDownlinkActive(),   // 板端正通过 WiFi 来取命令
        kind: (port && port.isOpen) ? 'serial' : (wifiDownlinkActive() ? 'wifi' : null),
        cmdSent: stats.cmdSent || 0,
        pending: cmdQueue.length,
      },
      timeoutMs: collectTimeoutMs(),
      requests: recentRequests(20),
    });
  }

  // ---- 远程采集：查询单个请求 ----
  if (p.startsWith('/api/collect/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/collect/'.length));
    const r = REQUESTS.get(id);
    if (!r) return json(res, 404, { error: 'request not found' });
    return json(res, 200, { request: publicRequest(r) });
  }

  // ---- 周期上报开关（暂停 / 恢复；命令通道保持）----
  if (p === '/api/report' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    const action = body.action === 'resume' ? 'resume' : 'pause';
    const ok = sendCommand({ cmd: action }, state.deviceId || null);
    if (ok) state.reportPaused = (action === 'pause');
    pushStatus('report');
    return json(res, 200, {
      ok,
      action,
      reportPaused: !!state.reportPaused,
      channel: ok ? ((port && port.isOpen) ? 'serial' : 'wifi') : null,
      note: ok ? null : (config.mockDevice ? '模拟模式：未走真实串口' : '命令通道不可用（串口未打开）'),
    });
  }

  // ---- 下行命令轮询（WiFi 通道，第 3 周补充）----
  // 板端是纯 HTTP 客户端，服务端连不上它，因此由板端定期来取：
  //   GET /api/cmd?device=S3EYE-GROUP01  →  有命令则返回该命令对象，没有则返回 {}
  if (p === '/api/cmd' && req.method === 'GET') {
    const device = (url.searchParams.get('device') || '').trim() || null;
    stats.lastCmdPollAt = Date.now();
    stats.cmdPollCount = (stats.cmdPollCount || 0) + 1;
    stats.cmdPollDevice = device;
    const item = takeCommand(device);
    return json(res, 200, item ? item.obj : {});
  }

  // ---- 摄像头（OV2640）：状态 / 开关 ----
  if (p === '/api/cam' && req.method === 'GET') {
    return json(res, 200, {
      hasFrame: cam.latest != null,
      frames: cam.frames,
      lastAt: cam.latestAt || null,
      seq: cam.latestSeq,
      size: cam.size,
      bytes: cam.latest ? cam.latest.length : 0,
      viewers: cam.clients.size,
      streaming: !!state.camStreaming,
      // 手动抓拍快照
      hasSnapshot: cam.snapshot != null,
      snapshotAt: cam.snapshotAt || null,
      snapshotSize: cam.snapshotSize || null,
      snapshotBytes: cam.snapshotBytes || 0,
    });
  }

  // 手动抓拍的那一张（与直播流分开）
  if (p === '/api/cam/snapshot.jpg') {
    if (!cam.snapshot) return json(res, 404, { error: '还没有抓拍过' });
    const fn = `snapshot-${new Date(cam.snapshotAt).toISOString().replace(/[:.]/g, '-')}.jpg`;
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': cam.snapshot.length,
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${fn}"`,
    });
    return res.end(cam.snapshot);
  }

  if (p === '/api/cam' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}

    const action = (body.action === 'stop' || body.action === 'set' || body.action === 'shot')
      ? body.action : 'start';
    let cmdObj;
    if (action === 'set' || action === 'shot') {
      cmdObj = { cmd: action === 'set' ? 'cam_set' : 'cam_shot' };
      if (body.framesize != null) cmdObj.framesize = Number(body.framesize);
      if (body.quality   != null) cmdObj.quality   = Number(body.quality);
      if (action === 'set' && body.fps != null) cmdObj.fps = Number(body.fps);
    } else {
      cmdObj = { cmd: action === 'start' ? 'cam_on' : 'cam_off' };
    }

    const ok = sendCommand(cmdObj, state.deviceId || null);
    if (ok && (action === 'start' || action === 'stop')) state.camStreaming = (action === 'start');
    pushStatus('cam');
    return json(res, 200, {
      ok,
      action,
      streaming: !!state.camStreaming,
      sent: cmdObj,
      note: ok ? null : (config.mockDevice ? '模拟模式：未走真实通道' : '命令通道不可用（串口未打开、板端也未在轮询）'),
    });
  }

  // 最近一帧（单张 JPEG）
  if (p === '/api/cam.jpg') {
    if (!cam.latest) return json(res, 404, { error: '还没有收到任何帧' });
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': cam.latest.length,
      'Cache-Control': 'no-store',
    });
    return res.end(cam.latest);
  }

  // MJPEG 实时流：浏览器 <img src="/api/cam.mjpg"> 直接可显示，无需 JS 解码
  if (p === '/api/cam.mjpg') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      'Connection': 'close',
    });
    cam.clients.add(res);
    req.on('close', () => cam.clients.delete(res));
    return;
  }

  // ---- 教学求助（第 3 周）：查询当前状态 ----
  if (p === '/api/help' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      help: publicHelp(),
      channel: { portOpen: !!(port && port.isOpen), cmdSent: stats.cmdSent || 0 },
    });
  }

  // ---- 教学求助：查看者回应 / 取消 / 复位 ----
  if (p === '/api/help' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    if (body.action === 'ack') {
      const r = createHelpAck();
      return json(res, 200, { ok: r.ok, note: r.note, help: publicHelp() });
    }
    if (body.action === 'cancel') {
      const r = createHelpCancel();
      return json(res, 200, { ok: r.ok, note: r.note, help: publicHelp() });
    }
    if (body.action === 'reset') {
      resetHelp();
      return json(res, 200, { ok: true, help: publicHelp() });
    }
    return json(res, 400, { error: 'unknown action' });
  }

  // ---- 波特率探测 ----
  if (p === '/api/probe' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    const bauds = Array.isArray(body.baudRates) && body.baudRates.length
      ? body.baudRates : [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];
    const ms = Math.min(5000, Math.max(300, Number(body.ms) || 1500));
    const target = body.portPath || (state.device && state.device.path) || config.portPath || null;
    if (!target) return json(res, 400, { error: '未指定要探测的串口' });

    // 先释放当前端口，避免占用冲突
    stopScanning();
    if (port && port.isOpen) {
      const pp = port; port = null; portOpenedAt = null;
      try { pp.removeAllListeners(); } catch (_) {}
      await new Promise((r) => pp.close(() => r()));
    }

    const results = [];
    for (const b of bauds) {
      results.push(await probeOnce(target, b, ms));
      // 连续开关串口必须留间隔，否则 Windows 上会 Access denied 造成假阴性
      await new Promise((r) => setTimeout(r, 350));
    }

    if (config.autoDetect || config.portPath) startScanning();
    const best = results.filter((r) => r.bytes > 0).sort((a, b2) => b2.bytes - a.bytes)[0] || null;
    // 原生 USB CDC（VID 303A）是虚拟串口，波特率无意义，扫描结果只用于判断"有没有在发数据"
    let nativeUsb = false;
    try {
      const l = await SerialPort.list();
      const hit = l.find((x) => x.path === target);
      nativeUsb = !!hit && (hit.vendorId || '').toLowerCase() === '303a';
    } catch (_) {}
    return json(res, 200, { port: target, ms, nativeUsb, results, suggestedBaudRate: best ? best.baudRate : null });
  }

  // ---- 真实数据录制（仅记录设备实际上报的数据）----
  if (p === '/api/record' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    if (body.action === 'start') {
      recording.active = true;
      recording.rows = [];
      recording.startedAt = Date.now();
      return json(res, 200, { ok: true, active: true });
    }
    if (body.action === 'stop') {
      recording.active = false;
      const file = writeRecording();
      const rows = recording.rows.length;
      recording.rows = [];
      return json(res, 200, { ok: true, active: false, rows, file });
    }
    return json(res, 200, { ok: true, active: recording.active, rows: recording.rows.length });
  }

  if (p === '/api/record/download') {
    const f = url.searchParams.get('file') || '';
    const file = path.join(RECORD_DIR, path.basename(f));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
      });
      res.end(data);
    });
    return;
  }

  // ---- 连接 / 断开 ----
  if (p === '/api/connect' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    manualClose = false;
    if (body.portPath !== undefined) config.portPath = body.portPath || null;
    if (body.baudRate) config.baudRate = Number(body.baudRate) || config.baudRate;
    if (body.autoDetect !== undefined) config.autoDetect = !!body.autoDetect;
    config.autoReconnect = true;
    saveConfig();
    stopScanning();
    const list = await SerialPort.list().catch(() => []);
    let portObj = null;
    if (config.portPath) portObj = list.find((x) => x.path === config.portPath) || null;
    if (!portObj && config.autoDetect) portObj = pickBestPort(list);
    const targetPath = portObj ? portObj.path : config.portPath;
    const ok = await openSerial(targetPath, config.baudRate, portObj);
    // 打开失败才启动轮询重试；成功后若设备掉线，由 cleanupPort 负责重新扫描
    if (!ok) startScanning();
    return json(res, 200, { ok, target: targetPath });
  }

  if (p === '/api/disconnect' && req.method === 'POST') {
    await disconnectSerial(true);
    return json(res, 200, { ok: true });
  }

  // ---- 配置 ----
  if (p === '/api/config') {
    if (req.method === 'GET') return json(res, 200, config);
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_) {}
    for (const k of ['baudRate', 'portPath', 'autoDetect', 'autoReconnect', 'staleAfterMs', 'wifiTimeoutMs', 'expectedDeviceId', 'storageEnabled', 'stalePolicy', 'collectTimeoutMs', 'mockDevice']) {
      if (body[k] !== undefined) config[k] = body[k];
    }
    saveConfig();
    pushStatus('config');
    return json(res, 200, { ok: true, config });
  }

  // ---- WiFi 上报入口（可选传输方式）----
  // ESP32:  HTTP POST http://<host>:8080/api/data   body: {"temp_c":26.5,...}
  if (p === '/api/data' && req.method === 'POST') {
    let body = '';
    try { body = await readBody(req); } catch (e) { return json(res, 413, { error: e.message }); }
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
    // 串口优先：串口在线时忽略 WiFi 上报，避免数据源混乱
    if (state.transport === 'serial' && state.connected) {
      return json(res, 200, { ok: true, ignored: 'serial-active' });
    }
    state.transport = 'wifi';
    state.wifiSource = { ip };
    state.device = { path: `WiFi(${ip})`, ip };
    // 支持 JSON 或 key=value 两种上报；WiFi 固件走 JSON，提取 device/mac/ts 等元数据
    handleLine(body, { transport: 'wifi', ip });
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  启动失败：端口 ${config.httpPort} 已被占用。`);
    console.error('  可能已经有一个平台在运行；请关闭它，或修改 config.json 里的 httpPort 后重试。');
    console.error('');
    process.exit(1);
  }
  console.error('[http] 服务错误：', err);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'hello',
    connected: state.connected,
    live: state.live,
    portOpen: !!(port && port.isOpen),
    wifiDownlink: wifiDownlinkActive(),
    downlinkKind: (port && port.isOpen) ? 'serial' : (wifiDownlinkActive() ? 'wifi' : null),
    transport: state.transport,
    device: state.device,
    deviceId: state.deviceId,
    deviceMac: state.deviceMac,
    deviceVerified: state.deviceVerified,
    expectedDeviceId: config.expectedDeviceId,
    lastDataAt: state.lastDataAt,
    boardTs: state.boardTs,
    boardIso: state.boardIso,
    seq: state.seq,
    reportPaused: !!state.reportPaused,
    fields: state.fields,
    raw: rawLog.slice(-60),
    meta: { units: config.fieldUnits, labels: config.fieldLabels, historyMax: config.historyMax },
    // 远程采集：刷新页面后恢复请求列表与模拟模式标记
    requests: recentRequests(10),
    mockDevice: !!config.mockDevice,
    collectTimeoutMs: collectTimeoutMs(),
    // 教学求助：刷新页面后恢复当前求助状态
    help: publicHelp(),
  }));
  pushStatus('client');
});

/* ------------------------------------------------------------------ */
/* 心跳 / 超时检测                                                     */
/* ------------------------------------------------------------------ */

/* 下行通道变化时主动推送：板端开始 / 停止经 WiFi 轮询取命令 */
let lastDownlinkKind = null;
setInterval(() => {
  const kind = (port && port.isOpen) ? 'serial' : (wifiDownlinkActive() ? 'wifi' : null);
  if (kind !== lastDownlinkKind) {
    lastDownlinkKind = kind;
    pushStatus('downlink');
  }
}, 2000);

setInterval(() => {
  const now = Date.now();
  if (!state.connected || !state.lastDataAt) return;

  const silentMs = now - state.lastDataAt;
  const staleLimit = config.staleAfterMs; // 停采阈值：两种传输方式一致，便于演示"停采后提示未更新"

  // 1) 刚超过"静默阈值"：仍在连接，但已停采 -> 进入"停采保留"状态
  if (state.live && silentMs > staleLimit) {
    if (config.stalePolicy === 'keep') {
      goStale('停采超时（保留旧值，提示未更新）');
    } else {
      // clear 模式：先标记 stale，随后在离线阈值处再清空
      state.live = false;
      broadcast({ type: 'status', connected: true, live: false, stale: true, reason: 'no-data-timeout', lastDataAt: state.lastDataAt });
    }
  }

  // 2) 超过"离线阈值"：依据策略决定清空或继续保留
  if (!state.live && silentMs > config.offlineAfterMs) {
    if (config.stalePolicy === 'keep') {
      // keep 模式：停采只保留，不自动清空（除非物理拔线或手动释放串口）
      return;
    }
    if (state.transport === 'wifi') {
      goOffline('WiFi 设备超时无响应');
      if (config.autoReconnect && !manualClose) rescanNow();
      return;
    }
  }

  // 3) 串口：长时间没有任何数据 => 兜底判定开发板已被拔掉（物理移除必清空）
  if (state.transport === 'serial' && port && port.isOpen && !manualClose) {
    const ref = state.lastDataAt || portOpenedAt;
    if (ref && now - ref > config.offlineAfterMs) {
      console.log('[serial] 长时间无数据，判定开发板已移除');
      pushRaw('[串口] 长时间未收到数据，判定开发板已移除', false);
      const p = port;
      port = null;
      try { p.removeAllListeners(); p.close(() => {}); } catch (_) {}
      cleanupPort('设备无响应，已判定为已移除');
    }
  }
}, 1000);

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

server.listen(config.httpPort, config.host, () => {
  const lanIps = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) lanIps.push(`${a.address} (${name})`);
    }
  }
  console.log('==========================================================');
  console.log('  ESP32-S3-EYE 三轴传感器监控平台（本机即服务器）');
  console.log(`  本机访问: http://localhost:${config.httpPort}`);
  if (lanIps.length) {
    console.log('  局域网访问（开发板固件 app_config.h 填这里）:');
    for (const ip of lanIps) console.log(`      http://${ip.split(' ')[0]}:${config.httpPort}`);
  } else {
    console.log('  局域网访问: 未发现可用的局域网 IPv4 网卡');
  }
  console.log(`  监听: ${config.host}:${config.httpPort}   串口波特率: ${config.baudRate}   自动识别: ${config.autoDetect}`);
  console.log('  说明: 未连接真实开发板时不显示任何数据（无模拟数据）');
  console.log('==========================================================');
  if (config.autoDetect || config.portPath) startScanning();
});

process.on('SIGINT', async () => {
  stopScanning();
  if (port && port.isOpen) await new Promise((r) => port.close(() => r()));
  process.exit(0);
});
