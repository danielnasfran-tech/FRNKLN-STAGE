'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const api = require('./api');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.set('trust proxy', true);
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());

app.use('/api', api);

// Service worker: nunca deve ser cacheado por proxies/browser.
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else if (filePath.endsWith('.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  })
);

// SPA fallback: rotas do app são resolvidas no cliente.
app.get(/^(?!\/api).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  if (err) {
    console.error('[erro]', err.message);
    return res.status(500).json({ error: 'server_error', message: 'Erro interno do servidor.' });
  }
  return next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FRNKLN STAGE ouvindo em http://0.0.0.0:${PORT}`);
});
