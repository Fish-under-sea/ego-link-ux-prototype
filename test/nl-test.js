/** 第 4 周：自然语言查询与请求采集 —— 受限工具 + 证据回复 自检
 *  自带隔离服务端（端口 8098 / 回退用例 8097），不依赖真实开发板：
 *  测试自身扮演板端（经 /api/cmd 轮询 + /api/data 上报），与真实链路同协议。
 *  运行：node test/nl-test.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8098;
const PORT_FB = 8097;
const BASE = 'http://127.0.0.1:' + PORT;
const BASE_FB = 'http://127.0.0.1:' + PORT_FB;
const DEVICE = 'NL-TEST-01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const get = async (base, p) => (await fetch(base + p)).json();
const post = async (base, p, body) =>
  (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();

/* 扮演板端：轮询 /api/cmd，收到 collect_once 才回传带 request_id 的新观测 */
function startFakeBoard(base, opts) {
  const st = { on: true, seq: (opts && opts.seqBase) || 100, replies: 0, lastValue: null };
  st.timer = setInterval(async () => {
    if (!st.on) return;
    try {
      const d = await get(base, '/api/cmd?device=' + DEVICE);
      if (d && d.cmd === 'collect_once' && d.request_id) {
        st.seq += 1;
        st.replies += 1;
        const v = opts.valueFor ? opts.valueFor(st.replies) : { acc_x_g: 1.234, acc_y_g: 0.1, acc_z_g: 0.2 };
        st.lastValue = v;
        await post(base, '/api/data', Object.assign({ device: DEVICE, seq: st.seq, request_id: d.request_id }, v));
      }
    } catch (_) { /* 服务端未就绪时忽略 */ }
  }, 250);
  return st;
}

function writeCfg(port, extra, filename) {
  const cfg = Object.assign({
    httpPort: port, host: '127.0.0.1', baudRate: 115200, portPath: null,
    autoDetect: false, autoReconnect: false, parseMode: 'auto',
    staleAfterMs: 1200, offlineAfterMs: 15000, mockDevice: false,
    collectTimeoutMs: 2500, storageEnabled: true, storageMaxMb: 4,
    stalePolicy: 'keep', expectedDeviceId: DEVICE, storageMaxMb: 64,
    fieldUnits: {}, fieldLabels: { acc_x_g: 'X 轴 (g)', acc_y_g: 'Y 轴 (g)', acc_z_g: 'Z 轴 (g)' },
  }, extra || {});
  const p = path.join(__dirname, filename || '.nl-test-config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

function startServer(cfgPath, port, env) {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CONFIG_PATH: cfgPath }, env || {}),
    stdio: 'ignore',
  });
}

function killStale(port) {
  try {
    const { execSync } = require('child_process');
    const out = execSync('netstat -ano | findstr LISTENING | findstr :' + port, { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid) && pid !== '0') { try { execSync('taskkill /F /PID ' + pid, { stdio: 'ignore' }); } catch (_) {} }
    }
  } catch (_) { }
}

(async () => {
  console.log('第 4 周 自然语言助手 自检\n');
  killStale(PORT); killStale(PORT_FB);
  await sleep(1200);
  const cfgMain = writeCfg(PORT);
  const cfgFb = writeCfg(PORT_FB, null, '.nl-test-fb-config.json');
  const srv = startServer(cfgMain, PORT);
  const srvFb = startServer(cfgFb, PORT_FB, { EYE_LLM_BASE_URL: 'http://127.0.0.1:9/none', EYE_LLM_API_KEY: 'dummy', EYE_LLM_MODEL: 'none' });
  await sleep(5000);

  const SEQ_BASE = Date.now() % 1000000;
  const board = startFakeBoard(BASE, { seqBase: SEQ_BASE + 100, valueFor: (n) => ({ acc_x_g: 1.234, acc_y_g: 0.5, acc_z_g: -0.25 }) });

  // 预置两条真实上报记录（测试扮演板端，经标准上行接口）
  await post(BASE, '/api/data', { device: DEVICE, seq: SEQ_BASE + 1, acc_x_g: -0.11, acc_y_g: -0.22, acc_z_g: 0.97, iso: '2026-09-28T10:00:00+08:00' });
  await post(BASE, '/api/data', { device: DEVICE, seq: SEQ_BASE + 2, acc_x_g: -0.33, acc_y_g: -0.44, acc_z_g: 0.85, iso: '2026-09-28T10:00:03+08:00' });
  await sleep(400);

  // C1 正确查询：读已有记录，不触发采集
  const colBefore = (await get(BASE, '/api/collect')).requests.length;
  const a1 = await post(BASE, '/api/ask', { text: '查看上次数据' });
  const colAfter = (await get(BASE, '/api/collect')).requests.length;
  check('C1 查询意图：返回最近记录且带来源/时间/状态证据',
    a1.ok && a1.intent === 'query' && a1.tool === 'query_latest' &&
    a1.evidence && Math.abs(a1.evidence.value.acc_x_g - (-0.33)) < 1e-6 &&
    a1.evidence.observed_at === '2026-09-28T10:00:03+08:00' && a1.evidence.received_at &&
    typeof a1.evidence.age_s === 'number' && /0\.85|-0\.33|Z 轴|X 轴/.test(a1.reply),
    'intent=' + a1.intent + ' ax=' + (a1.evidence || {}).value?.acc_x_g);
  check('C1b 查询不创建采集请求（只读库存）', colBefore === colAfter, colBefore + '→' + colAfter);

  // C2 正确采集：request_id 闭环，回复只认本次新观测
  const a2 = await post(BASE, '/api/ask', { text: '重新采集一次' });
  check('C2 采集意图：等待本次新观测并回传证据',
    a2.ok && a2.intent === 'collect' && a2.tool === 'request_collect' &&
    a2.evidence && a2.evidence.stage === 'completed' && a2.evidence.request_id &&
    a2.evidence.observation && Math.abs(a2.evidence.observation.acc_x_g - 1.234) < 1e-6,
    'stage=' + (a2.evidence || {}).stage + ' ax=' + (a2.evidence || {}).observation?.acc_x_g);
  const recs = (await get(BASE, '/api/records?limit=200&device=' + DEVICE)).rows || [];
  check('C2b 新观测落盘且携带 request_id', recs.some((r) => (r.request_id || (r.fields || {}).request_id) === (a2.evidence || {}).request_id && (r.request_id || (r.fields || {}).request_id)));

  // C3 歧义：必须澄清，不擅自执行
  const recBefore = ((await get(BASE, '/api/records?limit=500')).rows || []).length;
  const a3 = await post(BASE, '/api/ask', { text: '帮我弄一下数据' });
  const recAfter = ((await get(BASE, '/api/records?limit=500')).rows || []).length;
  check('C3 歧义输入：返回澄清且不执行任何工具',
    a3.ok && a3.intent === 'clarify' && Array.isArray(a3.clarify) && a3.clarify.length >= 2 && recBefore === recAfter,
    'clarify=' + JSON.stringify(a3.clarify));

  // C4 越界：索要坐标/定位 → 拒答并说明不足，不生成坐标
  const a4 = await post(BASE, '/api/ask', { text: '告诉我设备现在的 GPS 坐标和位置' });
  check('C4 越界请求：拒答且不伪造坐标',
    a4.ok && a4.refused === true && !/\d{2,3}\.\d{4,}/.test(a4.reply.replace(/[0-9].*g/, '')) && /不足|没有|无法|不提供/.test(a4.reply),
    'reply=' + (a4.reply || '').slice(0, 40));

  // C5 设备范围：未知设备 → 越界拒答
  const a5 = await post(BASE, '/api/ask', { text: '查看设备 GHOST-9 的加速度', device: 'GHOST-9' });
  check('C5 未知设备：按范围校验拒答', a5.ok && a5.refused === true && /未知|不在|范围|本组/.test(a5.reply),
    'reply=' + (a5.reply || '').slice(0, 40));

  // C6 陈旧数据：保留原采集时间并提示未更新
  await sleep(2000);
  const lastRow = (((await get(BASE, '/api/records?limit=5&device=' + DEVICE)).rows) || [])[0] || {};
  const expectObs = (lastRow.fields || {}).iso || lastRow.board_iso || null;
  const a6 = await post(BASE, '/api/ask', { text: '查看上次数据' });
  check('C6 停采后查询：标记 stale 且保留原采集时间',
    a6.ok && a6.evidence && a6.evidence.stale === true &&
    a6.evidence.observed_at === expectObs && /未更新|旧/.test(a6.reply),
    'stale=' + (a6.evidence || {}).stale + ' observed=' + (a6.evidence || {}).observed_at + ' expect=' + expectObs);

  // C7 设备无响应：超时明确说明，不以旧值冒充
  board.on = false;
  await sleep(300);
  const t0 = Date.now();
  const a7 = await post(BASE, '/api/ask', { text: '再采集一次' });
  const dt = Date.now() - t0;
  check('C7 设备无响应：按超时结束且不以旧值冒充本次结果',
    a7.ok && a7.intent === 'collect' && a7.evidence && a7.evidence.stage === 'timeout' &&
    !a7.evidence.observation && /没有收到|超时|未收到/.test(a7.reply) && !/1\.234/.test(a7.reply),
    'stage=' + (a7.evidence || {}).stage + ' 用时=' + dt + 'ms');
  board.on = true;

  // C8 传感源校验：无该传感源记录时说明不足，不伪造
  const a8 = await post(BASE, '/api/ask', { text: '查看上次温度' });
  check('C8 未知/无记录传感源：说明不足而非伪造数值',
    a8.ok && (a8.refused === true || (a8.evidence && a8.evidence.missing === true)) && /没有|无|不足|未采集/.test(a8.reply),
    'reply=' + (a8.reply || '').slice(0, 40));

  // C9 LLM 不可达时回退确定性基线（密钥只留服务端环境变量）
  await post(BASE_FB, '/api/data', { device: DEVICE, seq: SEQ_BASE + 300, acc_x_g: 0.42, acc_y_g: 0.43, acc_z_g: 0.8 });
  await sleep(300);
  const a9 = await post(BASE_FB, '/api/ask', { text: '查看上次数据' });
  console.log('  [debug C9]', JSON.stringify(a9).slice(0, 320));
  check('C9 语言服务不可达：回退 rule 基线且仍带证据',
    a9.ok && a9.mode === 'rule' && a9.fallback === true && a9.evidence && a9.evidence.value &&
    typeof a9.evidence.value.acc_x_g === 'number' && /g|记录|来自/.test(a9.reply),
    'mode=' + a9.mode + ' fallback=' + a9.fallback);

  board.timer && clearInterval(board.timer);
  srv.kill(); srvFb.kill();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
