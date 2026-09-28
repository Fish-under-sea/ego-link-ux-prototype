/** 诊断接口 + 真实数据录制 的自检 */
const BASE = 'http://127.0.0.1:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

(async () => {
  console.log('诊断 + 录制 自检\n');

  // 1) 诊断接口
  const d = await (await fetch(BASE + '/api/diag')).json();
  check('/api/diag 返回成功', !!d.runtime, `node=${d.runtime && d.runtime.node}`);
  check('诊断包含串口列表', Array.isArray(d.ports), `共 ${d.ports.length} 个`);
  check('诊断包含报文统计', d.lines && typeof d.lines.total === 'number');
  check('未插设备时给出排查建议', Array.isArray(d.hints) && d.hints.length > 0, (d.hints || []).join(' | '));
  check('未插设备时 bytesReceived=0', d.bytesReceived === 0);
  check('serialport 版本可读', d.serialportVersion !== undefined, String(d.serialportVersion));

  // 2) 录制：开始 -> 上报真实数据 -> 停止 -> 下载 CSV
  await fetch(BASE + '/api/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  });
  let st = await (await fetch(BASE + '/api/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).json();
  check('录制已开启', st.active === true);

  for (let i = 0; i < 3; i++) {
    await fetch(BASE + '/api/data', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temp_c: 25 + i, adc0: 1000 + i }),
    });
    await sleep(150);
  }
  st = await (await fetch(BASE + '/api/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).json();
  check('录制累积到真实采样', st.rows === 3, `rows=${st.rows}`);

  const stop = await (await fetch(BASE + '/api/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  })).json();
  check('停止录制返回文件名', !!stop.file, String(stop.file));
  check('停止录制返回行数', stop.rows === 3, `rows=${stop.rows}`);

  const csv = await (await fetch(`${BASE}/api/record/download?file=${encodeURIComponent(stop.file)}`)).text();
  const lines = csv.trim().split('\n');
  check('CSV 表头正确', lines[0].includes('timestamp_ms') && lines[0].includes('temp_c') && lines[0].includes('adc0'), lines[0].slice(0, 80));
  check('CSV 行数正确（含表头）', lines.length === 4, `${lines.length} 行`);
  check('CSV 含真实数值', lines[1].includes('25') && lines[3].includes('1002'), lines[3]);

  // 3) 无数据时不产生文件
  await fetch(BASE + '/api/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  });
  const stop2 = await (await fetch(BASE + '/api/record', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  })).json();
  check('空录制不生成文件', !stop2.file && stop2.rows === 0, JSON.stringify(stop2));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
