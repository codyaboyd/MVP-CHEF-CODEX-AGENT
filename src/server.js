require('dotenv').config();

const path = require('node:path');
const express = require('express');
const morgan = require('morgan');
const routes = require('./routes');
require('./services/runStateManager').recoverInterruptedRuns();

const app = express();
const port = Number(process.env.PORT) || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/bootstrap', express.static(path.join(__dirname, '..', 'node_modules', 'bootstrap', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

app.use(routes);

app.use((req, res) => {
  res.status(404).render('404', {
    title: 'Recipe Not Found'
  });
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', {
    title: 'Kitchen Mishap',
    error: process.env.NODE_ENV === 'production' ? null : err
  });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`🍳 MVP Chef Codex is simmering at http://localhost:${port}`);
  });
}

module.exports = app;
