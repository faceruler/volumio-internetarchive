'use strict';

// Regression: play contract vs the working LMA plugin.
// 1. MPD URLs must be archive.org/download (not a pinned datanode).
// 2. Intermediate browse rows must be item-no-menu so Play is not offered.
// 3. Exploding a recording with no chosen format must prefer MP3.

var assert = require('assert');
var EventEmitter = require('events');
var libQ = require('kew');
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
var playbackCommands;
function check(cond, msg) {
  try {
    assert(cond, msg);
    console.log('PASS: ' + msg);
  } catch (e) {
    fails++;
    console.log('FAIL: ' + msg);
  }
}

// --- 1. download URL is LMA-style /download/, encoded, never a datanode ---
var url = plugin.iaDownloadUrl(
  'Pearl_Jam_Bootleg_1992-03-05',
  '1-01 -intro-.mp3',
  'ia800503.us.archive.org',
  '/17/items/Pearl_Jam_Bootleg_1992-03-05'
);
check(/^https:\/\/archive\.org\/download\//.test(url), 'iaDownloadUrl uses archive.org/download');
check(url.indexOf('ia800503') === -1, 'iaDownloadUrl ignores metadata.server datanode');
check(url.indexOf('1-01%20-intro-.mp3') !== -1, 'iaDownloadUrl encodes spaces in filename');
check(url.indexOf('Pearl_Jam_Bootleg_1992-03-05') !== -1, 'iaDownloadUrl keeps identifier');

var urlNoNode = plugin.iaDownloadUrl('id', 'folder/track 01.flac');
check(urlNoNode === 'https://archive.org/download/id/folder/track%2001.flac',
  'iaDownloadUrl encodes each path segment: ' + urlNoNode);

// --- 2. intermediate browse items are item-no-menu ---
function typesOf(items) {
  return items.map(function(it) { return it.type; });
}

plugin.listCollections().then(function(resp) {
  var types = typesOf(resp.navigation.lists[0].items);
  check(types.length > 0 && types.every(function(t) { return t === 'item-no-menu'; }),
    'collections are item-no-menu (got ' + JSON.stringify(types) + ')');
});

var letters = plugin.buildLetterIndex('etree');
check(typesOf(letters.navigation.lists[0].items).every(function(t) { return t === 'item-no-menu'; }),
  'letter index is item-no-menu');

var artist = plugin.artistFolder('aadamjacobs', 'Grateful Dead');
check(artist.type === 'item-no-menu', 'artistFolder is item-no-menu (got ' + artist.type + ')');

// Year / show items are built inline; assert via a tiny extracted shape by
// calling the same type we expect after the list builders run. We inspect the
// source of the push objects by simulating one year/show item the way listYears
// / listShows do — those functions need network, so check the constants they
// would emit by grepping the built helper if present. Fall back: after the
// code change, listYears/listShows must use item-no-menu. We verify via a
// stubbed runQuery below.

function stubQuery(docsOrJson) {
  plugin.runQuery = function(cmd, defer, context, onSuccess) {
    var payload = typeof docsOrJson === 'string' ? docsOrJson : JSON.stringify(docsOrJson);
    try { onSuccess(payload); } catch (e) { defer.reject(e); }
  };
}

stubQuery([{ creator: 'Grateful Dead', year: '1977', date: '1977-05-08T00:00:00Z' }]);
plugin.listYears('etree', 'internetarchive/c/etree/artist/Grateful%20Dead').then(function(resp) {
  var items = resp.navigation.lists[0].items;
  check(items.length > 0 && items.every(function(it) { return it.type === 'item-no-menu'; }),
    'year items are item-no-menu (got ' + JSON.stringify(typesOf(items)) + ')');
});

stubQuery([{
  creator: 'Grateful Dead',
  date: '1977-05-08T00:00:00Z',
  venue: 'Barton Hall',
  coverage: 'Ithaca, NY',
  identifier: 'gd1977-05-08'
}]);
plugin.listShows('etree', 'internetarchive/c/etree/year/Grateful%20Dead/1977').then(function(resp) {
  var items = resp.navigation.lists[0].items;
  check(items.length > 0 && items.every(function(it) { return it.type === 'item-no-menu'; }),
    'show items are item-no-menu (got ' + JSON.stringify(typesOf(items)) + ')');
});

// Sources stay playable folders (explode source).
stubQuery([{
  creator: 'Grateful Dead',
  identifier: 'gd1977-05-08.sbd',
  source: 'SBD',
  date: '1977-05-08T00:00:00Z',
  venue: 'Barton Hall',
  coverage: 'Ithaca, NY'
}, {
  creator: 'Grateful Dead',
  identifier: 'gd1977-05-08.aud',
  source: 'AUD',
  date: '1977-05-08T00:00:00Z',
  venue: 'Barton Hall',
  coverage: 'Ithaca, NY'
}]);
plugin.listSources('etree', 'internetarchive/c/etree/show/Grateful%20Dead/19770508').then(function(resp) {
  var items = resp.navigation.lists[0].items;
  check(items.length === 2 && items.every(function(it) { return it.type === 'folder'; }),
    'source items stay folder so they can be exploded');
});

// --- 3. default explode format prefers MP3 ---
var meta = {
  metadata: {
    creator: 'Test Band',
    date: '1995-02-03T00:00:00Z',
    venue: 'Some Venue',
    coverage: 'Town'
  },
  server: 'ia800503.us.archive.org',
  dir: '/17/items/testid',
  files: [
    { name: 't01.flac', format: 'Flac', source: 'original', track: '1', title: 'FLAC 1', length: '10' },
    { name: 't01.ogg', format: 'Ogg Vorbis', source: 'derivative', track: '1', title: 'OGG 1', length: '10' },
    { name: 't01.mp3', format: 'VBR MP3', source: 'derivative', track: '1', title: 'MP3 1', length: '10' },
    { name: 'cover.jpg', format: 'JPEG', source: 'original' }
  ]
};

stubQuery(JSON.stringify(meta));
plugin.getSourceTracks('aadamjacobs', 'testid', false).then(function(items) {
  check(Array.isArray(items) && items.length === 1, 'default explode returns one track per song');
  check(items[0] && items[0].trackType === 'mp3',
    'default explode prefers MP3 (got ' + (items[0] && items[0].trackType) + ')');
  check(items[0] && /t01\.mp3$/.test(items[0].uri),
    'default explode URI is the mp3 file (got ' + (items[0] && items[0].uri) + ')');
  check(items[0] && items[0].uri.indexOf('archive.org/download/') !== -1,
    'exploded play URI is /download/ not a datanode');
  check(items[0] && items[0].uri.indexOf('ia800503') === -1,
    'exploded play URI is not pinned to metadata.server');
}).then(function() {
  // Explicit FLAC choice still works.
  stubQuery(JSON.stringify(meta));
  return plugin.getSourceTracks('aadamjacobs', 'testid', false, 'flac');
}).then(function(items) {
  check(items[0] && items[0].trackType === 'flac',
    'explicit flac format still returns FLAC');
}).then(function() {
  // Playback expands complete recordings and adds every direct URL to MPD.
  playbackCommands = [];
  var clientMpd = new EventEmitter();
  var unrelatedListener = function() {};
  clientMpd.on('system-player', unrelatedListener);
  plugin.commandRouter.stateMachine.getTrack = function() {
    return { service: 'volumio-internetarchive' };
  };
  plugin.mpdPlugin = {
    clientMpd: clientMpd,
    sendMpdCommand: function(command) {
      playbackCommands.push(command);
      return libQ.resolve();
    },
    getState: function() { return libQ.resolve({}); }
  };
  plugin.explodeUri = function() {
    return libQ.resolve([
      { uri: 'https://archive.org/download/testid/01.mp3' },
      { uri: 'https://archive.org/download/testid/02.flac' }
    ]);
  };

  return plugin.clearAddPlayTrack({ uri: 'internetarchive/c/etree/source/testid' }).then(function() {
    check(playbackCommands.join('|') === [
      'stop',
      'clear',
      'add "https://archive.org/download/testid/01.mp3"',
      'add "https://archive.org/download/testid/02.flac"',
      'play'
    ].join('|'), 'play queues every expanded track using direct download URLs');
    check(clientMpd.listeners('system-player').indexOf(unrelatedListener) !== -1,
      'playback preserves MPD listeners owned by other consumers');

    playbackCommands.length = 0;
    return plugin.prefetch({ uri: 'internetarchive/c/etree/track/testid/01.mp3' });
  });
}).then(function() {
  check(playbackCommands.join('|') === [
    'add "https://archive.org/download/testid/01.mp3"',
    'consume 1'
  ].join('|'), 'prefetch expands a browse URI before adding it to MPD');
}).then(function() {
  if (fails) {
    console.log('\n' + fails + ' failure(s)');
    process.exit(1);
  }
  console.log('\nall play-contract checks passed');
}).fail(function(err) {
  console.error(err);
  process.exit(2);
});
