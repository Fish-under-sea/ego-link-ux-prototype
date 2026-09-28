/**
 * 串口监听：原样打印开发板发出的每一个字节（不做任何解析/加工）。
 * 用法: node test/listen.js <端口> [秒数] [dtr 1/0] [rts 1/0]
 * 例:   node test/listen.js COM4 25 1 0
 */
const { SerialPort } = require('serialport');

const portPath = process.argv[2] || 'COM4';
const secs = Number(process.argv[3] || 20);
const dtr = process.argv[4] !== '0';
const rts = process.argv[5] === '1';

const p = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });
let total = 0;

p.on('data', (c) => {
  total += c.length;
  const text = c.toString('utf8');
  console.log(`[${new Date().toLocaleTimeString()}] ${String(c.length).padStart(4)}B | ${JSON.stringify(text)}`);
  if (/[^\x20-\x7e\r\n\t]/.test(text)) console.log(`      hex: ${c.toString('hex')}`);
});
p.on('error', (e) => console.log('[ERR]', e.message));

p.open((err) => {
  if (err) { console.log('打开失败:', err.message); process.exit(1); }
  console.log(`已打开 ${portPath}，监听 ${secs}s`);
  p.set({ dtr, rts }, (e) => console.log(`DTR=${dtr} RTS=${rts} ${e ? '设置失败:' + e.message : '已设置'}`));

  // 有些固件在等主机先说话，试探一下
  setTimeout(() => { console.log('>>> 发送 CRLF'); p.write('\r\n'); }, 4000);
  setTimeout(() => { console.log('>>> 发送 AT'); p.write('AT\r\n'); }, 10000);
  setTimeout(() => { console.log('>>> 发送 ?'); p.write('?\r\n'); }, 16000);

  setTimeout(() => {
    console.log(`\n==== 共收到 ${total} 字节 ====`);
    p.close(() => process.exit(0));
  }, secs * 1000);
});
