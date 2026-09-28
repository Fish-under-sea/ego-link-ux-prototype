'use strict';
/*
 * 第 3 周：教学求助闭环测试
 *
 * 重点验证"当堂验证"的两条硬指标，以及状态机不会说谎：
 *   ① 没有收到板端求助时，服务端不得产生任何"已收到"的痕迹
 *   ② 回应命令未能送达板端时，状态【不得前进】为 acknowledged
 *   ③ 只有板端回执 ack_shown 之后，ack_delivered 才为 true
 *   ④ 求助事件不污染传感数据链路（不产生传感字段、不落盘为传感记录）
 *
 * 自带服务，使用独立端口 8097，不影响正在运行的主服务。
 * 用法：node test/help-test.js
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 8097;
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.error('  ✗', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const get = (p) => req({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' });
const post = (p, obj) => {
  const s = JSON.stringify(obj);
  return req({
    host: '127.0.0.1', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) },
  }, s);
};
const jget = async (p) => JSON.parse((await get(p)).body);
const jpost = async (p, o) => JSON.parse((await post(p, o)).body);

const HELP = (extra) => Object.assign({
  type: 'help', event: 'request', help_id: 'help-test-0001',
  device: 'S3EYE-GROUP01', mac: 'AABBCCDDEEFF', seq: 100, ts: 1758421800000,
}, extra);

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CONFIG_PATH: path.join(ROOT, 'test', '.test-config.json'),
    }),
    stdio: 'ignore',
  });
  await sleep(1300);
  try {
    // 关掉串口自动连接：否则"串口优先"会让 /api/data 注入被忽略
    await jpost('/api/config', { autoDetect: false, autoReconnect: false });
    await post('/api/disconnect', {});
    await sleep(400);

    console.log('— ① 无求助时，不得出现任何"已收到"的痕迹 —');
    let j = await jget('/api/help');
    ok(j.help.status === 'idle' && j.help.active === false, '初始状态 = idle');
    let r = await jpost('/api/help', { action: 'ack' });
    ok(r.ok === false, '无进行中求助时点「已收到」→ 被拒绝');
    ok(r.help.status === 'idle', '状态仍为 idle（未产生假的"已收到"）');
    ok(r.help.ack_delivered == null, 'ack_delivered 保持未知（不谎称对方已收到）');

    console.log('— ② 板端上报求助 → received —');
    const d = await jpost('/api/data', HELP({}));
    ok(d.ok === true && !d.ignored, '求助事件被服务端接收（未被串口优先忽略）');
    await sleep(200);
    j = await jget('/api/help');
    ok(j.help.status === 'received', 'status = received');
    ok(j.help.help_id === 'help-test-0001', 'help_id 被记录');
    ok(j.help.seq === 100 && j.help.board_ts === 1758421800000, '板端 seq 与时间戳被记录');

    console.log('— ③ 回应送不到板端时，状态不得前进 —');
    r = await jpost('/api/help', { action: 'ack' });
    ok(r.ok === false, '命令通道不可用 → ack 返回 ok=false');
    ok(r.help.status === 'received', '★ 状态不前进（仍为 received）');
    ok(r.help.ack_channel_ok === false, 'ack_channel_ok = false');
    ok(r.help.ack_delivered == null, 'ack_delivered 仍为未知');
    ok(/未送达|不会显示/.test(r.note || ''), '提示文案明确说明"未送达设备 / 板端不会显示"');

    console.log('— ④ 只有板端回执，才认「对方已收到」 —');
    await jpost('/api/data', {
      type: 'ack', device: 'S3EYE-GROUP01',
      request_id: 'help-test-0001', seq: 101, status: 'ack_shown',
    });
    await sleep(200);
    j = await jget('/api/help');
    ok(j.help.ack_delivered === true, '板端回执 ack_shown → ack_delivered = true');

    console.log('— ⑤ 取消与复位 —');
    await jpost('/api/data', HELP({ event: 'cancel', seq: 102 }));
    await sleep(200);
    j = await jget('/api/help');
    ok(j.help.status === 'cancelled' && j.help.active === false, '板端取消 → cancelled');
    r = await jpost('/api/help', { action: 'reset' });
    ok(r.help.status === 'idle', 'reset → 回到 idle');

    console.log('— ⑥ 求助事件不污染传感数据链路 —');
    await jpost('/api/data', HELP({ help_id: 'help-test-0002', seq: 103 }));
    await sleep(200);
    const st = await jget('/api/state');
    ok(!Object.keys(st.fields || {}).some((k) => /help|event/.test(k)), '未产生传感字段');
    const rec = await jget('/api/records?limit=20');
    ok(!(rec.rows || []).some((x) => x.fields && x.fields.help_id), '未落盘为传感记录');

    console.log('— ⑦ WiFi 下行：拔掉 USB 也能下发命令 —');
    // ③⑤ 在"通道不可用"时也会把命令入队（防止丢失），先排空残留
    let drained = 0;
    for (let i = 0; i < 8; i++) {
      const c = await jget('/api/cmd?device=S3EYE-GROUP01');
      if (!c.cmd) break;
      drained++;
    }
    ok(drained > 0, `通道不可用时命令仍入队、不丢失（排空 ${drained} 条残留）`);
    const c0 = await jget('/api/cmd?device=S3EYE-GROUP01');
    ok(!c0.cmd, '队列空时轮询返回空对象');
    const cr = await jpost('/api/collect', {});
    ok(cr.request && cr.request.channel === 'wifi', '串口不在线时，采集命令走 WiFi 队列（channel=wifi）');
    ok(cr.request && cr.request.status === 'dispatched', '状态推进到 dispatched');
    const c1 = await jget('/api/cmd?device=S3EYE-GROUP01');
    ok(c1.cmd === 'collect_once' && c1.request_id === cr.request.request_id, '板端取到 collect_once，request_id 一致');
    const c2 = await jget('/api/cmd?device=S3EYE-GROUP01');
    ok(!c2.cmd, '再取一次为空 —— 不会重复执行');
    await jpost('/api/data', HELP({ help_id: 'help-test-0003', seq: 110 }));
    await sleep(150);
    const ar = await jpost('/api/help', { action: 'ack' });
    ok(ar.ok === true && ar.help.ack_channel === 'wifi', '求助回应入队，通道标注为 wifi');
    const c3 = await jget('/api/cmd?device=S3EYE-GROUP01');
    ok(c3.cmd === 'viewer_ack' && c3.request_id === 'help-test-0003', '板端取到 viewer_ack，help_id 一致');

    console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  } catch (e) {
    console.error('测试异常：', e);
    fail++;
  } finally {
    // 保持关闭：测试用的隔离配置必须 autoDetect=false，否则会连上真实板子，
    // 板子持续上报会让"停采/注入"类断言失效（历史假失败根因）。
    try { await jpost('/api/config', { autoDetect: false, autoReconnect: false }); } catch (_) { /* 忽略 */ }
    srv.kill('SIGKILL');
    await sleep(200);
  }
  process.exit(fail ? 1 : 0);
})();
