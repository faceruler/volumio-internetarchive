'use strict';

// Browse UX: case-insensitive artist merge, newest dates first,
// date rows include venue/title, source rows always shown.

var assert = require('assert');
var path = require('path');

process.chdir(path.join(__dirname, '..'));

function fakeContext() {
  return {
    coreCommand: {
      pluginManager: {
        getConfigurationFile: function() { return path.join(__dirname, '..', 'config.json'); },
        getPlugin: function() { return {}; }
      },
      volumioAddToBrowseSources: function() {},
      sharedVars: { get: function() { return 'en'; } },
      i18nJson: function() { return { then: function() { return { fail: function() {} }; } }; },
      pushToastMessage: function() {},
      stateMachine: { getTrack: function() { return {}; }, currentPosition: 0 },
      servicePushState: function() {}
    },
    logger: { info: function() {}, error: function() {} },
    configManager: {}
  };
}

var Controller = require('../index.js');
var plugin = new Controller(fakeContext());
plugin.config = {
  get: function(k, d) {
    if (k === 'collections') return 'etree';
    if (k === 'resultsLimit') return 100;
    if (k === 'artistIndexThreshold') return 4000;
    return d;
  },
  set: function() {},
  loadFile: function() {}
};
plugin.serviceName = 'volumio-internetarchive';
plugin.loadI18nStrings();

var fails = 0;
function check(cond, msg) {
  try {
    assert(cond, msg);
    console.log('PASS: ' + msg);
  } catch (e) {
    fails++;
    console.log('FAIL: ' + msg);
  }
}

function asP(p) {
  return new Promise(function(res, rej) { p.then(res).fail(rej); });
}

function stubQuery(docsOrJson) {
  plugin.runQuery = function(cmd, defer, context, onSuccess) {
    var payload = typeof docsOrJson === 'string' ? docsOrJson : JSON.stringify(docsOrJson);
    try { onSuccess(payload); } catch (e) { defer.reject(e); }
  };
}

// --- artist case merge ---
var names = plugin.flattenCreators(['phish', 'Phish', 'PHISH', 'Trey Anastasio']);
check(names.filter(function(n) { return n.toLowerCase() === 'phish'; }).length === 1,
  'flattenCreators merges Phish casing (got ' + JSON.stringify(names) + ')');
check(names.indexOf('Phish') !== -1 || names.indexOf('PHISH') !== -1,
  'prefers mixed/upper display over all-lowercase (got ' + JSON.stringify(names) + ')');
check(plugin.creatorMatches('phish', 'Phish'), 'creatorMatches is case-insensitive');
check(plugin.creatorMatches(['phish', 'Trey'], 'Phish'), 'creatorMatches array is case-insensitive');

plugin.sizeCache = { etree: 100 };
stubQuery(JSON.stringify(['phish', 'Phish', 'Trey Anastasio']));
asP(plugin.listArtists('etree', 'internetarchive/c/etree')).then(function(resp) {
  var titles = resp.navigation.lists[0].items.map(function(it) { return it.title; });
  check(titles.filter(function(t) { return t.toLowerCase() === 'phish'; }).length === 1,
    'artist list has one Phish (got ' + JSON.stringify(titles) + ')');
}).then(function() {
  stubQuery([
    { creator: 'Phish', year: '2024', date: '2024-07-01T00:00:00Z' },
    { creator: 'Phish', year: '1997', date: '1997-11-22T00:00:00Z' },
    { creator: 'phish', year: '2019', date: '2019-12-31T00:00:00Z' }
  ]);
  return asP(plugin.listYears('etree', 'internetarchive/c/etree/artist/Phish'));
}).then(function(resp) {
  var years = resp.navigation.lists[0].items.map(function(it) { return it.title; });
  check(years.indexOf('2019') !== -1, 'case-insensitive year match includes phish docs');
  check(years[0] === '2024' && years[years.length - 1] === '1997',
    'years newest first (got ' + JSON.stringify(years) + ')');
}).then(function() {
  stubQuery([
    {
      creator: 'Phish',
      date: '1997-11-22T00:00:00Z',
      venue: 'Hampton Coliseum',
      coverage: 'Hampton, VA',
      title: 'Phish Live at Hampton Coliseum on 1997-11-22',
      source: 'SBD > DAT',
      identifier: 'phish1997-11-22.sbd'
    },
    {
      creator: 'Phish',
      date: '1997-12-07T00:00:00Z',
      venue: '',
      coverage: '',
      title: 'Phish Live at Madison Square Garden on 1997-12-07',
      source: 'AUD',
      identifier: 'phish1997-12-07.aud'
    },
    {
      creator: 'Phish',
      date: '1997-08-16T00:00:00Z',
      venue: 'The Gorge',
      coverage: 'George, WA',
      title: 'Phish 1997-08-16',
      source: 'Matrix',
      identifier: 'phish1997-08-16.mtx'
    }
  ]);
  return asP(plugin.listShows('etree', 'internetarchive/c/etree/year/Phish/1997'));
}).then(function(resp) {
  var items = resp.navigation.lists[0].items;
  var titles = items.map(function(it) { return it.title; });
  check(titles[0].indexOf('Dec') !== -1 || titles[0].indexOf('1997-12') !== -1,
    'shows newest first (got ' + JSON.stringify(titles) + ')');
  check(titles.some(function(t) { return /Hampton/i.test(t); }),
    'show row includes venue (got ' + JSON.stringify(titles) + ')');
  check(titles.some(function(t) { return /Madison Square Garden/i.test(t); }),
    'show row falls back to title/venue parse when venue field empty');
  check(titles.some(function(t) { return /SBD/i.test(t) || /DAT/i.test(t) || /AUD/i.test(t) || /Matrix/i.test(t); }),
    'show row includes source when present (got ' + JSON.stringify(titles) + ')');
}).then(function() {
  stubQuery([{
    creator: 'Phish',
    identifier: 'phish1997-11-22.sbd',
    source: 'SBD > DAT',
    date: '1997-11-22T00:00:00Z',
    venue: 'Hampton Coliseum',
    coverage: 'Hampton, VA',
    title: 'Phish Live at Hampton Coliseum on 1997-11-22'
  }]);
  return asP(plugin.listSources('etree', 'internetarchive/c/etree/show/Phish/19971122'));
}).then(function(resp) {
  var items = resp.navigation.lists[0] && resp.navigation.lists[0].items;
  check(items && items.length === 1, 'single recording still lists the source (no auto-skip)');
  check(items && /SBD/i.test(items[0].title),
    'source row title is the source string (got ' + (items && items[0] && items[0].title) + ')');
}).then(function() {
  if (fails) {
    console.log('\n' + fails + ' failure(s)');
    process.exit(1);
  }
  console.log('\nall browse-labels checks passed');
}).catch(function(err) {
  console.error(err);
  process.exit(2);
});
