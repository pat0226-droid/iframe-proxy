/* Advanced proxy with iframe support and HTTPS fallback
 * Author: Nick-ready with mkcert, CSP/XFO rewrites, cookies, WebSockets
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const compression = require('compression');
const morgan = require('morgan');

const app = express();

// ---- Config ----
const TARGET = process.env.TARGET || 'https://example.com'; // Change or pass via env
const HOST = process.env.HOST || 'localhost';
const PORT = Number(process.env.PORT || 8443); // HTTPS preferred
const FALLBACK_PORT = Number(process.env.FALLBACK_PORT || 8080); // HTTP fallback
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, 'certs');
const CERT_KEY = process.env.CERT_KEY || path.join(CERT_DIR, 'localhost-key.pem');
const CERT_CRT = process.env.CERT_CRT || path.join(CERT_DIR, 'localhost.pem');

// Public URL of the proxy itself (used in rewrites and CSP frame-ancestors)
const PROXY_ORIGIN_HTTPS = `https://${HOST}:${PORT}`;
const PROXY_ORIGIN_HTTP = `http://${HOST}:${FALLBACK_PORT}`;

// ---- Middleware ----
app.disable('x-powered-by');
app.use(compression());
app.use(morgan('dev'));

// Allow embedding of the proxy page itself
app.use((req, res, next) => {
  // CORS: keep permissive for iframe usage from same origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

  // Prevent COOP/COEP/CORP from breaking iframes (do not set them)
  next();
});

// Utility: normalize cookies to support cross-site iframe when using HTTPS
function normalizeSetCookie(headers, isHttps) {
  const setCookie = headers['set-cookie'];
  if (!setCookie || !Array.isArray(setCookie)) return;

  headers['set-cookie'] = setCookie.map((cookie) => {
    let c = cookie;

    // Ensure Secure when HTTPS
    if (isHttps && !/;\s*Secure/i.test(c)) c += '; Secure';

    // For cross-site iframe, SameSite=None is typically required
    if (!/;\s*SameSite=/i.test(c)) c += '; SameSite=None';

    return c;
  });
}

// Utility: rewrite Location headers so navigations stay inside the proxy
function rewriteLocationHeader(headers, req) {
  const location = headers['location'];
  if (!location) return;
  try {
    const u = new URL(location, TARGET);
    // Rewrite to proxy path /proxy/<full-path-and-query>
    const proxied = `${getProxyOrigin(req)}/proxy${u.pathname}${u.search}`;
    headers['location'] = proxied;
  } catch {
    // ignore
  }
}

// Decide current proxy origin
function getProxyOrigin(req) {
  const proto = (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') ? 'https' : 'http';
  const port = proto === 'https' ? PORT : FALLBACK_PORT;
  return `${proto}://${HOST}:${port}`;
}

// ---- Proxy: main route ----
// All traffic proxied under /proxy/* to avoid clashing with root app routes
app.use('/proxy', createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  ws: true,               // WebSocket support
  secure: false,          // accept self-signed upstream if necessary
  selfHandleResponse: true, // lets us intercept and rewrite response bodies/headers
  onProxyReq: (proxyReq, req, res) => {
    // Rewrite host header to target
    const t = new URL(TARGET);
    proxyReq.setHeader('Host', t.host);

    // Keep original cookies and headers flowing
    // Optional: strip Accept-Encoding to simplify body transforms
    const acceptEncoding = proxyReq.getHeader('accept-encoding');
    if (acceptEncoding) proxyReq.removeHeader('accept-encoding');

    // If the upstream expects a specific Origin/Referer, consider mirroring target
    // proxyReq.setHeader('Origin', t.origin);
    // proxyReq.setHeader('Referer', t.origin);
  },
  onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
    const isHttps = !!req.socket.encrypted;

    // Normalize cookies for cross-site iframe usage
    normalizeSetCookie(proxyRes.headers, isHttps);

    // Rewrite Location headers for redirects to stay inside proxy
    rewriteLocationHeader(proxyRes.headers, req);

    // Neutralize X-Frame-Options to allow embedding
    // prefer CSP frame-ancestors over XFO; remove XFO entirely
    if ('x-frame-options' in proxyRes.headers) {
      delete proxyRes.headers['x-frame-options'];
    }

    // Relax Content-Security-Policy: ensure frame-ancestors allows our proxy origin
    if ('content-security-policy' in proxyRes.headers) {
      const csp = proxyRes.headers['content-security-policy'];
      const origin = getProxyOrigin(req);

      // Update frame-ancestors directive or append if missing
      const hasFrameAncestors = /frame-ancestors/i.test(csp);
      let newCsp = csp;
      if (hasFrameAncestors) {
        newCsp = newCsp.replace(/frame-ancestors[^;]*/i, `frame-ancestors ${origin} 'self' *`);
      } else {
        newCsp += `; frame-ancestors ${origin} 'self' *`;
      }
      proxyRes.headers['content-security-policy'] = newCsp;
    } else {
      // If CSP missing, add a permissive frame-ancestors
      proxyRes.headers['content-security-policy'] = `frame-ancestors ${getProxyOrigin(req)} 'self' *`;
    }

    // Optional HTML rewriting (basic): fix relative links to remain under /proxy
    // Only apply to text/html responses
    const contentType = proxyRes.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');

    if (!isHtml) {
      return responseBuffer; // pass-through for non-HTML
    }

    let body = responseBuffer.toString('utf-8');
    const targetUrl = new URL(TARGET);

    // Inject a <base> tag so relative paths resolve at target origin, while we intercept nav via /proxy
    // If there's already a <base>, we won't double-inject
    const hasBase = /<base\s+/i.test(body);
    if (!hasBase) {
      body = body.replace(/<head[^>]*>/i, (m) => `${m}\n<base href="${targetUrl.origin}">`);
    }

    // Lightweight rewrite: replace absolute target origin with /proxy root
    // e.g., https://example.com/path -> /proxy/path
    const originRegex = new RegExp(targetUrl.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    body = body.replace(originRegex, `${getProxyOrigin(req)}/proxy`);

    // Prevent Service Workers from registering (they can interfere with proxy/iframe behavior)
    body = body.replace(/navigator\.serviceWorker\.register\s*\(/g, '/* sw blocked */ (');

    // Ensure the page can be embedded without JS blocking via framebusting code
    // Common pattern: if (top !== self) top.location = self.location;
    body = body.replace(/top\.location\s*=\s*self\.location/g, '/* framebust neutralized */ void 0');

    return body;
  })
}));

// Root: simple info and embed demo
app.get('/', (req, res) => {
  const origin = getProxyOrigin(req);
  res.type('html').send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Proxy home</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; }
      iframe { width: 100%; height: 80vh; border: 1px solid #bbb; border-radius: 8px; }
    </style>
  </head>
  <body>
    <h1>Proxy</h1>
    <p>Embedding target inside an iframe below. Change TARGET via env.</p>
    <iframe src="${origin}/proxy" referrerpolicy="no-referrer-when-downgrade" sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>
  </body>
</html>
`);
});

// ---- HTTPS fallback logic ----
function startServers() {
  let httpsServer;
  try {
    const key = fs.readFileSync(CERT_KEY);
    const cert = fs.readFileSync(CERT_CRT);
    httpsServer = https.createServer({ key, cert }, app);
    httpsServer.listen(PORT, HOST, () => {
      console.log(`HTTPS proxy listening at https://${HOST}:${PORT} → ${TARGET}`);
    });
    httpsServer.on('error', (err) => {
      console.error('HTTPS server error:', err);
      startHttpFallback();
    });
  } catch (e) {
    console.warn('HTTPS certs not found or invalid, falling back to HTTP:', e.message);
    startHttpFallback();
  }
}

function startHttpFallback() {
  const httpServer = http.createServer(app);
  httpServer.listen(FALLBACK_PORT, HOST, () => {
    console.log(`HTTP proxy listening at http://${HOST}:${FALLBACK_PORT} → ${TARGET}`);
    console.log('Note: For cross-site cookies in iframes, HTTPS is recommended.');
  });
  httpServer.on('error', (err) => {
    console.error('HTTP server error:', err);
  });
}

startServers();
