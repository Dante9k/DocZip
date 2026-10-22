import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const safeRoot = path.resolve(root);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};
const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(root, '.' + relative);
    if (!file.startsWith(safeRoot + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    const bytes = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-DocZip-Local': '1',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
const portFlag = process.argv.find((a) => a.startsWith('--port='));
let port = Number(portFlag?.slice(7) || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
let retries = 0;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && retries++ < 20 && port < 65535) {
    server.listen(++port, '127.0.0.1');
  } else {
    console.error('无法启动本地网页：', error.message);
    process.exitCode = 1;
  }
});
server.on('listening', () => {
  const url = 'http://127.0.0.1:' + port;
  console.log(
    '\nDocZip 本地网页版\n' +
      url +
      '\n\n文档仅在浏览器处理，不上传。\n使用期间请保留此窗口；按 Ctrl+C 停止服务。\n',
  );
  if (process.argv.includes('--open') && process.platform === 'win32') {
    // Static localhost URL: no user-controlled text is passed to the shell.
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '', url], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', () => console.log('请在浏览器中打开上面的地址。'));
  }
});
server.listen(port, '127.0.0.1');
