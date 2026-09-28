/**
 * 端到端链路自检（不属于平台运行时的一部分）
 *
 * 默认连接已运行的服务端 (localhost:8080)，适合日常快速巡检。
 * 设环境变量 E2E_PORT=8099 会启动独立隔离实例，用于无硬件干扰的全断言测试。
 * 设 E2E_PORT=8080  连生产实例（真实板子存在时"无设备"断言会失败——正常行为）。
 *
 * 验证：
 *   1) 页面在无设备时拿到的状态为空（无任何模拟数据）
 *   2) 外部设备真实上报后，WebSocket 能收到 sample
 *   3) 停止上报后进入"停采保留"(stale)：保留末次数据与旧时间，不广播 cleared
 *      （对应作业要求：停采后保留旧时间、提示未更新；与"拔线即清空"区分）
 *   4) 手动断开（/api/disconnect）才广播 cleared，前端据此清空显示
 */
const WebSocket = require('ws');
const { spawn } = require('node:child_process');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.E2E_PORT) || 8080;
const BASE = `http://localhost:${PORT}`;
const ISOLATED = !!process.env.E2E_PORT && Number(process.env.E2E_PORT) !== 8080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

async function post(payload) {
  const r = await fetch(BASE + '/api/data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

(async () => {
  let srv = null;
  if (ISOLATED) {
    srv = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: path.join(__dirname, '.test-config.json'), DATA_DIR: path.join(__dirname, '.test-data') }), stdio: 'ignore' });
    await sleep(1200);
  }
  console.log(`ESP32 监控平台 —— 链路自检 (${ISOLATED ? '隔离模式 PORT='+PORT : '生产模式 PORT='+PORT})\n`);

  try {
  // 1) 初始状态必须为空
  const st0 = await (await fetch(BASE + '/api/state')).json();
  check('无设备时 connected=false', st0.connected === false);
  check('无设备时 fields 为空', Object.keys(st0.fields).length === 0, JSON.stringify(st0.fields));

  // 2) 建立 WebSocket
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const samples = [];
  let cleared = false;
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'sample') samples.push(m);
    if (m.type === 'cleared') cleared = true;
  });
  await sleep(300);

  // 3) 模拟外部设备真实上报 5 次
  for (let i = 0; i < 5; i++) {
    await post({ temp_c: 30 + i * 0.5, adc0: 1800 + i, adc0_v: 1.45 + i * 0.01, uptime: i });
    await sleep(200);
  }
  await sleep(300);
  check('收到真实上报的 sample', samples.length >= 4, `收到 ${samples.length} 条`);
  check('sample 字段解析正确', samples.length > 0 && samples[0].fields.temp_c === 30,
    samples.length ? JSON.stringify(samples[samples.length - 1].fields) : '');

  const st1 = await (await fetch(BASE + '/api/state')).json();
  check('状态变为 connected=true', st1.connected === true, `transport=${st1.transport}`);
  check('最新字段已保存', st1.fields && st1.fields.adc0 !== undefined, JSON.stringify(st1.fields));

  // 4) 停止上报 => 进入"停采保留"(stale)：保留末次数据与旧时间，不广播 cleared
  //    （作业要求：停采后保留旧时间、提示未更新；只有物理拔线 / 手动断开才清空）
  console.log('\n  停止上报，等待进入"停采保留"状态（约 7s）…');
  await sleep(7000);
  check('停采后未广播 cleared（应保留旧值）', cleared === false);
  const st2 = await (await fetch(BASE + '/api/state')).json();
  check('停采后保留末次字段', st2.fields && st2.fields.adc0 !== undefined, JSON.stringify(st2.fields));
  check('停采后 live=false（标记未更新）', st2.live === false);
  check('停采后仍 connected（保留状态）', st2.connected === true);

  // 4b) 手动断开（物理拔线/释放串口的等价动作）=> 广播 cleared 并清空
  await fetch(BASE + '/api/disconnect', { method: 'POST' });
  await sleep(400);
  check('断开后收到 cleared 广播', cleared === true);
  const st2b = await (await fetch(BASE + '/api/state')).json();
  check('断开后 fields 已清空', Object.keys(st2b.fields).length === 0, JSON.stringify(st2b.fields));
  check('断开后 connected=false', st2b.connected === false);

  // 5) 非法数据不应被当作传感器数据
  await post({ hello: 'world', flag: true });
  await sleep(300);
  const st3 = await (await fetch(BASE + '/api/state')).json();
  check('无数值字段的报文不被当作数据', st3.connected === false && Object.keys(st3.fields).length === 0);

  ws.close();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  } catch (e) { console.error('测试异常:', e); fail++; }
  finally {
    if (srv) { srv.kill('SIGKILL'); await sleep(200); }
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
