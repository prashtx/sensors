'use strict';

var _ = require('lodash');
var csvWriter = require('csv-write-stream');
var logfmt = require('logfmt');

var sequelize = require('../sequelize');
var util = require('../util');

var MAX_RESPONSE_COUNT = 1000;

// Return the number of seconds represented by str
function parseResolution(str) {
  if (str === undefined || str === null) {
    return str;
  }
  var tmp;

  var len = str.length;
  if (len > 1) {
    if (str[len - 1] === 'm') {
      // Minutes
      tmp = parseInt(str.substring(0, len - 1), 10);
      if (isNaN(tmp)) {
        return null;
      }
      return tmp * 60;
    } else if (str[len - 1] === 'h') {
      // Hours
      tmp = parseInt(str.substring(0, len - 1), 10);
      if (isNaN(tmp)) {
        return null;
      }
      return tmp * 60 * 60;
    } else if (str[len - 1] === 's') {
      // Seconds
      tmp = parseInt(str.substring(0, len - 1), 10);
      if (isNaN(tmp)) {
        return null;
      }
      return tmp;
    }
  }
  return null;
}

var selectorTemplate = _.template('float8(rollup.data->>:field${i}) AS "${i}"');

// Supported query parameters:
// op: {mean|max|min}
// each.sources: comma-separated source IDs
// over.city: aggregate over all sources with matching source.data.city
// fields: comma-separated fields to include
// from, before: (required)
// resolution: ex. 1h or 20m
exports.get = function get(req, res) {
  var format = req.params.format || 'json';

  var op = req.query.op || 'mean';
  var resolution = parseResolution(req.query.resolution);
  var from = new Date(req.query.from);
  var before = new Date(req.query.before);
  // TODO: Support aggregation over a set of sources, not just for each source.
  var sources = req.query['each.sources'];
  var city = req.query['over.city'];
  var fields = req.query.fields;

  // Validate the query parameters

  if (sources) {
    sources = sources.split(',');
  }

  if (!sources && !city) {
    res.status(400).send({
      name: 'SyntaxError',
      message: 'Must specify each.sources or over.city'
    });
    return;
  }

  if (!fields) {
    res.status(400).send({
      name: 'SyntaxError',
      message: 'Must specify fields parameter'
    });
    return;
  }
  fields = fields.split(',');

  if (!resolution) {
    res.status(400).send({
      name: 'SyntaxError',
      message: 'Must specify resolution parameter'
    });
    return;
  }

  if (!util.validTimeRangeLength({
    from: from,
    before: before,
    resolution: resolution
  }, MAX_RESPONSE_COUNT)) {
    res.status(400).send({
      name: 'RangeError',
      message: 'Time range represents more than the maximum ' + MAX_RESPONSE_COUNT + ' possible results per query'
    });
    return;
  }

  var fieldNames = [];
  var fieldSelectors = [];
  var fieldMap = [];
  var subs = {
    resolution: resolution,
    from: from,
    before: before,
    fields: fields,
    op: op
  };

  fields.forEach(function (name, i) {
    // Don't use the actual field names in the template, so we avoid SQL
    // injection opportunities.
    fieldNames.push(':field' + i);
    fieldSelectors.push(selectorTemplate({ i: i }));
    subs['field' + i] = name;
    fieldMap[i] = name;
  });

  var query;
  if (sources) {
    subs.sources = sources;
    query = sequelize.query('SELECT ' +
      'sourcelist.source, ' +
      'rollup.t AS "timestamp", ' +
      fieldSelectors.join(', ') +
      ' FROM (SELECT unnest::CHARACTER(25) AS source FROM unnest(:sources)) AS sourcelist, ' +
      'LATERAL (SELECT to_timestamp(trunc(EXTRACT(EPOCH FROM r.ts) / :resolution) * :resolution) AS t, ' +
      'rollup_pick(rollup_agg(r.data), :fields, :op) AS data ' +
      'FROM rollup_5min AS r ' +
      'WHERE r.source = sourcelist.source ' +
      'AND r.ts >= :from::TIMESTAMPTZ ' +
      'AND r.ts < :before::TIMESTAMPTZ ' +
      'GROUP BY t ORDER BY t) AS rollup', null, {
        raw: true
    }, subs);
  } else if (city) {
    subs.city = city;
    query = sequelize.query('SELECT ' +
      ':city AS city, ' +
      'rollup.t AS "timestamp", ' +
      fieldSelectors.join(', ') +
      ' FROM (SELECT ' +
      'to_timestamp(trunc(EXTRACT(EPOCH FROM r.ts) / (:resolution)) * :resolution) AS t, ' +
      'rollup_pick(rollup_agg(r.data), :fields, :op) AS data ' +
      'FROM rollup_5min r, sources s ' +
      'WHERE r.source = s.source AND s.data->>\'city\' = :city ' +
      'AND r.ts >= :from::timestamp with time zone ' +
      'AND r.ts < :before::timestamp with time zone ' +
      'GROUP BY t ORDER BY t) AS rollup', null, {
        raw: true
      }, subs);
  } else {
    // No sources were specified, neither directly nor indirectly.
    // We have already validated the query parameters, so we should never get
    // here.
    res.sendStatus(500);
    return;
  }

  query.then(function (results) {
    var chained = _(results).map(function (item) {
      var out = {};
      _.keys(item).forEach(function (key) {
        var newKey = fieldMap[key];
        if (newKey) {
          out[newKey] = item[key];
        } else {
          out[key] = item[key];
        }
      });
      return out;
    });

    if (format === 'csv') {
      // CSV
      res.type('text/csv');
      res.status(200);
      var keys = Object.keys(chained.first() || {});

      // Make sure the timestamp field is first, since it is the x-axis.
      // Make sure the data fields are in the order specified by the query
      // parameter.
      var headers = _(keys)
      .difference(['timestamp'])
      .difference(fields)
      .unshift('timestamp')
      .concat(fields).value();

      var writer = csvWriter({
        // Preserve specified ordering of the fields
        headers: headers
      });

      writer.pipe(res);
      chained.forEach(function (item) {
        item.timestamp = item.timestamp.toISOString();
        writer.write(item);
      }).value();
      writer.end();
    } else {
      // JSON
      var out = {
        links: {
          prev: util.resolveQuery(req, {
            from: (new Date(2*from.getTime() - before.getTime())).toISOString(),
            before: from.toISOString()
          }),
          next: util.resolveQuery(req, {
            from: before.toISOString(),
            before: (new Date(2*before.getTime() - from.getTime())).toISOString()
          })
        },
        data: chained.value()
      };
      res.status(200).send(out);
    }
  }).catch(function (error) {
    logfmt.error(error);
    res.sendStatus(500);
  });
};