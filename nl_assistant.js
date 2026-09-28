/** 第 4 周：自然语言助手（产品运行时模型层）
 *
 *  设计约束（课程口径）：
 *   - 区分「开发助手」与「产品运行时模型」：本模块是产品运行时，只把自然语言
 *     映射到两个【受限工具】：query_latest（只读库存记录）与 request_collect
 *     （复用第 2 周 request_id 闭环）。不在本课程中训练任何模型。
 *   - 密钥只留服务端：LLM 端点/Key 仅从环境变量读取（EYE_LLM_BASE_URL /
 *     EYE_LLM_API_KEY / EYE_LLM_MODEL），绝不入库、绝不下发板端。
 *   - 证据优先：回复必须带来源/时间/状态；无设备完成证据不得说「已采集」；
 *     超时明确说「本次没有收到新观测」，不以旧值冒充。
 *   - 服务异常回退：LLM 不可达/解析失败 → 确定性 rule 基线（fallback=true）。
 */

const REFUSE_PATTERNS = [
  [/坐标|gps|定位|位置|latitude|longitude/i, '本系统没有定位传感源，不能生成或估计坐标/位置。'],
  [/预测|预估|猜一?猜|forecast|predict/i, '本系统只陈述已采集的真实观测，不做预测或猜测。'],
];

const COLLECT_RE = /重新采集|再采集|采集一次|采一次|重新采|新采集|立刻采集|马上采集|collect\s*(again|now)|recapture|take\s*a\s*new/i;
const QUERY_RE = /查看|看看|查一下|查询|上次|最近|最后|最新|show|read|last|latest|query/i;
const SENSOR_MAP = [
  [/温度|temp/i, 'temp'],
  [/湿度|humid/i, 'hum'],
  [/加速度|acc|姿态|三轴|倾斜/i, 'acc'],
];
const SENSOR_FIELDS = {
  acc: ['acc_x_g', 'acc_y_g', 'acc_z_g', 'acc_mag_g', 'ax', 'ay', 'az', 'magnitude'],
  temp: ['temp_c', 'temperature', 'temp'],
  hum: ['humidity', 'hum'],
};
const SENSOR_CN = { acc: '加速度', temp: '温度', hum: '湿度' };

function fmtVal(fields, sensor) {
  const keys = SENSOR_FIELDS[sensor] || SENSOR_FIELDS.acc;
  const parts = [];
  for (const k of keys) {
    if (typeof fields[k] === 'number') parts.push(k + '=' + fields[k]);
  }
  return parts.join(' ');
}

module.exports = function createNlAssistant(deps) {
  const { config, readRecords, createCollectRequest, REQUESTS, state, collectTimeoutMs } = deps;

  function knownDevices() {
    const set = new Set();
    if (state.deviceId) set.add(state.deviceId);
    if (config.expectedDeviceId) set.add(config.expectedDeviceId);
    try {
      for (const r of readRecords({ limit: 200 })) {
        if (r.device_id) set.add(r.device_id);
      }
    } catch (_) { /* 存储不可用时忽略 */ }
    return set;
  }

  /* ---------- 确定性 NLU 基线 ---------- */
  function ruleNlu(text) {
    const t = (text || '').trim();
    for (const [re, why] of REFUSE_PATTERNS) {
      if (re.test(t)) return { intent: 'refuse', reason: why };
    }
    const mDev = t.match(/设备\s*([A-Za-z0-9_-]{2,})/i) || t.match(/device\s+([A-Za-z0-9_-]{2,})/i);
    const device = mDev ? mDev[1] : null;
    let sensor = 'acc';
    for (const [re, name] of SENSOR_MAP) {
      if (re.test(t)) { sensor = name; break; }
    }
    const wantCollect = COLLECT_RE.test(t);
    const wantQuery = QUERY_RE.test(t);
    if (wantCollect && wantQuery) {
      return { intent: 'clarify', device, sensor };
    }
    if (wantCollect) return { intent: 'collect', device, sensor };
    if (wantQuery) return { intent: 'query', device, sensor };
    if (/数据|读数|data|reading/i.test(t)) return { intent: 'clarify', device, sensor };
    return { intent: 'clarify', device, sensor };
  }

  /* ---------- LLM 适配槽（可选；不可达即回退） ---------- */
  async function llmNlu(text) {
    const base = process.env.EYE_LLM_BASE_URL;
    const key = process.env.EYE_LLM_API_KEY;
    if (!base || !key) throw new Error('llm not configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: process.env.EYE_LLM_MODEL || 'default',
          messages: [
            { role: 'system', content: '你是嵌入式监测产品的运行时语言接口。只输出 JSON：{"intent":"query|collect|clarify|refuse","device":null或字符串,"sensor":"acc|temp|hum","reason":字符串}。query=读取已保存记录；collect=请求设备立即采集一次；二者皆可能则 clarify；索要坐标/预测等越界能力则 refuse。' },
            { role: 'user', content: text },
          ],
          temperature: 0,
        }),
      });
      if (!res.ok) throw new Error('llm http ' + res.status);
      const j = await res.json();
      const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      const parsed = JSON.parse(content.replace(/^[^{}]*/, '').replace(/[^}]*$/, ''));
      if (!['query', 'collect', 'clarify', 'refuse'].includes(parsed.intent)) throw new Error('bad intent');
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- 受限工具 ---------- */
  function toolQueryLatest(device, sensor) {
    const rows = readRecords({ device: device || null, limit: 100, order: 'desc' });
    const keys = SENSOR_FIELDS[sensor] || SENSOR_FIELDS.acc;
    const row = rows.find((r) => keys.some((k) => typeof (r.fields || {})[k] === 'number'));
    if (!row) {
      return {
        missing: true,
        reply: '没有' + (SENSOR_CN[sensor] || '该传感源') + '的已保存记录（设备 ' + (device || state.deviceId || '未知') + '）。我不能伪造数值；可以先请求一次新采集。',
      };
    }
    const fields = row.fields || {};
    const ageS = row.recv_ts ? (Date.now() - row.recv_ts) / 1000 : null;
    const stale = ageS !== null && ageS * 1000 > (config.staleAfterMs || 5000);
    const observedAt = fields.iso || row.board_iso || null;
    const evidence = {
      device_id: row.device_id, seq: row.seq, sensor,
      value: keys.reduce((o, k) => (typeof fields[k] === 'number' ? (o[k] = fields[k], o) : o), {}),
      observed_at: observedAt, received_at: row.recv_iso || null,
      age_s: ageS === null ? null : Math.round(ageS * 10) / 10, stale,
    };
    let reply = '最近一次' + (SENSOR_CN[sensor] || '') + '记录来自 ' + row.device_id + '（seq ' + row.seq + '）：' +
      fmtVal(fields, sensor) + '。采集时间 ' + (observedAt || '板端未带墙钟') +
      '，服务端接收 ' + (row.recv_iso || '?') + '（' + (ageS === null ? '?' : ageS.toFixed(1)) + 's 前）。';
    if (stale) reply += ' 数据未更新：以上为最后一次成功采集的值，保留原采集时间。';
    return { evidence, reply };
  }

  async function toolRequestCollect(device) {
    const r = createCollectRequest();
    const rid = r.request_id;
    const deadline = Date.now() + (collectTimeoutMs() || 8000) + 1500;
    let cur = REQUESTS.get(rid);
    while (Date.now() < deadline) {
      cur = REQUESTS.get(rid);
      if (cur && ['completed', 'timeout', 'failed'].includes(cur.status)) break;
      await new Promise((res2) => setTimeout(res2, 200));
    }
    cur = REQUESTS.get(rid) || cur;
    const stage = cur ? cur.status : 'failed';
    if (stage === 'completed') {
      const obs = cur.observation && (cur.observation.fields || cur.observation);
      const reply = '已收到本次新观测（request_id=' + rid + '，seq ' + (cur.seq_observed ?? '?') + '）：' +
        fmtVal(obs || {}, 'acc') + '。该观测携带本次 request_id，不是库中旧值。';
      return { evidence: { request_id: rid, stage, observation: obs || null, seq: cur.seq_observed ?? null }, reply };
    }
    const reply = '本次没有收到新观测（请求 ' + rid + ' 状态：' + stage + '）。' +
      (stage === 'timeout' ? '超时不代表硬件故障；也未以旧值冒充本次结果。' : '命令通道或设备执行异常，详见请求记录。');
    return { evidence: { request_id: rid, stage, observation: null }, reply };
  }

  /* ---------- 入口 ---------- */
  async function ask(body) {
    const text = String((body && body.text) || '');
    let mode = 'rule';
    let fallback = false;
    let nlu = null;
    if (process.env.EYE_LLM_BASE_URL && process.env.EYE_LLM_API_KEY) {
      try {
        nlu = await llmNlu(text);
        mode = 'llm';
      } catch (_) {
        fallback = true;
      }
    }
    if (!nlu) nlu = ruleNlu(text);

    // 设备范围校验（显式参数优先于文本抽取）
    let device = body && body.device ? String(body.device) : (nlu.device || null);
    if (device && !knownDevices().has(device)) {
      return {
        ok: true, mode, fallback, intent: 'refuse', tool: null,
        params: { device, sensor: nlu.sensor || 'acc' },
        reply: '设备 ' + device + ' 不在本组已知设备范围内（已知：' +
          [...knownDevices()].join(', ') + ' 或空）。越界请求不执行。',
        refused: true, evidence: null,
      };
    }
    if (!device) device = state.deviceId || config.expectedDeviceId || null;
    const sensor = nlu.sensor || 'acc';
    const params = { device, sensor };

    if (nlu.intent === 'refuse') {
      return { ok: true, mode, fallback, intent: 'refuse', tool: null, params, refused: true, evidence: null, reply: nlu.reason + ' 可用的受限工具只有：查询已保存记录、请求一次新采集。' };
    }
    if (nlu.intent === 'clarify') {
      return {
        ok: true, mode, fallback, intent: 'clarify', tool: null, params,
        clarify: ['查看最近一次已保存的记录', '请求设备立即采集一次新数据'],
        reply: '这句话既可以理解为查询旧记录，也可以理解为请求新采集。请二选一：1) 查看上次数据；2) 重新采集一次。',
        evidence: null,
      };
    }
    if (nlu.intent === 'query') {
      const out = toolQueryLatest(device, sensor);
      if (out.missing) {
        return { ok: true, mode, fallback, intent: 'query', tool: 'query_latest', params, refused: false, evidence: { missing: true, device_id: device, sensor }, reply: out.reply };
      }
      return { ok: true, mode, fallback, intent: 'query', tool: 'query_latest', params, evidence: out.evidence, reply: out.reply };
    }
    // collect
    const out = await toolRequestCollect(device);
    return { ok: true, mode, fallback, intent: 'collect', tool: 'request_collect', params, evidence: out.evidence, reply: out.reply };
  }

  return { ask, ruleNlu };
};
