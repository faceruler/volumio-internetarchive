'use strict';

// Remaining play/browse reliability:
// 4. item metadata is cached (play hits /metadata once, not per track)
// 5. metadata curl uses a 60s max-time (20s was toasting QUERY_ERROR on a Pi)
// 6. artist lists are cached so browse does not re-scrape every open
// plus: array-valued creator must not throw (that toast is QUERY_ERROR)

var assert = require('assert');
var path = require('path');
var fs = require('fs');

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
    if (k === 'collections') return 'aadamjacobs, etree';
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

var src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
check(/DEFAULT_CURL_MAX_TIME\s*=\s*60/.test(src) && /--max-time/.test(src),
  'metadata curl uses --max-time 60');
check(typeof plugin.flattenCreators === 'function', 'flattenCreators is exported');
check(typeof plugin.creatorMatches === 'function', 'creatorMatches is exported');
check(typeof plugin.fetchItemMetadata === 'function', 'fetchItemMetadata is exported');

if (typeof plugin.flattenCreators === 'function') {
  var flat = plugin.flattenCreators(['A', ['B', 'C'], '', null, 'A', '  D  ']);
  check(JSON.stringify(flat) === JSON.stringify(['A', 'B', 'C', 'D']),
    'flattenCreators unwraps arrays and dedupes (got ' + JSON.stringify(flat) + ')');
}

if (typeof plugin.creatorMatches === 'function') {
  check(plugin.creatorMatches('Grateful Dead', 'Grateful Dead'), 'creatorMatches string hit');
  check(!plugin.creatorMatches('Jerry Garcia', 'Grateful Dead'), 'creatorMatches string miss');
  check(plugin.creatorMatches(['Grateful Dead', 'Jerry Garcia'], 'Grateful Dead'),
    'creatorMatches array hit');
  check(!plugin.creatorMatches(['Bob Weir'], 'Grateful Dead'), 'creatorMatches array miss');
}

var meta = {
  metadata: {
    creator: ['Test Band', 'Someone Else'],
    date: '1995-02-03T00:00:00Z',
    venue: 'Some Venue',
    coverage: 'Town'
  },
  files: [
    { name: 't01.mp3', format: 'VBR MP3', source: 'derivative', track: '1', title: 'MP3 1', length: '10' },
    { name: 'cover.jpg', format: 'JPEG', source: 'original' }
  ]
};

var calls = [];
var originalRunQuery = plugin.runQuery.bind(plugin);
plugin.runQuery = function(cmd, defer, context, onSuccess, popHistory) {
  calls.push({ cmd: cmd, context: context });
  try {
    if (context.indexOf('artist') !== -1) {
      onSuccess(JSON.stringify(['Waco Brothers', ['King Gizzard', 'The Lizard Wizard'], 'Pinback']));
    } else {
      onSuccess(JSON.stringify(meta));
    }
  } catch (e) {
    defer.reject(e);
  }
};

plugin.sizeCache = { aadamjacobs: 100 };

Promise.resolve().then(function() {
  if (typeof plugin.flattenCreators !== 'function') return;
  return asP(plugin.listArtists('aadamjacobs', 'internetarchive/c/aadamjacobs')).then(function(resp) {
    var titles = resp.navigation.lists[0].items.map(function(it) { return it.title; });
    check(titles.indexOf('King Gizzard') !== -1 && titles.indexOf('The Lizard Wizard') !== -1,
      'listArtists flattens array creators (got ' + JSON.stringify(titles) + ')');
    check(resp.navigation.lists[0].items.every(function(it) { return typeof it.title === 'string'; }),
      'every artist title is a string (no throw on .replace)');
    var afterFirst = calls.length;
    return asP(plugin.listArtists('aadamjacobs', 'internetarchive/c/aadamjacobs')).then(function() {
      check(calls.length === afterFirst, 'second listArtists is a cache hit (calls ' + calls.length + ' vs ' + afterFirst + ')');
    });
  });
}).then(function() {
  if (typeof plugin.fetchItemMetadata !== 'function') return;
  calls = [];
  return asP(plugin.getSourceTracks('aadamjacobs', 'testid', false)).then(function(items) {
    check(items[0] && items[0].trackType === 'mp3', 'getSourceTracks still prefers MP3');
    check(items[0] && items[0].artist === 'Test Band',
      'array metadata.creator becomes a string artist (got ' + (items[0] && items[0].artist) + ')');
    check(calls.length === 1 && /--max-time 60/.test(calls[0].cmd),
      'metadata curl is 60s (cmd=' + (calls[0] && calls[0].cmd) + ')');
    return asP(plugin.getTrack('testid', 't01.mp3')).then(function(track) {
      check(calls.length === 1, 'getTrack reuses metadata cache (calls=' + calls.length + ')');
      check(track[0] && /archive\.org\/download\//.test(track[0].uri),
        'cached getTrack still uses /download/');
    });
  });
}).then(function() {
  if (typeof plugin.fetchItemMetadata !== 'function') return;
  plugin.metaCache.testid.at = Date.now() - (60 * 60 * 1000);
  var before = calls.length;
  return asP(plugin.fetchItemMetadata('testid')).then(function() {
    check(calls.length === before + 1, 'expired metadata cache refetches');
  });
}).then(function() {
  var origValidate = plugin.validateCollections;
  plugin.validateCollections = function() {};
  plugin.saveConfig({ collections: 'aadamjacobs' });
  check(Object.keys(plugin.artistCache || {}).length === 0, 'saveConfig clears artistCache');
  check(Object.keys(plugin.sizeCache || {}).length === 0, 'saveConfig clears sizeCache');
  check(Object.keys(plugin.metaCache || {}).length === 0, 'saveConfig clears metaCache');
  plugin.validateCollections = origValidate;
}).then(function() {
  plugin.runQuery = originalRunQuery;
  if (fails) {
    console.log('\n' + fails + ' failure(s)');
    process.exit(1);
  }
  console.log('\nall cache-and-timeout checks passed');
}).catch(function(err) {
  console.error(err);
  process.exit(2);
});
