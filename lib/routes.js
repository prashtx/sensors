'use strict';

var bearerToken = require('express-bearer-token');
var express = require('express');

var aggregations = require('./controllers/aggregations');
var entries = require('./controllers/entries');
var sources = require('./controllers/sources');

var routes = module.exports = new express.Router();

// Route for simple pings.
routes.get('/', function (req, res, next) {
  res.sendStatus(200);
});

routes.use(bearerToken());

// Deprecated. We should specify the API version.
routes.post('/api/sources/:source/entries', sources.validateToken, entries.post);
routes.get('/api/sources/:source/entries', entries.list);

routes.post('/api/v1/sources/:source/entries', sources.validateToken, entries.post);
routes.get('/api/v1/sources/:source/entries', entries.list);
routes.get('/api/v1/sources/:source/entries.:format', entries.list);

routes.post('/api/v1/sources', sources.create);
routes.get('/api/v1/sources/:source', sources.get);

routes.get('/api/v1/aggregations', aggregations.get);
routes.get('/api/v1/aggregations.:format', aggregations.get);
