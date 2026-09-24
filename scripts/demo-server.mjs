// Small web server for the demo shop. No dependencies.
// Usage: node scripts/demo-server.mjs [--port 4321]
// Use --port 0 to let the system pick a free port. The first line of output shows it.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '../examples/demo-app/site');
const portArg = process.argv.indexOf('--port');
let port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.PORT || 4321);

// Demo login. Not a real account.
const DEMO_USER = { username: 'demo', password: 'demo123', name: 'Demo User' };
const sessions = new Map();

const products = [
  { id: 'mug', name: 'Coffee Mug', price: 10, image: '/images/mug.svg', alt: 'A blue coffee mug' },
  { id: 'shirt', name: 'T-Shirt', price: 20, image: '/images/shirt.svg', alt: 'A green T-shirt' },
  // Planted accessibility issue: this image has no alt text.
  { id: 'cap', name: 'Baseball Cap', price: 15, image: '/images/cap.svg', alt: null },
];

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function currentUser(req) {
  const match = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '');
  return match ? sessions.get(match[1]) : undefined;
}

async function handleApi(req, res, path) {
  if (path === '/api/products' && req.method === 'GET') return sendJson(res, 200, products);

  // Planted bug: the stock check always fails with a server error.
  if (path === '/api/stock' && req.method === 'GET') {
    return sendJson(res, 500, { error: 'Stock service is not available' });
  }

  if (path === '/api/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    if (username === DEMO_USER.username && password === DEMO_USER.password) {
      const id = randomUUID();
      sessions.set(id, { username, name: DEMO_USER.name });
      return sendJson(
        res,
        200,
        { name: DEMO_USER.name },
        {
          'set-cookie': `session=${id}; HttpOnly; Path=/; SameSite=Lax`,
        },
      );
    }
    return sendJson(res, 401, { error: 'Wrong username or password' });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    return sendJson(
      res,
      200,
      { ok: true },
      {
        'set-cookie': 'session=; HttpOnly; Path=/; Max-Age=0',
      },
    );
  }

  if (path === '/api/me' && req.method === 'GET') {
    const user = currentUser(req);
    // A visitor who is not logged in gets an empty answer, not an error.
    return sendJson(res, 200, user ?? {});
  }

  if (path === '/api/order' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, {
      orderId: `A${Math.floor(1000 + Math.random() * 9000)}`,
      items: body.items ?? [],
    });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

async function serveFile(res, path) {
  // Stay inside the site folder.
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  const file = join(siteDir, safe);
  if (!file.startsWith(siteDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    return res.end(data);
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const path = decodeURIComponent(url.pathname);
  console.log(`${req.method} ${path}`);

  if (path.startsWith('/api/')) return handleApi(req, res, path);

  // Real files first. Other paths load the app, which picks the page from the URL.
  if (extname(path) && (await serveFile(res, path)) !== false) return;
  if (extname(path)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  await serveFile(res, '/index.html');
});

server.listen(port, () => {
  port = server.address().port;
  console.log(`The demo shop is at http://localhost:${port}`);
  console.log('Log in with username "demo" and password "demo123". Press Ctrl+C to stop.');
});
