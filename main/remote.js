// Phone / tablet remote: a small web page plus an HTTP API on the local
// network, so someone other than the operator (or the presenter) can drive
// the prompter. Also usable from Bitfocus Companion or a Stream Deck with
// generic HTTP requests:  GET /api/cmd?c=toggle   GET /api/cmd?c=speed&v=6
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

class RemoteServer {
  constructor({ state, command }) {
    this.state = state;
    this.command = command;
    this.server = null;
    this.port = null;
    this.error = null;
  }

  get status() {
    return { running: !!this.server, port: this.port, error: this.error, urls: this.server ? localIPv4().map((ip) => `http://${ip}:${this.port}`) : [] };
  }

  start(port) {
    this.stop();
    this.error = null;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('error', (e) => {
      this.error = e.code === 'EADDRINUSE' ? `Port ${port} is in use` : e.message;
      this.server = null;
      this.port = null;
    });
    server.listen(port, '0.0.0.0');
    this.server = server;
    this.port = port;
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
    this.port = null;
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/' || url.pathname === '/index.html') {
      fs.readFile(PAGE, (err, data) => {
        if (err) return json(500, { ok: false });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }
    if (url.pathname === '/api/state') return json(200, this.state());
    if (url.pathname === '/api/cmd') {
      const c = url.searchParams.get('c') || url.searchParams.get('cmd');
      const v = url.searchParams.get('v') ?? url.searchParams.get('value');
      const ok = this.command(c, v);
      return json(ok === false ? 400 : 200, { ok: ok !== false, state: this.state() });
    }
    json(404, { ok: false, message: 'Not found' });
  }
}

module.exports = { RemoteServer, localIPv4 };
