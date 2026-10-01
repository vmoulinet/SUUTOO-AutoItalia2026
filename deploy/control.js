// Tiny always-on helper (systemd service "suutoo-control").
// Lets the admin page shown on the Pi's own screen (kiosk) start/stop the main SUUTOO server,
// even when that server is down and cannot answer itself.
//   POST http://localhost:8081/start   POST http://localhost:8081/stop
// Listens on the loopback interface only, and only accepts calls coming from the admin page.
const http = require('http');
const { execFile } = require('child_process');

const PORT = 8081;
const SERVICE = 'suutoo';
const ALLOWED_ORIGINS = new Set(['http://localhost:8080', 'http://127.0.0.1:8080']);

http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (!ALLOWED_ORIGINS.has(origin)) { res.writeHead(403); return res.end('Forbidden'); }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const m = req.url.match(/^\/(start|stop)$/);
  if (req.method !== 'POST' || !m) { res.writeHead(404); return res.end('Not found'); }

  console.log(`${new Date().toISOString()} ${m[1]} ${SERVICE}`);
  execFile('sudo', ['-n', 'systemctl', m[1], SERVICE], (err) => {
    if (err) { res.writeHead(500); return res.end(err.message); }
    res.writeHead(200); res.end('ok');
  });
}).listen(PORT, '127.0.0.1', () => console.log(`SUUTOO control listening on 127.0.0.1:${PORT}`));
