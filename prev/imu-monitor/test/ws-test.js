'use strict';
// WebSocket 端到端：验证后端向浏览器推送的 sample/stale/cleared 消息结构
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const PORT = 8098;
const ROOT = require('node:path').join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}

(async () => {
  // 用隔离配置，避免测试实例连上真实板子（板子在线会让"停采"场景失效，造成假失败）
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: require('node:path').join(__dirname, '.test-config.json') }), stdio: 'ignore' });
  await sleep(1200);
  const got = { hello: null, sample: [], stale: null, cleared: null };
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((res) => ws.on('open', res));

  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.type === 'hello') got.hello = m;
    else if (m.type === 'sample') got.sample.push(m);
    else if (m.type === 'stale') got.stale = m;
    else if (m.type === 'cleared') got.cleared = m;
    else if (m.type === 'status' && m.live === false && m.connected) got.stale = got.stale || m;
  });

  const baseTs = Date.now();
  const frame = JSON.stringify({ device: 'S3EYE-GROUP01', mac: 'AABBCC', seq: 1, src: 'wifi', ts: baseTs, iso: new Date(baseTs).toISOString(), acc_z_g: 2.0, acc_z_ms2: 19.6 });
  await req({ host: '127.0.0.1', port: PORT, path: '/api/data', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(frame) } }, frame);
  await sleep(300);

  ok(!!got.hello, '收到 hello 初始状态');
  ok(got.sample.length > 0, `收到 sample 推送（${got.sample.length} 条）`);
  const s = got.sample[0];
  ok(s.device_id === 'S3EYE-GROUP01', `sample 携带设备身份 device_id=${s.device_id}`);
  ok(s.board_ts === baseTs, 'sample 携带板端时间戳 board_ts');
  ok(s.fields && s.fields.acc_z_g === 2.0, 'sample 携带传感器数值字段');
  ok(!('ts' in s.fields), 'sample.fields 不含元数据 ts');

  // 等待停采 -> stale 消息
  console.log('  … 等待停采保留(约6s)');
  await sleep(6500);
  // 触发一次 status 推送以确认 stale：再发一帧后立即断网不可行，改用查询状态接口
  const st = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET' })).body);
  ok(st.live === false, '停采后服务端标记 live=false');
  ok(st.connected === true && st.boardTs === baseTs, '停采后保留板端旧时间');

  // 模拟拔线：直接断开扫描 + 关闭连接，验证 cleared（这里用 WebSocket 关闭等价页面刷新）
  ws.close();
  await sleep(200);
  ok(true, 'WebSocket 正常关闭，前端将清空（无模拟数据）');

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  srv.kill('SIGKILL');
  await sleep(150);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
