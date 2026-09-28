/** 通用解析测试：验证平台能识别各种真实固件的输出格式（不产生任何数据，只转发真实文本） */
const BASE = 'http://127.0.0.1:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const reset = () => fetch(BASE + '/api/disconnect', { method: 'POST' }).then((r) => r.json());
const send = (text) => fetch(BASE + '/api/data', {
  method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text,
}).then((r) => r.json());
const state = () => fetch(BASE + '/api/state').then((r) => r.json());

(async () => {
  console.log('通用解析测试\n');

  const cases = [
    ['JSON 对象',            '{"temp":25.5,"hum":60.1}',            { temp: 25.5, hum: 60.1 }],
    ['键=值 逗号分隔',        'Temp=25.3,Hum=60.1',                  { Temp: 25.3, Hum: 60.1 }],
    ['键: 值 带单位',         'Temp: 25.3 C  Hum: 60.1 %',           { Temp: 25.3, Hum: 60.1 }],
    ['键:值 无空格',          'temperature:26.5 humidity:58.2',      { temperature: 26.5, humidity: 58.2 }],
    ['中文键名',              '温度: 26.5 湿度: 58.2',                { 温度: 26.5, 湿度: 58.2 }],
    ['负数与科学计数',        'x=-12.5,y=1.2e3',                     { x: -12.5, y: 1200 }],
  ];

  for (const [name, text, expect] of cases) {
    await reset(); await sleep(120);
    await send(text); await sleep(200);
    const st = await state();
    const ok = st.connected === true &&
      Object.entries(expect).every(([k, v]) => Math.abs((st.fields[k] ?? NaN) - v) < 1e-6);
    check(name, ok, JSON.stringify(st.fields));
  }

  // 不该被当成数据的文本
  const negatives = [
    ['时间戳不被误解析',      'Time: 12:34:56',                      '时间里的数字不能变成传感器值'],
    ['普通日志不被误解析',    '[info] connected in 1234 ms',         '日志里的数字不能变成传感器值'],
    ['纯文本无数值',          'ESP32 ready',                         '无数值不应算数据'],
    ['JSON 但无数值字段',     '{"status":"ok"}',                     '无数值字段不应算数据'],
  ];

  for (const [name, text, why] of negatives) {
    await reset(); await sleep(120);
    await send(text); await sleep(200);
    const st = await state();
    check(`${name}（${why}）`, st.connected === false && Object.keys(st.fields).length === 0,
      JSON.stringify(st.fields));
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
