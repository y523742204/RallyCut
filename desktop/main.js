// RallyCut 桌面版入口 (Electron).
// 应用是纯静态站点 (out/), 但 file:// 协议下 ES module / Web Worker / wasm 会被浏览器拦截,
// 所以内嵌一个 127.0.0.1 静态服务器来加载, 对外仍是零网络的本地软件.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = '/RallyCut';
const root = app.isPackaged
  ? path.join(process.resourcesPath, 'out')
  : path.join(__dirname, '..', 'out');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serve(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  // 站点按 GitHub Pages 子路径 /RallyCut 构建, 本地把前缀剥掉映射回产物根目录
  if (p === BASE) p = '/';
  else if (p.startsWith(BASE + '/')) p = p.slice(BASE.length);
  let f = path.join(root, p);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

let server = null;

app.whenReady().then(() => {
  server = http.createServer(serve).listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const win = new BrowserWindow({
      width: 1280,
      height: 860,
      title: 'RallyCut',
      backgroundColor: '#f6f8f7',
      autoHideMenuBar: true,
    });
    win.loadURL(`http://127.0.0.1:${port}${BASE}/`);
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();
  app.quit();
});
