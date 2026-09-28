'use strict';
// 集成测试：模拟 ESP32-S3-EYE WiFi 固件上报，验证
//   1) 数据解析 + 设备身份(device/mac/ts)提取
//   2) NDJSON 落盘
//   3) /api/records 与 /api/devices 查询
//   4) 停采保留(stale) - 板端已停止但服务端保留旧值旧时间
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 8099;
const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'records.ndjson');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function nowMs() { return Date.now(); }

(async () => {
  // 清理旧数据
  if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);

  // 必须用隔离配置：默认配置 autoDetect=true 会打开真实板子的串口，
  // 板子持续上报会让"停采"场景无法成立，测试出现假失败。
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: path.join(__dirname, '.test-config.json') }), stdio: 'ignore' });
  await sleep(1200);

  try {
    // —— 模拟固件上报两帧（与 s3eye_imu_wifi.ino 字段一致）——
    const baseTs = nowMs();
    const frame1 = JSON.stringify({
      device: 'S3EYE-GROUP01', mac: 'AABBCCDDEEFF', seq: 1, src: 'wifi',
      ts: baseTs, iso: new Date(baseTs).toISOString(),
      acc_x_raw: -23, acc_x_g: -0.0056, acc_x_ms2: -0.055,
      acc_y_raw: 12, acc_y_g: 0.0029, acc_y_ms2: 0.028,
      acc_z_raw: 8191, acc_z_g: 2.0, acc_z_ms2: 19.6,
    });
    const frame2 = JSON.stringify(Object.assign(JSON.parse(frame1), { seq: 2, ts: baseTs + 1000 }));
    ok((await req({ host: '127.0.0.1', port: PORT, path: '/api/data', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(frame1) } }, frame1)).status === 200, 'POST /api/data 帧1 返回 200');
    ok((await req({ host: '127.0.0.1', port: PORT, path: '/api/data', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(frame2) } }, frame2)).status === 200, 'POST /api/data 帧2 返回 200');

    await sleep(300);

    // —— /api/state 应包含设备身份与板端时间 ——
    const st = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET' })).body);
    ok(st.connected === true, '/api/state.connected = true');
    ok(st.deviceId === 'S3EYE-GROUP01', `设备身份识别 deviceId=${st.deviceId}`);
    ok(st.boardTs != null, '板端时间戳已记录');
    ok(st.fields && st.fields.acc_z_g === 2.0, '展示字段不含元数据，仅传感器数值');
    ok(!('ts' in (st.fields || {})), '元数据 ts 未作为传感器卡片展示');
    ok(!('device' in (st.fields || {})), '元数据 device 未作为传感器卡片展示');

    // —— /api/records 落盘查询 ——
    const rec = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/records?limit=10', method: 'GET' })).body);
    ok(rec.ok && rec.count >= 2, `/api/records 返回 ${rec.count} 条记录`);
    const r0 = rec.rows.find((x) => x.seq === 1);
    ok(r0 && r0.device_id === 'S3EYE-GROUP01', '记录含 device_id');
    ok(r0 && r0.board_ts === baseTs, '记录含板端时间 board_ts');
    ok(r0 && typeof r0.skew_ms === 'number', `记录含服务端-板端时间差 skew_ms=${r0 && r0.skew_ms}`);
    ok(r0 && r0.recv_ts && r0.recv_iso, '记录含服务端接收时间/ISO');

    // —— /api/devices 设备列表 ——
    const dev = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/devices', method: 'GET' })).body);
    ok(dev.ok && dev.devices.some((d) => d.device_id === 'S3EYE-GROUP01'), '设备列表含本组设备');

    // —— /api/records.csv 导出 ——
    const csv = (await req({ host: '127.0.0.1', port: PORT, path: '/api/records.csv', method: 'GET' })).body;
    ok(csv.startsWith('﻿'), 'CSV 带 BOM');
    ok(/device_id,/.test(csv.split('\n')[0]), 'CSV 表头含 device_id');

    // —— 停采保留：不再上报，等待超过 staleAfterMs(5s) 后应进入 stale(保留旧值) ——
    console.log('  … 等待停采超时(约6s)以验证"保留旧时间、提示未更新"');
    await sleep(6500);
    const st2 = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET' })).body);
    ok(st2.live === false, '停采后 live=false（标记未更新）');
    ok(st2.connected === true && st2.fields && st2.fields.acc_z_g === 2.0, '停采后仍保留最后一次真实值与旧时间（keep 策略）');
    ok(st2.lastDataAt === st.lastDataAt, '停采后保留旧时间不变');

    console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  } catch (e) {
    console.error('测试异常：', e);
    fail++;
  } finally {
    srv.kill('SIGKILL');
    await sleep(200);
  }
  process.exit(fail ? 1 : 0);
})();
