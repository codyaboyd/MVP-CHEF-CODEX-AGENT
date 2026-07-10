require('dotenv').config();

const path = require('node:path');
const express = require('express');
const morgan = require('morgan');
const logRedaction = require('./services/logRedactionService');
const routes = require('./routes');
require('./services/runStateManager').recoverInterruptedRuns();

const app = express();
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev', {
  stream: {
    write: (message) => process.stdout.write(logRedaction.redact(message))
  },
  skip: (req) => /(?:token|key|secret|password|auth|cookie|session)/i.test(req.originalUrl)
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/bootstrap', express.static(path.join(__dirname, '..', 'node_modules', 'bootstrap', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'mvp-chef-codex' });
});

app.use(routes);

app.use((req, res) => {
  res.status(404).render('404', {
    title: 'Recipe Not Found'
  });
});

app.use((err, req, res, _next) => {
  console.error(logRedaction.redact(err?.stack || err?.message || err));
  res.status(500).render('error', {
    title: 'Kitchen Mishap',
    error: process.env.NODE_ENV === 'production' ? null : logRedaction.errorForView(err)
  });
});

if (require.main === module) {
  app.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`🍳 MVP Chef Codex is simmering at http://${displayHost}:${port}`);
  });
}

module.exports = app;
