'use strict';
// 全链路验收：模拟 ESP32-S3-EYE 固件真实上报形状的数据，
// 贯穿 固件上报 -> 服务端落盘 -> 前端页面/查询接口，验证"一帧观测=一条记录"与三端联动。
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const WS = require('ws');

const PORT = 8096;
const ROOT = require('node:path').join(__dirname, '..');
const TEST_DATA = require('node:path').join(__dirname, '.test-data');
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
  // 测试使用隔离的数据目录和配置，不影响真实运行环境
  try { fs.mkdirSync(TEST_DATA, { recursive: true }); } catch (_) {}
  const ndjson = require('node:path').join(TEST_DATA, 'records.ndjson');
  if (fs.existsSync(ndjson)) fs.unlinkSync(ndjson);

  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: require('node:path').join(__dirname, '.test-config.json'), DATA_DIR: TEST_DATA }), stdio: 'ignore' });
  await sleep(1200);

  try {
    // 先建立 WebSocket（前端同源实时通道），再发数据，才能收到 sample 推送
    const ws = new WS(`ws://127.0.0.1:${PORT}/ws`);
    const got = { sample: 0, stale: false };
    await new Promise((res) => ws.on('open', res));
    ws.on('message', (b) => { const m = JSON.parse(b.toString()); if (m.type === 'sample') got.sample++; if (m.type === 'stale' || (m.type === 'status' && m.live === false)) got.stale = true; });

    // 1) 固件真实形状：两帧（第二帧 Z 轴变化，模拟板子被翻转）
    const mk = (seq, z) => JSON.stringify({
      device: 'S3EYE-GROUP01', mac: 'AABBCCDDEEFF', seq, src: 'wifi',
      ts: Date.now() + seq * 1000, iso: new Date(Date.now() + seq * 1000).toISOString(),
      acc_x_raw: 5, acc_x_g: 0.0012, acc_x_ms2: 0.012,
      acc_y_raw: -3, acc_y_g: -0.0007, acc_y_ms2: -0.007,
      acc_z_raw: z, acc_z_g: z / 8191 * 2, acc_z_ms2: z / 8191 * 2 * 9.80665,
      temp_c: 31.2, rssi: -54, upload_ok: seq, upload_fail: 0,
    });
    ok((await req({ host: '127.0.0.1', port: PORT, path: '/api/data', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(mk(1, 8191)) } }, mk(1, 8191))).status === 200, '固件帧1 上报 200（Z≈+1g）');
    await sleep(150);
    ok((await req({ host: '127.0.0.1', port: PORT, path: '/api/data', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(mk(2, -8191)) } }, mk(2, -8191))).status === 200, '固件帧2 上报 200（Z≈-1g，模拟翻转）');
    await sleep(300);

    // 2) WebSocket 实时推送（前端同源通道）
    ok(got.sample > 0, `WebSocket 实时推送 sample（${got.sample} 条）`);

    // 3) 前端页面（真实 served 文件）含三轴面板
    const page = (await req({ host: '127.0.0.1', port: PORT, path: '/', method: 'GET' })).body;
    ok(page.includes('imuPanel') && page.includes('实时姿态'), '前端页面含三轴加速度(IMU)面板');
    ok(page.includes('recordsTable') && page.includes('原始记录'), '前端页面含原始记录查询面板');

    // 4) 服务端落盘：一帧观测=一条记录
    const rec = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/records?limit=10', method: 'GET' })).body);
    ok(rec.ok && rec.count >= 2, `VPS 落盘记录数=${rec.count}（应=上报帧数）`);
    ok(rec.rows.some((r) => r.device_id === 'S3EYE-GROUP01'), '记录含本组 device_id（核对数据来自本组设备）');
    ok(rec.rows.some((r) => typeof r.skew_ms === 'number'), '记录含板端-服务端时间偏差 skew_ms（时间核对）');
    const zGs = rec.rows.map((r) => (r.fields && r.fields.acc_z_g)).filter((v) => typeof v === 'number');
    ok(zGs.some((v) => Math.abs(v - 2.0) < 0.01) && zGs.some((v) => Math.abs(v + 2.0) < 0.01),
      `两帧 Z 轴 g 值均正确落盘（+2g / -2g）（实测 ${zGs.map((v) => v.toFixed(2)).join(', ')}）`);

    // 5) 设备列表
    const dev = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/devices', method: 'GET' })).body);
    ok(dev.ok && dev.devices.some((d) => d.device_id === 'S3EYE-GROUP01'), '设备列表识别本组设备');

    // 6) 停采保留：不再上报，超时后保留末值+旧时间，不立即清空
    console.log('  … 等待停采保留(约6s)');
    await sleep(6500);
    const st = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET' })).body);
    ok(st.live === false && st.connected === true, '停采后 live=false 但保留连接（保留旧值旧时间）');
    ok(st.fields && st.fields.acc_z_g != null, '停采后仍保留末次真实数值（未更新，非清空）');

    ws.close();
    console.log(`\n全链路验收结果：通过 ${pass} / 失败 ${fail}`);
  } catch (e) {
    console.error('验收异常：', e); fail++;
  } finally {
    srv.kill('SIGKILL');
    await sleep(200);
  }
  process.exit(fail ? 1 : 0);
})();
