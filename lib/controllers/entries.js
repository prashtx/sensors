'use strict';

var util = require('../util');

var Entry = require('../models/Entry');

var CAP = 1000;
// POST /api/sources/:source/entries
// {
//   timestamp: 1418452398629
//   foo: 1.23,
//   bar: 77.3,
//   baz: 0.2,
//   loc: [-44, 77]
// }
exports.post = function post(req, res) {
  // TODO: Provide useful error messages to the client.
  if (!req.body.timestamp) {
    res.status(400).json({});
    return;
  }

  var timestamp = req.body.timestamp;
  req.body.timestamp = undefined;

  Entry.create({
    source: req.params.source,
    timestamp: timestamp,
    data: req.body
  }).then(function () {
    res.sendStatus(201);
  }).catch(function (error) {
    console.log(error);
    console.log(error.stack);
    res.sendStatus(500);
  });
};

exports.list = function list(req, res) {
  var startIndex = util.tryParseInt(req.query.startIndex) || 0;
  var count = util.tryParseInt(req.query.count) || 10;
  var sort = req.query.sort;

  if (count > CAP) {
    res.status(400).json({
      message: "The count query parameter is capped at " + CAP + "."
    });
    return;
  }

  var where = {
    source: req.params.source
  };

  var order  = 'ts ASC';

  if (sort === 'desc') {
    order = 'ts DESC';
  }

  Entry.findAll({
    where: where,
    order: order,
    offset: startIndex,
    limit: count
  }, {
    raw: true
  }).then(function (entries) {
    res.status(200).json(entries);
  }).catch(function (error) {
    console.log(error);
    console.log(error.stack);
    res.sendStatus(500);
  });
};
