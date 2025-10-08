const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const URL = process.env.LS_URL || 'http://localhost:3001';
const USER = process.env.LS_USER || '';
const PASS = process.env.LS_PASS || '';
const PATHNAME = process.env.LS_PATH || '/socket.io';
const OUT = process.env.LS_OUT || `lockstone-logs-${new Date().toISOString().replace(/[:]/g, '-')}.jsonl`;
const ORIGIN = process.env.LS_ORIGIN; // optional: set to your site origin if CORS is strict

const headers = {};
if (USER && PASS) headers['Authorization'] = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
if (ORIGIN) headers['Origin'] = ORIGIN;

const socket = io(URL, {
  path: PATHNAME,
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  auth: (USER && PASS) ? { user: USER, pass: PASS } : undefined,
  extraHeaders: headers,
});

const out = fs.createWriteStream(path.resolve(OUT), { flags: 'a' });
const write = (obj) => { try { out.write(JSON.stringify(obj) + '\n'); } catch {} };

socket.on('connect', () => {
  // eslint-disable-next-line no-console
  console.log('connected', socket.id);
  write({ _event: 'connect', ts: new Date().toISOString(), id: socket.id });
});
socket.on('disconnect', (reason) => {
  // eslint-disable-next-line no-console
  console.log('disconnect', reason);
  write({ _event: 'disconnect', ts: new Date().toISOString(), reason });
});
socket.on('connect_error', (err) => {
  // eslint-disable-next-line no-console
  console.error('connect_error', err && (err.message || err));
  write({ _event: 'connect_error', ts: new Date().toISOString(), error: String((err && (err.message || err)) || 'unknown') });
});

socket.on('log', (evt) => write({ _event: 'log', ...evt }));

['tx:start', 'tx:resolved', 'tx:sim.ok', 'tx:sim.err', 'tx:send.ok', 'tx:send.err', 'system'].forEach((name) => {
  socket.on(name, (payload) => write({ _event: name, payload, ts: new Date().toISOString() }));
});

function quit() {
  try { socket.close(); } catch {}
  try { out.end(); } catch {}
  process.exit(0);
}
process.on('SIGINT', quit);
process.on('SIGTERM', quit);


