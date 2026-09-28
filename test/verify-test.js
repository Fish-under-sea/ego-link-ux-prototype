'use strict';
// 本组设备身份校验测试：服务端配置 expectedDeviceId 后，
// 只有 device 匹配的数据标记为"已验证"，不匹配则标记"非本组设备"（但不丢弃）。
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 8095;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const post = (p, obj) => req({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(obj)) } }, JSON.stringify(obj));

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', CONFIG_PATH: path.join(ROOT, 'test', '.test-config.json') }), stdio: 'ignore' });
  await sleep(1200);
  try {
    // 设置本组期望标识
    await post('/api/config', { expectedDeviceId: 'S3EYE-GROUP01' });
    await sleep(150);

    // 本组设备上报 -> 校验通过
    await post('/api/data', { device: 'S3EYE-GROUP01', seq: 1, acc_z_g: 2.0 });
    await sleep(250);
    let st = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET' })).body);
    ok(st.deviceVerified === true, `本组设备(device=S3EYE-GROUP01) -> deviceVerified=true`);
    ok(st.expectedDeviceId === 'S3EYE-GROUP01', '服务端记录了期望标识');

    // 邻组设备上报 -> 校验失败但不丢弃
    await post('/api/data', { device: 'S3EYE-GROUP02', seq: 2, acc_z_g: -2.0 });
    await sleep(250);
    st = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET' })).body);
    ok(st.deviceVerified === false, `非本组设备(device=S3EYE-GROUP02) -> deviceVerified=false`);
    ok(st.connected === true && st.fields && st.fields.acc_z_g != null, '非本组数据仍被接收展示（仅标记非本组，不丢数据）');

    // 记录中也带 device_id，可据此区分来源
    const rec = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/records?limit=10', method: 'GET' })).body);
    ok(rec.rows.some((r) => r.device_id === 'S3EYE-GROUP02'), 'VPS 记录保留了非本组来源(device_id 可区分)');

    // 关闭校验 -> 任意设备均通过
    await post('/api/config', { expectedDeviceId: null });
    await sleep(150);
    await post('/api/data', { device: 'WHATEVER', seq: 3, acc_z_g: 1.0 });
    await sleep(250);
    st = JSON.parse((await req({ host: '127.0.0.1', port: PORT, path: '/api/state', method: 'GET' })).body);
    ok(st.deviceVerified === true, '关闭校验(期望标识=null) -> 任意设备 deviceVerified=true');

    console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  } catch (e) {
    console.error('测试异常：', e); fail++;
  } finally {
    // 还原配置，避免修改用户 config.json 的 expectedDeviceId
    try { await post('/api/config', { expectedDeviceId: null }); } catch (_) {}
    srv.kill('SIGKILL');
    await sleep(200);
  }
  process.exit(fail ? 1 : 0);
})();
