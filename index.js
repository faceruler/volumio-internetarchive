'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var config = new (require('v-conf'))();
var spawn = require('child_process').spawn;

var iaApiBaseUrl = 'https://archive.org/advancedsearch.php?';
var iaScrapeBaseUrl = 'https://archive.org/services/search/v1/scrape?';
var iaMetadataBaseUrl = 'https://archive.org/metadata/';
var iaDownloadBaseUrl = 'https://archive.org/download/';

// Base browse URI / service identifier for this plugin.
var BASE_URI = 'internetarchive';
var SERVICE_NAME = 'volumio-internetarchive';

// Collections whose total item count exceeds this get an A–Z letter index
// before the artist list, instead of trying to load every creator at once
// (etree has 60k+ creators; a single scrape page would silently truncate).
var DEFAULT_INDEX_THRESHOLD = 4000;

// Default set of collections seeded into config on first run.
var DEFAULT_COLLECTIONS = 'aadamjacobs, pearljambootlegs, NYCTaper, taperssection, etree';

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Playable audio formats, in the order the format menu lists them. Each maps a
// format key to the regex that matches archive.org's `format` field, the
// `trackType` MPD expects, a display label, and (for FLAC) a source filter.
var FORMATS = {
  flac: { regex: /flac/i, trackType: "flac", label: "FLAC", sourceFilter: "original" },
  mp3:  { regex: /mp3/i,  trackType: "mp3",  label: "MP3",  sourceFilter: null },
  ogg:  { regex: /ogg/i,  trackType: "ogg",  label: "Ogg Vorbis", sourceFilter: null }
};
var FORMAT_ORDER = ["flac", "mp3", "ogg"];

// Letters used for the A–Z index; '#' collects names starting with a non-letter.
var INDEX_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").concat(["#"]);

// Bounded curl. archive.org occasionally stalls; without these, a hung request
// never resolves and the browse view just spins forever. --max-time caps the
// whole transfer, --connect-timeout the initial connect. 20s was too tight on
// a Pi (metadata + scrape) and surfaced as the QUERY_ERROR toast.
var DEFAULT_CURL_MAX_TIME = 60;

function iaCurl(url, maxTime) {
  var t = maxTime || DEFAULT_CURL_MAX_TIME;
  return "/usr/bin/curl -sS --connect-timeout 15 --max-time " + t + " -X GET '" + url + "'";
}

// In-memory TTLs. Artist lists are expensive; item metadata is reused by
// format menu + explode + each track. Neither is required before play.
var ARTIST_TTL_MS = 6 * 60 * 60 * 1000;
var META_TTL_MS = 30 * 60 * 1000;

module.exports = ControllerInternetArchive;

function ControllerInternetArchive(context) {
  var self = this;

  this.context = context;
  this.commandRouter = this.context.coreCommand;
  this.logger = this.context.logger;
  this.configManager = this.context.configManager;

  // Cache collection sizes so we don't re-probe numFound on every browse.
  self.sizeCache = {};
  self.artistCache = {};
  self.metaCache = {};
  self.metaInflight = {};

  self.resetHistory();
}

// History Helpers ------------------------------------------------------------
// Volumio drives "Back" by re-issuing the previous URI. We keep a small stack so
// each list can advertise the correct "prev" URI regardless of how deep we are.

ControllerInternetArchive.prototype.resetHistory = function() {
  var self = this;
  self.uriHistory = [];
  self.historyIndex = -1;
}

ControllerInternetArchive.prototype.historyAdd = function(uri) {
  var self = this;

  // Back action detection: if the incoming uri matches the one before the top,
  // the user pressed Back, so pop rather than push.
  if (self.uriHistory[self.historyIndex - 1] == uri) {
    self.historyPop();
  } else {
    self.uriHistory.push(uri);
    self.historyIndex++;
  }
}

ControllerInternetArchive.prototype.historyPop = function() {
  var self = this;
  self.uriHistory.pop();
  self.historyIndex--;
}

ControllerInternetArchive.prototype.getPrevUri = function() {
  var self = this;
  var uri;

  if (self.historyIndex >= 0) {
    uri = self.uriHistory[self.historyIndex - 1];
  } else {
    uri = BASE_URI;
  }

  return uri;
}

// Lifecycle Methods ----------------------------------------------------------

ControllerInternetArchive.prototype.onVolumioStart = function() {
  var self = this;
  var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new (require('v-conf'))();
  this.config.loadFile(configFile);

  return libQ.resolve();
}

ControllerInternetArchive.prototype.onStart = function() {
  var self = this;
  self.addToBrowseSources();

  self.mpdPlugin = this.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
  self.serviceName = SERVICE_NAME;
  self.loadI18nStrings();

  return libQ.resolve();
};

ControllerInternetArchive.prototype.onStop = function() {
  return libQ.resolve();
};

ControllerInternetArchive.prototype.onRestart = function() {
  return libQ.resolve();
};

// Configuration Methods ------------------------------------------------------

ControllerInternetArchive.prototype.getUIConfig = function() {
  var defer = libQ.defer();
  var self = this;

  var lang_code = this.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
      __dirname + '/i18n/strings_en.json',
      __dirname + '/UIConfig.json')
      .then(function(uiconf) {
        // Inject current config values
        uiconf.sections[0].content[0].value = self.config.get('collections', DEFAULT_COLLECTIONS);
        uiconf.sections[0].content[1].value = self.config.get('resultsLimit', 100);
        uiconf.sections[0].content[2].value = self.config.get('artistIndexThreshold', DEFAULT_INDEX_THRESHOLD);
        defer.resolve(uiconf);
      })
      .fail(function() {
        defer.reject(new Error());
      });

  return defer.promise;
};

ControllerInternetArchive.prototype.getConfigurationFiles = function() {
  return ['config.json'];
}

ControllerInternetArchive.prototype.saveConfig = function(data) {
  var self = this;

  if (data.collections !== undefined) {
    self.config.set('collections', data.collections);
    self.sizeCache = {};
    self.artistCache = {};
    self.metaCache = {};
    self.metaInflight = {};
  }
  if (data.resultsLimit) {
    self.config.set('resultsLimit', data.resultsLimit);
  }
  if (data.artistIndexThreshold) {
    self.config.set('artistIndexThreshold', data.artistIndexThreshold);
  }

  self.commandRouter.pushToastMessage('success', 'Configuration', 'Settings saved successfully');

  // Best-effort: warn about configured collections that return zero items
  // (usually a case/typo issue — collection ids are case-sensitive).
  self.validateCollections();
};

// Probe each configured collection's item count and toast any that are empty.
ControllerInternetArchive.prototype.validateCollections = function() {
  var self = this;
  var collections = self.getCollections();

  collections.forEach(function(col) {
    self.getCollectionSize(col).then(function(size) {
      if (size === 0) {
        self.commandRouter.pushToastMessage('warning',
          self.getI18nString('PLUGIN_NAME'),
          '"' + col + '" ' + self.getI18nString('COLLECTION_EMPTY'));
      }
    });
  });
};

// Parse the collections config string into a cleaned, de-duplicated array.
// Accepts comma- and/or newline-separated identifiers.
ControllerInternetArchive.prototype.getCollections = function() {
  var self = this;
  var raw = self.config.get('collections', DEFAULT_COLLECTIONS) || '';
  var seen = {};
  var out = [];

  raw.split(/[\n,]+/).forEach(function(entry) {
    var id = entry.trim();
    if (id && !seen[id]) {
      seen[id] = true;
      out.push(id);
    }
  });

  return out;
};

// Browse Source Registration -------------------------------------------------

ControllerInternetArchive.prototype.addToBrowseSources = function() {
  var self = this;
  self.commandRouter.volumioAddToBrowseSources({
    name: 'Internet Archive',
    uri: BASE_URI,
    plugin_type: 'music_service',
    plugin_name: SERVICE_NAME,
    albumart: '/albumart?sourceicon=music_service/' + SERVICE_NAME + '/icon.png'
  });
};

// Browse Handler -------------------------------------------------------------
// URI scheme (the {collection} id threads through every level):
//   internetarchive                                        -> configured collections
//   internetarchive/c/{col}                                -> artists (or A–Z index if large)
//   internetarchive/c/{col}/letter/{L}                     -> artists starting with L
//   internetarchive/c/{col}/artist/{creator}               -> years for that artist
//   internetarchive/c/{col}/year/{creator}/{year}          -> shows (date + venue)
//   internetarchive/c/{col}/show/{creator}/{yyyymmdd}      -> recordings/sources for a date
//   internetarchive/c/{col}/source/{identifier}            -> format menu (or tracks if one format)
//   internetarchive/c/{col}/fmt/{identifier}/{format}      -> tracks of one recording in a format
//   internetarchive/c/{col}/track/{identifier}/{file}      -> single track (explode target)
// Creator/collection segments are percent-encoded with iaEncode.

ControllerInternetArchive.prototype.handleBrowseUri = function(curUri) {
  var self = this;
  var response;

  self.logger.info("INTERNETARCHIVE URI: " + curUri);

  if (curUri === BASE_URI) {
    // Root: list configured collections.
    self.resetHistory();
    self.historyAdd(curUri);
    response = self.listCollections();
  }
  else if (curUri.startsWith(BASE_URI + '/c/')) {
    // Everything past the collection id decides the level.
    var rest = curUri.substring((BASE_URI + '/c/').length); // {col}[/type/...]
    var slash = rest.indexOf('/');
    var col = decodeURIComponent(slash === -1 ? rest : rest.substring(0, slash));
    var tail = slash === -1 ? '' : rest.substring(slash + 1); // type/...

    self.historyAdd(curUri);

    if (tail === '') {
      response = self.listArtists(col, curUri);
    } else if (tail.startsWith('letter/')) {
      response = self.listArtistsByLetter(col, curUri);
    } else if (tail.startsWith('artist/')) {
      response = self.listYears(col, curUri);
    } else if (tail.startsWith('year/')) {
      response = self.listShows(col, curUri);
    } else if (tail.startsWith('show/')) {
      response = self.listSources(col, curUri);
    } else if (tail.startsWith('source/')) {
      response = self.listFormats(col, curUri);
    } else if (tail.startsWith('fmt/')) {
      response = self.listSourceTracks(col, curUri);
    }
  }

  return response;
};

// Build the "/c/{col}" prefix for a collection's child URIs.
ControllerInternetArchive.prototype.colUri = function(col) {
  return BASE_URI + '/c/' + this.iaEncode(col);
};

// Root: list configured collections ------------------------------------------
ControllerInternetArchive.prototype.listCollections = function() {
  var self = this;
  var collections = self.getCollections();

  var response = {
    "navigation": {
      "lists": [
        {
          "availableListViews": ["list", "grid"],
          "items": []
        }
      ],
      "prev": {
        "uri": self.getPrevUri()
      }
    }
  };

  if (collections.length === 0) {
    self.commandRouter.pushToastMessage('info',
      self.getI18nString('PLUGIN_NAME'),
      self.getI18nString('NO_COLLECTIONS'));
    response.navigation.lists[0].items.push({
      "type": "title",
      "title": self.getI18nString('NO_COLLECTIONS'),
      "availableListViews": ["list"],
      "items": []
    });
    return libQ.resolve(response);
  }

  for (var i = 0; i < collections.length; i++) {
    var col = collections[i];
    response.navigation.lists[0].items.push({
      "service": self.serviceName,
      "type": "item-no-menu",
      "title": col,
      "icon": "fa fa-archive",
      "uri": self.colUri(col),
      "sortKey": col.toLowerCase()
    });
  }

  return libQ.resolve(response);
}

// Get a collection's total item count (numFound), cached. Returns a promise.
ControllerInternetArchive.prototype.getCollectionSize = function(col) {
  var self = this;
  var defer = libQ.defer();

  if (self.sizeCache[col] !== undefined) {
    return libQ.resolve(self.sizeCache[col]);
  }

  var uri = iaApiBaseUrl +
    'q=collection%3A' + self.iaEncode(col) +
    '&rows=0&page=1&output=json';
  var reqCommand = iaCurl(uri) + " | /usr/bin/jq -c '.response.numFound';";

  self.runQuery(reqCommand, defer, 'collection size', function(resultStr) {
    var n = parseInt(JSON.parse(resultStr), 10);
    if (isNaN(n)) n = 0;
    self.sizeCache[col] = n;
    defer.resolve(n);
  }, false);

  return defer.promise;
}

// Level 1: list artists for a collection (or an A–Z index for large ones) ----
ControllerInternetArchive.prototype.listArtists = function(col, curUri) {
  var self = this;
  var defer = libQ.defer();
  var threshold = self.config.get('artistIndexThreshold', DEFAULT_INDEX_THRESHOLD);

  var cacheKey = 'artists:' + col;
  var cached = self.cachedArtistResponse(cacheKey, ARTIST_TTL_MS);
  if (cached) {
    defer.resolve(cached);
    return defer.promise;
  }

  self.commandRouter.pushToastMessage('info',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('LOADING_ARTISTS'));

  self.getCollectionSize(col).then(function(size) {
    if (size > threshold) {
      // Too many creators to list at once — show an A–Z letter index instead.
      defer.resolve(self.buildLetterIndex(col));
      return;
    }

    // Small enough: scrape every creator and dedupe (as the aadamjacobs v2 plugin does).
    var uri = iaScrapeBaseUrl +
      'q=collection%3A' + self.iaEncode(col) +
      '&fields=creator' +
      '&sorts=creator+asc' +
      '&count=10000';
    var reqCommand = iaCurl(uri) +
      " | /usr/bin/jq -c '[.items[].creator] | map(select(. != null and . != \"\")) | unique';";

    self.runQuery(reqCommand, defer, 'artist list', function(resultStr) {
      var creators = JSON.parse(resultStr) || [];
      var response = self.artistListFromCreators(col, creators);
      if (response.navigation.lists[0].items.length === 0) {
        self.commandRouter.pushToastMessage('info',
          self.getI18nString('PLUGIN_NAME'),
          self.getI18nString('NO_ARTISTS'));
      }
      self.storeArtistResponse(cacheKey, response);
      defer.resolve(response);
    });
  }).fail(function(err) {
    defer.reject(err);
  });

  return defer.promise;
}

// Build the static A–Z + # letter menu for a large collection.
ControllerInternetArchive.prototype.buildLetterIndex = function(col) {
  var self = this;
  var response = {
    "navigation": {
      "lists": [
        {
          "type": "title",
          "title": self.getI18nString('PICK_LETTER'),
          "availableListViews": ["list", "grid"],
          "items": []
        }
      ],
      "prev": {
        "uri": self.getPrevUri()
      }
    }
  };

  for (var i = 0; i < INDEX_LETTERS.length; i++) {
    var L = INDEX_LETTERS[i];
    response.navigation.lists[0].items.push({
      "service": self.serviceName,
      "type": "item-no-menu",
      "title": L,
      "icon": "fa fa-font",
      "uri": self.colUri(col) + '/letter/' + encodeURIComponent(L)
    });
  }

  return response;
}

// Level 1b: list artists in a letter bucket for a large collection -----------
ControllerInternetArchive.prototype.listArtistsByLetter = function(col, curUri) {
  var self = this;
  var defer = libQ.defer();
  var letter = decodeURIComponent(curUri.split('/').pop());
  var cacheKey = 'letter:' + col + ':' + letter;
  var cached = self.cachedArtistResponse(cacheKey, ARTIST_TTL_MS);
  if (cached) {
    return libQ.resolve(cached);
  }

  self.commandRouter.pushToastMessage('info',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('LOADING_ARTISTS'));

  // Bound the query to a creator range for the letter (or non-letters for '#'),
  // then filter client-side by first character — the creator field is tokenized,
  // so a range/prefix query leaks names whose *secondary* words match.
  var q, matchFn;
  if (letter === '#') {
    // Everything sorting before 'a' (digits, punctuation, symbols).
    q = 'collection:' + col + ' AND creator:[* TO a]';
    matchFn = function(name) { return !/^[a-z]/i.test(name.trim()); };
  } else {
    var lo = letter.toLowerCase();
    q = 'collection:' + col + ' AND creator:[' + lo + ' TO ' + lo + 'zzzzzz]';
    matchFn = function(name) { return name.trim().toLowerCase().charAt(0) === lo; };
  }

  var uri = iaApiBaseUrl +
    'q=' + encodeURIComponent(q) +
    '&fl=creator&rows=10000&page=1&output=json';
  var reqCommand = iaCurl(uri) +
    " | /usr/bin/jq -c '[.response.docs[].creator] | map(select(. != null and . != \"\")) | unique';";

  self.runQuery(reqCommand, defer, 'artist letter list', function(resultStr) {
    var creators = self.flattenCreators(JSON.parse(resultStr) || []).filter(matchFn);
    var list = self.artistListFromCreators(col, creators);
    if (list.navigation.lists[0].items.length === 0) {
      self.commandRouter.pushToastMessage('info',
        self.getI18nString('PLUGIN_NAME'),
        self.getI18nString('NO_ARTISTS'));
    }
    self.storeArtistResponse(cacheKey, list);
    defer.resolve(list);
  });

  return defer.promise;
}

// archive.org sometimes returns creator as an array (multi-artist items).
// Passing that into artistFolder().replace or d.creator === name throws / filters
// everything out, which surfaces as QUERY_ERROR or an empty year/show list.
ControllerInternetArchive.prototype.flattenCreators = function(values) {
  var seen = {};
  var out = [];

  function displayScore(s) {
    var lower = s.toLowerCase();
    var upper = s.toUpperCase();
    if (s !== lower && s !== upper) return 2;
    if (s === upper && s !== lower) return 1;
    return 0;
  }

  function add(name) {
    if (name === null || name === undefined) return;
    if (Array.isArray(name)) {
      name.forEach(add);
      return;
    }
    var s = String(name).trim();
    if (!s) return;
    var key = s.toLowerCase();
    if (seen[key] !== undefined) {
      var idx = seen[key];
      if (displayScore(s) > displayScore(out[idx])) out[idx] = s;
      return;
    }
    seen[key] = out.length;
    out.push(s);
  }

  if (Array.isArray(values)) values.forEach(add);
  else add(values);
  return out;
};

ControllerInternetArchive.prototype.creatorMatches = function(field, wanted) {
  if (field === null || field === undefined || wanted === null || wanted === undefined) return false;
  var want = String(wanted).toLowerCase();
  if (Array.isArray(field)) {
    return field.some(function(entry) {
      return entry !== null && entry !== undefined && String(entry).toLowerCase() === want;
    });
  }
  return String(field).toLowerCase() === want;
};

ControllerInternetArchive.prototype.primaryCreator = function(field) {
  var names = this.flattenCreators(field);
  return names.length ? names[0] : '';
};

ControllerInternetArchive.prototype.artistListFromCreators = function(col, creators) {
  var self = this;
  var response = self.emptyArtistResponse();
  var names = self.flattenCreators(creators);
  for (var i = 0; i < names.length; i++) {
    response.navigation.lists[0].items.push(self.artistFolder(col, names[i]));
  }
  response.navigation.lists[0].items.sort(self.compareSortKey);
  return response;
};

ControllerInternetArchive.prototype.cachedArtistResponse = function(key, ttl) {
  var self = this;
  var hit = self.artistCache[key];
  if (hit && (Date.now() - hit.at) < ttl) return hit.response;
  return null;
};

ControllerInternetArchive.prototype.storeArtistResponse = function(key, response) {
  this.artistCache[key] = { at: Date.now(), response: response };
};

// Shared empty navigation object for artist lists.
ControllerInternetArchive.prototype.emptyArtistResponse = function() {
  var self = this;
  return {
    "navigation": {
      "lists": [
        {
          "availableListViews": ["list", "grid"],
          "items": []
        }
      ],
      "prev": {
        "uri": self.getPrevUri()
      }
    }
  };
}

// Build an artist folder item.
ControllerInternetArchive.prototype.artistFolder = function(col, creator) {
  var self = this;
  return {
    "service": self.serviceName,
    "type": "item-no-menu",
    "title": creator,
    "icon": "fa fa-user",
    "uri": self.colUri(col) + '/artist/' + self.iaEncode(creator),
    "sortKey": creator.replace(/^(?:A|The) /i, '')
  };
}

// Level 2: List the years a given artist has shows ---------------------------
ControllerInternetArchive.prototype.listYears = function(col, curUri) {
  var self = this;
  var defer = libQ.defer();
  var creator = decodeURIComponent(curUri.split('/')[4]);

  self.commandRouter.pushToastMessage('info',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('LOADING_YEARS'));

  var uri = iaApiBaseUrl +
    'q=collection%3A' + self.iaEncode(col) + '+AND+creator%3A' + self.iaEncode('"' + creator + '"') +
    '&fl=creator,date,year' +
    '&rows=10000' +
    '&page=1' +
    '&output=json';

  var reqCommand = iaCurl(uri) + " | /usr/bin/jq -c '.response.docs';";

  var response = {
    "navigation": {
      "lists": [],
      "prev": {
        "uri": self.getPrevUri()
      }
    }
  };

  self.runQuery(reqCommand, defer, 'year list', function(resultStr) {
    var docs = JSON.parse(resultStr) || [];
    // creator: search is fuzzy/tokenized, so keep only exact creator matches.
    docs = docs.filter(function(d) { return self.creatorMatches(d.creator, creator); });

    var years = {};
    for (var i = 0; i < docs.length; i++) {
      var y = self.docYear(docs[i]);
      if (y) years[y] = true;
    }
    var yearList = Object.keys(years);

    if (yearList.length === 0) {
      self.pushNoExist(response, defer);
      return;
    }

    response.navigation.lists.push({
      "type": "title",
      "title": "Years with " + creator + " shows",
      "availableListViews": ["list", "grid"],
      "items": []
    });

    for (var j = 0; j < yearList.length; j++) {
      var year = yearList[j];
      response.navigation.lists[0].items.push({
        "service": self.serviceName,
        "type": "item-no-menu",
        "title": year,
        "icon": "fa fa-calendar",
        "uri": self.colUri(col) + '/year/' + self.iaEncode(creator) + '/' + year,
        "sortKey": year
      });
    }

    response.navigation.lists[0].items.sort(self.compareSortKeyDesc);
    defer.resolve(response);
  });

  return defer.promise;
}

// Level 3: List the shows (unique dates) for an artist in a given year -------
ControllerInternetArchive.prototype.listShows = function(col, curUri) {
  var self = this;
  var defer = libQ.defer();
  var parts = curUri.split('/');
  var creator = decodeURIComponent(parts[4]);
  var year = parts[5];
  var resultsLimit = self.config.get('resultsLimit', 100);

  self.commandRouter.pushToastMessage('info',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('LOADING_SHOWS'));

  var uri = iaApiBaseUrl +
    'q=collection%3A' + self.iaEncode(col) +
    '+AND+creator%3A' + self.iaEncode('"' + creator + '"') +
    '+AND+year%3A' + encodeURIComponent(year) +
    '&fl=identifier,creator,date,venue,coverage,title,source' +
    '&rows=' + resultsLimit +
    '&page=1' +
    '&output=json';

  var reqCommand = iaCurl(uri) + " | /usr/bin/jq -c '.response.docs';";

  var response = {
    "navigation": {
      "lists": [],
      "prev": {
        "uri": self.getPrevUri()
      }
    }
  };

  self.runQuery(reqCommand, defer, 'show list', function(resultStr) {
    var docs = JSON.parse(resultStr) || [];
    docs = docs.filter(function(d) { return self.creatorMatches(d.creator, creator); });

    // Collapse to one entry per calendar date (a date can have several sources).
    var seen = {};
    var shows = [];
    for (var i = 0; i < docs.length; i++) {
      var isoDate = self.isoDate(docs[i].date);
      if (!isoDate) continue;
      var src = self.sourceOf(docs[i]);
      if (seen[isoDate]) {
        var existing = seen[isoDate];
        if (src && existing.sources.indexOf(src) === -1) existing.sources.push(src);
        if (!existing.venue) existing.venue = self.venueOf(docs[i]);
        if (!existing.city) existing.city = docs[i].coverage || '';
        continue;
      }
      var show = {
        date: isoDate,
        venue: self.venueOf(docs[i]),
        city: docs[i].coverage || '',
        sources: src ? [src] : []
      };
      seen[isoDate] = show;
      shows.push(show);
    }

    if (shows.length === 0) {
      self.pushNoExist(response, defer);
      return;
    }

    response.navigation.lists.push({
      "type": "title",
      "title": creator + " shows in " + year,
      "availableListViews": ["list", "grid"],
      "items": []
    });

    for (var k = 0; k < shows.length; k++) {
      var row = shows[k];
      var compactDate = row.date.replace(/-/g, '');
      response.navigation.lists[0].items.push({
        "service": self.serviceName,
        "type": "item-no-menu",
        "title": self.showListTitle(row),
        "artist": creator,
        "album": row.venue || '',
        "icon": "fa fa-music",
        "uri": self.colUri(col) + '/show/' + self.iaEncode(creator) + '/' + compactDate,
        "sortKey": row.date
      });
    }

    response.navigation.lists[0].items.sort(self.compareSortKeyDesc);
    defer.resolve(response);
  });

  return defer.promise;
}

// Level 4: List the recordings/sources for a specific show date --------------
// If only one recording exists for the date, skip straight to its tracks.
ControllerInternetArchive.prototype.listSources = function(col, curUri) {
  var self = this;
  var defer = libQ.defer();
  var parts = curUri.split('/');
  var creator = decodeURIComponent(parts[4]);
  var compactDate = parts[5];
  var isoDate = [compactDate.slice(0, 4), compactDate.slice(4, 6), compactDate.slice(6, 8)].join('-');
  var dateQ = isoDate + 'T00:00:00Z';

  self.commandRouter.pushToastMessage('info',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('LOADING_SOURCES'));

  var uri = iaApiBaseUrl +
    'q=collection%3A' + self.iaEncode(col) +
    '+AND+creator%3A' + self.iaEncode('"' + creator + '"') +
    '+AND+date%3A' + encodeURIComponent(dateQ) +
    '&fl=identifier,creator,source,date,venue,coverage,title' +
    '&rows=10000' +
    '&page=1' +
    '&output=json';

  var reqCommand = iaCurl(uri) + " | /usr/bin/jq -c '.response.docs';";

  var response = {
    "navigation": {
      "lists": [],
      "prev": {
        "uri": self.getPrevUri()
      }
    }
  };

  self.runQuery(reqCommand, defer, 'source list', function(resultStr) {
    var docs = JSON.parse(resultStr) || [];
    docs = docs.filter(function(d) { return self.creatorMatches(d.creator, creator); });

    if (docs.length === 0) {
      self.pushNoExist(response, defer);
      return;
    }

    var venue = self.venueOf(docs[0]);
    var city = docs[0].coverage || '';
    var showDate = self.formatDate(isoDate) +
      (venue ? '  •  ' + venue : '') +
      (city ? ', ' + city : '');
    response.navigation.lists.push({
      "type": "title",
      "title": docs.length + " recordings of " + creator + " on " + self.formatDate(isoDate),
      "availableListViews": ["list"],
      "items": []
    });

    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i];
      response.navigation.lists[0].items.push({
        "service": self.serviceName,
        "type": "folder",
        "title": self.sourceOf(doc) || "No source information",
        "artist": creator,
        "album": showDate,
        "icon": "fa fa-microphone",
        "uri": self.colUri(col) + '/source/' + doc.identifier
      });
    }

    defer.resolve(response);
  });

  return defer.promise;
}

// Level 5: Format menu for a recording ---------------------------------------
// A recording often has FLAC + MP3 (+ Ogg). FLAC is lossless but the files are
// large and stream slowly/unreliably from archive.org's datanodes; MP3 is
// smaller and more reliable. Let the user choose. If only one format exists,
// skip straight to its tracks.
ControllerInternetArchive.prototype.listFormats = function(col, curUri) {
  var self = this;
  var defer = libQ.defer();
  // internetarchive/c/{col}/source/{identifier}
  var identifier = curUri.split('/')[4];

  self.commandRouter.pushToastMessage('info',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('LOADING_SOURCES'));

  self.fetchItemMetadata(identifier).then(function(resultJSON) {
    var available = self.detectFormats(resultJSON.files || []);

    if (available.length === 0) {
      var empty = {
        "navigation": {
          "lists": [{
            "type": "title",
            "title": self.getI18nString('NO_EXIST'),
            "availableListViews": ["list"],
            "items": []
          }],
          "prev": { "uri": self.getPrevUri() }
        }
      };
      self.commandRouter.pushToastMessage('info',
        self.getI18nString('PLUGIN_NAME'), self.getI18nString('NO_EXIST'));
      defer.resolve(empty);
      return;
    }

    // Only one format -> skip the menu and go straight to its tracks.
    if (available.length === 1) {
      self.getSourceTracks(col, identifier, true, available[0].key)
        .then(function(list) {
          defer.resolve({
            "navigation": {
              "lists": [list],
              "prev": { "uri": self.getPrevUri() }
            }
          });
        })
        .fail(function(err) { defer.reject(err); });
      return;
    }

    var response = {
      "navigation": {
        "lists": [{
          "type": "title",
          "title": self.getI18nString('PICK_FORMAT'),
          "availableListViews": ["list"],
          "items": []
        }],
        "prev": { "uri": self.getPrevUri() }
      }
    };

    for (var i = 0; i < available.length; i++) {
      var f = available[i];
      var label = f.label +
        (f.quality ? ' (' + f.quality + ')' : '') +
        ' — ' + f.count + ' track' + (f.count === 1 ? '' : 's');
      response.navigation.lists[0].items.push({
        "service": self.serviceName,
        "type": "folder",
        "title": label,
        "icon": "fa fa-file-audio-o",
        "uri": self.colUri(col) + '/fmt/' + identifier + '/' + f.key
      });
    }

    defer.resolve(response);
  }).fail(function(err) {
    defer.reject(err);
  });

  return defer.promise;
}

// Detect which playable formats a recording offers, with track count and (for
// FLAC) a quality hint. Applies the same filters extractTracksFromFiles uses
// (skip fingerprints; FLAC restricted to "original" source) so counts match.
ControllerInternetArchive.prototype.detectFormats = function(files) {
  var self = this;
  var out = [];

  FORMAT_ORDER.forEach(function(key) {
    var spec = FORMATS[key];
    var count = 0;
    var is24 = false;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!file.format || !file.format.match(spec.regex)) continue;
      if (file.format.toLowerCase().indexOf("fingerprint") !== -1) continue;
      if (spec.sourceFilter && (!file.source || !file.source.match(new RegExp(spec.sourceFilter, 'i')))) continue;
      count++;
      if (/24[\s-]?bit/i.test(file.format)) is24 = true;
    }

    if (count > 0) {
      out.push({
        key: key,
        label: spec.label,
        count: count,
        quality: (key === 'flac' && is24) ? '24-bit' : ''
      });
    }
  });

  return out;
}

// Level 6: List tracks for a specific recording in a chosen format -----------
ControllerInternetArchive.prototype.listSourceTracks = function(col, curUri) {
  var self = this;
  var defer = libQ.defer();
  // internetarchive/c/{col}/fmt/{identifier}/{format}
  var parts = curUri.split('/');
  var identifier = parts[4];
  var format = parts[5];

  self.getSourceTracks(col, identifier, true, format)
    .then(function(results) {
      defer.resolve({
        "navigation": {
          "lists": [results],
          "prev": {
            "uri": self.getPrevUri()
          }
        }
      });
    })
    .fail(function(err) {
      defer.reject(err);
    });

  return defer.promise;
}

// Fetch a recording's metadata and build its track list ----------------------
// If `format` (flac|mp3|ogg) is given, only that format is used. Otherwise
// prefer MP3, then Ogg, then original FLAC — used by search / whole-recording
// explode, where FLAC from archive.org is large and often fails in MPD.
ControllerInternetArchive.prototype.getSourceTracks = function(col, identifier, sendList, format) {
  var self = this;
  var defer = libQ.defer();
  if (sendList === undefined) sendList = true;

  var response = {
    "type": "title",
    "title": "",
    "availableListViews": ["list"],
    "items": []
  };

  self.fetchItemMetadata(identifier).then(function(resultJSON) {
    var md = resultJSON.metadata || {};
    var files = resultJSON.files || [];
    var creator = self.primaryCreator(md.creator);
    var date = self.isoDate(md.date);
    var venue = self.venueOf(md);
    var city = md.coverage || '';
    var showDate = date ? self.formatDate(date) : '';

    response.title = creator +
      (venue ? ' - ' + venue : '') +
      (city ? ', ' + city : '') +
      (showDate ? ' (' + showDate + ')' : '');

    var albumLabel = showDate +
      (venue ? '  •  ' + venue : '') +
      (city ? ', ' + city : '');

    // Find album art (first non-thumbnail image).
    var artFile = "";
    for (var i = 0; i < files.length; i++) {
      var fileName = (files[i].name || '').toLowerCase();
      if ((fileName.indexOf(".jpg") >= 0 || fileName.indexOf(".png") >= 0) &&
          fileName.indexOf("thumb") === -1) {
        artFile = files[i].name;
        break;
      }
    }

    var tracks;
    if (format && FORMATS[format]) {
      // A specific format was chosen — use only it, no fallback.
      var spec = FORMATS[format];
      tracks = self.extractTracksFromFiles(col, files, spec.regex, spec.sourceFilter, identifier, creator, albumLabel, artFile, sendList);
    } else {
      // No format chosen (search / Play on a source): prefer MP3, then Ogg, then FLAC.
      tracks = self.extractTracksFromFiles(col, files, /mp3/i, null, identifier, creator, albumLabel, artFile, sendList);
      if (tracks.length === 0) {
        self.logger.info("No MP3 found, trying Ogg Vorbis");
        tracks = self.extractTracksFromFiles(col, files, /ogg/i, null, identifier, creator, albumLabel, artFile, sendList);
      }
      if (tracks.length === 0) {
        self.logger.info("No MP3 or Ogg Vorbis, trying FLAC");
        tracks = self.extractTracksFromFiles(col, files, /flac/i, 'original', identifier, creator, albumLabel, artFile, sendList);
      }
    }

    response.items = tracks.sort(self.compareSortKey);
    defer.resolve(sendList ? response : response.items);
  }).fail(function(err) {
    defer.reject(err);
  });

  return defer.promise;
}

// Helper to extract tracks from a metadata files array -----------------------
ControllerInternetArchive.prototype.extractTracksFromFiles = function(col, files, formatRegex, sourceFilter, identifier, creator, albumLabel, artFile, sendList) {
  var self = this;
  var tracks = [];

  for (var i = 0; i < files.length; i++) {
    var file = files[i];

    // Skip non-matching formats
    if (!file.format || !file.format.match(formatRegex)) continue;

    // Skip fingerprint files
    if (file.format.toLowerCase().indexOf("fingerprint") !== -1) continue;

    // Apply source filter if specified (for FLAC "original" sources)
    if (sourceFilter && (!file.source || !file.source.match(new RegExp(sourceFilter, 'i')))) continue;

    var trackName = file.title ||
                    (file.track ? "Track " + parseInt(file.track, 10) + " (" + file.name + ")" : file.name);

    var trackType = file.format.match(/flac/i) ? "flac" :
                    file.format.match(/ogg/i) ? "ogg" : "mp3";

    var track = {
      "service": self.serviceName,
      "type": "song",
      "trackType": trackType,
      "title": trackName,
      "name": trackName,
      "tracknumber": file.track ? parseInt(file.track, 10) : 0,
      "artist": creator,
      "album": albumLabel,
      "albumart": artFile ?
        self.iaDownloadUrl(identifier, artFile) :
        "/albumart?sourceicon=music_service/" + SERVICE_NAME + "/icon.png",
      "uri": sendList ?
        self.colUri(col) + "/track/" + identifier + "/" + encodeURIComponent(file.name) :
        self.iaDownloadUrl(identifier, file.name),
      "duration": file.length ? Math.round(parseFloat(file.length)) : 0,
      "sortKey": file.track ? parseInt(file.track, 10) : 999
    };

    tracks.push(track);
  }

  return tracks;
}

// Get a single track for explodeUri ------------------------------------------
ControllerInternetArchive.prototype.getTrack = function(identifier, trackName) {
  var self = this;
  var defer = libQ.defer();

  self.fetchItemMetadata(identifier).then(function(resultJSON) {
    var md = resultJSON.metadata || {};
    var files = resultJSON.files || [];
    var creator = self.primaryCreator(md.creator);
    var date = self.isoDate(md.date);
    var venue = self.venueOf(md);
    var city = md.coverage || '';
    var showDate = date ? self.formatDate(date) : '';
    var albumLabel = showDate +
      (venue ? '  •  ' + venue : '') +
      (city ? ', ' + city : '');

    // Find album art
    var artFile = "";
    for (var i = 0; i < files.length; i++) {
      var fileName = (files[i].name || '').toLowerCase();
      if ((fileName.indexOf(".jpg") >= 0 || fileName.indexOf(".png") >= 0) &&
          fileName.indexOf("thumb") === -1) {
        artFile = files[i].name;
        break;
      }
    }

    // Find the specific track
    for (var j = 0; j < files.length; j++) {
      if (files[j].name == trackName) {
        var file = files[j];
        var trackType = file.format.match(/flac/i) ? "flac" :
                        file.format.match(/ogg/i) ? "ogg" : "mp3";

        var trackTitle = file.title ||
                        (file.track ? "Track " + parseInt(file.track, 10) + " (" + file.name + ")" : file.name);

        var track = [{
          "service": self.serviceName,
          "type": "song",
          "trackType": trackType,
          "title": trackTitle,
          "name": trackTitle,
          "tracknumber": file.track ? parseInt(file.track, 10) : 0,
          "artist": creator,
          "album": albumLabel,
          "albumart": artFile ?
            self.iaDownloadUrl(identifier, artFile) :
            "/albumart?sourceicon=music_service/" + SERVICE_NAME + "/icon.png",
          "uri": self.iaDownloadUrl(identifier, trackName),
          "duration": file.length ? Math.round(parseFloat(file.length)) : 0
        }];

        defer.resolve(track);
        return;
      }
    }

    defer.reject(new Error('Track not found'));
  }).fail(function(err) {
    defer.reject(err);
  });

  return defer.promise;
}

// Explode URI ----------------------------------------------------------------

ControllerInternetArchive.prototype.explodeUri = function(uri) {
  var self = this;
  var defer = libQ.defer();
  // internetarchive/c/{col}/{type}/{identifier}[/{file|format}]
  var parts = uri.split('/');
  var col = decodeURIComponent(parts[2]);
  var type = parts[3];
  var identifier = parts[4];

  // Explode a whole recording in a chosen format: fmt/{identifier}/{format}
  if (type === 'fmt') {
    var format = parts[5];
    self.getSourceTracks(col, identifier, false, format)
      .then(function(items) { defer.resolve(items); })
      .fail(function(err) { defer.reject(err); });
  }
  // Explode a whole recording (all its tracks, default format chain)
  else if (type === 'source') {
    self.getSourceTracks(col, identifier, false)
      .then(function(items) { defer.resolve(items); })
      .fail(function(err) { defer.reject(err); });
  }
  // Explode a single track: track/{identifier}/{file}
  else if (type === 'track') {
    // file.name was encodeURIComponent'd into the browse URI; decode to match metadata.
    var trackName = parts[5] ? decodeURIComponent(parts[5]) : parts[5];
    self.getTrack(identifier, trackName)
      .then(function(items) { defer.resolve(items); })
      .fail(function(err) { defer.reject(err); });
  }
  else {
    defer.reject(new Error(self.getI18nString('QUERY_ERROR')));
  }

  return defer.promise;
};

// Search ---------------------------------------------------------------------
// Searches across all configured collections and returns matching shows as
// playable recordings (source URIs), so results can be browsed/exploded directly.

ControllerInternetArchive.prototype.search = function(query) {
  var self = this;
  var defer = libQ.defer();
  var collections = self.getCollections();

  if (collections.length === 0) {
    return libQ.resolve([]);
  }

  var searchTerm = encodeURIComponent(query.value).replace(/%20/g, '+').replace(/'/g, '%27');
  var colClause = collections.map(function(c) {
    return 'collection%3A' + self.iaEncode(c);
  }).join('+OR+');

  self.resetHistory();

  var uri = iaApiBaseUrl +
    'q=(' + colClause + ')+AND+(' + searchTerm + ')' +
    '&fl=identifier,title,creator,date,collection' +
    '&rows=100' +
    '&page=1' +
    '&output=json';

  var reqCommand = iaCurl(uri) + " | /usr/bin/jq -c '.response.docs';";

  var list = [{
    'type': 'title',
    'title': 'Internet Archive Search Results',
    'availableListViews': ["list"],
    'items': []
  }];

  self.runQuery(reqCommand, defer, 'search', function(resultStr) {
    var docs = JSON.parse(resultStr) || [];

    for (var i = 0; i < docs.length; i++) {
      var item = docs[i];
      var title = item.title || item.identifier;
      var creator = item.creator || '';
      // A doc's collection may be an array; pick the first configured match.
      var docCollections = Array.isArray(item.collection) ? item.collection : [item.collection];
      var col = docCollections.filter(function(c) {
        return collections.indexOf(c) !== -1;
      })[0] || collections[0];

      list[0].items.push({
        "service": self.serviceName,
        "type": "folder",
        "title": title,
        "artist": creator,
        "icon": "fa fa-folder-open",
        "uri": self.colUri(col) + '/source/' + item.identifier
      });
    }

    if (list[0].items.length < 1) {
      list = null;
    }

    defer.resolve(list);
  }, false);

  return defer.promise;
};

// Playback Controls ----------------------------------------------------------

ControllerInternetArchive.prototype.clearAddPlayTrack = function(track) {
  var self = this;
  self.logger.info('clearAddPlayTrack: ' + track.uri);

  var safeUri = track.uri.replace(/"/g, '\\"');

  var phListenerCallback = () => {
    self.logger.info('MPD player state update');
    self.mpdPlugin.getState()
      .then(function(state) {
        var selectedTrackBlock = self.commandRouter.stateMachine.getTrack(self.commandRouter.stateMachine.currentPosition);
        if (selectedTrackBlock.service && selectedTrackBlock.service == SERVICE_NAME) {
          self.mpdPlugin.clientMpd.once('system-player', phListenerCallback);
          return self.pushState(state);
        } else {
          self.logger.info('Not an internetarchive track, removing listener');
        }
      });
  };

  return self.mpdPlugin.sendMpdCommand('stop', [])
    .then(function() {
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function() {
      return self.mpdPlugin.sendMpdCommand('load "' + safeUri + '"', []);
    })
    .fail(function(e) {
      return self.mpdPlugin.sendMpdCommand('add "' + safeUri + '"', []);
    })
    .then(function() {
      self.mpdPlugin.clientMpd.removeAllListeners('system-player');
      self.mpdPlugin.clientMpd.once('system-player', phListenerCallback);

      return self.mpdPlugin.sendMpdCommand('play', [])
        .then(function() {
          return self.mpdPlugin.getState()
            .then(function(state) {
              return self.pushState(state);
            });
        });
    });
}

ControllerInternetArchive.prototype.seek = function(timepos) {
  var self = this;
  self.logger.info('seek to ' + timepos);
  return self.mpdPlugin.seek(timepos);
}

ControllerInternetArchive.prototype.stop = function() {
  var self = this;
  self.logger.info('stop');
  return self.mpdPlugin.stop()
    .then(function() {
      return self.mpdPlugin.getState()
        .then(function(state) {
          return self.pushState(state);
        });
    });
}

ControllerInternetArchive.prototype.pause = function() {
  var self = this;
  self.logger.info('pause');
  return self.mpdPlugin.pause()
    .then(function() {
      return self.mpdPlugin.getState()
        .then(function(state) {
          return self.pushState(state);
        });
    });
}

ControllerInternetArchive.prototype.resume = function() {
  var self = this;
  self.logger.info('resume');
  return self.mpdPlugin.resume()
    .then(function() {
      return self.mpdPlugin.getState()
        .then(function(state) {
          return self.pushState(state);
        });
    });
}

ControllerInternetArchive.prototype.next = function() {
  var self = this;
  self.logger.info('next');
  return self.mpdPlugin.sendMpdCommand('next', [])
    .then(function() {
      return self.mpdPlugin.getState()
        .then(function(state) {
          return self.pushState(state);
        });
    });
}

ControllerInternetArchive.prototype.previous = function() {
  var self = this;
  self.logger.info('previous');
  return self.mpdPlugin.sendMpdCommand('previous', [])
    .then(function() {
      return self.mpdPlugin.getState()
        .then(function(state) {
          return self.pushState(state);
        });
    });
}

ControllerInternetArchive.prototype.prefetch = function(nextTrack) {
  var self = this;
  self.logger.info('prefetch');

  var safeUri = nextTrack.uri.replace(/"/g, '\\"');
  return self.mpdPlugin.sendMpdCommand('add "' + safeUri + '"', [])
    .then(function() {
      return self.mpdPlugin.sendMpdCommand('consume 1', []);
    });
}

// State Management -----------------------------------------------------------

ControllerInternetArchive.prototype.getState = function() {
  var self = this;
  self.logger.info('getState');
};

ControllerInternetArchive.prototype.parseState = function(sState) {
  var self = this;
  self.logger.info('parseState');
};

ControllerInternetArchive.prototype.pushState = function(state) {
  var self = this;
  self.logger.info('pushState');
  return self.commandRouter.servicePushState(state, self.serviceName);
};

// Internationalization -------------------------------------------------------

ControllerInternetArchive.prototype.loadI18nStrings = function() {
  var self = this;

  try {
    var language_code = this.commandRouter.sharedVars.get('language_code');
    self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + language_code + ".json");
  } catch (e) {
    self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
  }

  self.i18nStringsDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
};

ControllerInternetArchive.prototype.getI18nString = function(key) {
  var self = this;

  if (self.i18nStrings && self.i18nStrings[key] !== undefined)
    return self.i18nStrings[key];
  else if (self.i18nStringsDefaults && self.i18nStringsDefaults[key] !== undefined)
    return self.i18nStringsDefaults[key];
  else
    return key;
};

// Query + Error Handling Helpers ---------------------------------------------

// Fetch /metadata/{id} once per recording. Format menu, explode, and each
// track used to hit archive.org separately; a slow one toasted QUERY_ERROR.
ControllerInternetArchive.prototype.fetchItemMetadata = function(identifier) {
  var self = this;
  var hit = self.metaCache[identifier];
  if (hit && (Date.now() - hit.at) < META_TTL_MS) {
    return libQ.resolve(hit.data);
  }
  if (self.metaInflight[identifier]) {
    return self.metaInflight[identifier];
  }

  var defer = libQ.defer();
  self.metaInflight[identifier] = defer.promise;
  var reqCommand = iaCurl(iaMetadataBaseUrl + encodeURIComponent(identifier));

  self.runQuery(reqCommand, defer, 'item metadata', function(resultStr) {
    var data = JSON.parse(resultStr);
    self.metaCache[identifier] = { at: Date.now(), data: data };
    delete self.metaInflight[identifier];
    defer.resolve(data);
  }, false);

  defer.promise.fail(function() {
    delete self.metaInflight[identifier];
  });

  return defer.promise;
};

// Runs a curl (|jq) shell command, accumulates stdout, and invokes onSuccess

// with the full output string. Any spawn/exit/parse error rejects `defer`
// with a translated message and toasts the user.
//
// Run under bash with `pipefail` so a curl failure (e.g. --max-time timeout)
// propagates as a non-zero exit even though jq is last in the pipe. Under plain
// /bin/sh (dash) the pipe would report jq's exit 0 on empty input, silently
// showing an empty list instead of surfacing the error.
ControllerInternetArchive.prototype.runQuery = function(reqCommand, defer, context, onSuccess, popHistory) {
  var self = this;
  if (popHistory === undefined) popHistory = true;

  var reqProcess = spawn('/bin/bash', ['-c', 'set -o pipefail; ' + reqCommand]);
  var resultStr = '';

  reqProcess.stdout.on('data', (data) => {
    resultStr += data.toString();
  });

  reqProcess.stderr.on('data', (data) => {
    if (data) {
      self.logger.error('[internetarchive] curl stderr (' + context + '): ' + data);
    }
  });

  reqProcess.on('error', (err) => {
    self.handleError(context + ' request failed', err, popHistory);
    defer.reject(new Error(self.getI18nString('QUERY_ERROR')));
  });

  reqProcess.on('close', (code) => {
    if (code !== 0) {
      self.handleError(context + ' query failed with code ' + code, new Error('Process exit code: ' + code), popHistory);
      defer.reject(new Error(self.getI18nString('QUERY_ERROR')));
      return;
    }

    try {
      onSuccess(resultStr);
    } catch (e) {
      self.handleError('Failed to parse ' + context + ' JSON', e, popHistory);
      defer.reject(new Error(self.getI18nString('QUERY_ERROR')));
    }
  });
};

ControllerInternetArchive.prototype.handleError = function(context, error, popHistory) {
  var self = this;
  var errorMsg = error.message || error.toString();

  self.logger.error('[internetarchive] ' + context + ': ' + errorMsg);
  self.commandRouter.pushToastMessage('error',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('QUERY_ERROR'));

  if (popHistory) {
    self.historyPop();
  }
};

// Push a "no results" placeholder list and resolve. --------------------------
ControllerInternetArchive.prototype.pushNoExist = function(response, defer) {
  var self = this;
  self.commandRouter.pushToastMessage('info',
    self.getI18nString('PLUGIN_NAME'),
    self.getI18nString('NO_EXIST'));
  response.navigation.lists.push({
    "type": "title",
    "title": self.getI18nString('NO_EXIST'),
    "availableListViews": ["list"],
    "items": []
  });
  defer.resolve(response);
}

// Utility --------------------------------------------------------------------

// URL-encode a value for use inside a single-quoted shell string and an
// archive.org query. encodeURIComponent leaves `'` intact, which would break
// the surrounding shell quoting, so escape it explicitly.
ControllerInternetArchive.prototype.iaEncode = function(value) {
  return encodeURIComponent(value).replace(/'/g, '%27');
};

// Resolve a show's venue. Collections vary: etree/aadamjacobs populate the
// `venue` field, while pearljambootlegs/taperssection leave it empty and embed
// the venue in the title. Fall back to parsing the title in that case.
ControllerInternetArchive.prototype.venueOf = function(doc) {
  if (!doc) return '';
  if (doc.venue && String(doc.venue).trim()) return String(doc.venue).trim();

  var title = doc.title || '';
  // "Artist Live at VENUE on 1995-10-28"
  var m = title.match(/ Live at (.+?) on \d{4}-\d\d-\d\d/i);
  if (m) return m[1].trim();
  // "... Bootleg 1998-09-10, VENUE, City, ..."
  m = title.match(/\d{4}-\d\d-\d\d,\s*([^,]+)/);
  if (m) return m[1].trim();

  return '';
};

ControllerInternetArchive.prototype.sourceOf = function(doc) {
  if (!doc) return '';
  if (doc.source && String(doc.source).trim()) return String(doc.source).trim();
  return '';
};

// "Feb 3, 1995  •  Venue, City  •  SBD > DAT" — date always, then whatever else we have.
ControllerInternetArchive.prototype.showListTitle = function(show) {
  var self = this;
  var parts = [self.formatDate(show.date)];
  var place = (show.venue || '') + (show.city ? (show.venue ? ', ' : '') + show.city : '');
  if (place) parts.push(place);
  if (show.sources && show.sources.length === 1) parts.push(show.sources[0]);
  else if (show.sources && show.sources.length > 1) parts.push(show.sources.length + ' sources');
  return parts.join('  •  ');
};

// Build a playable download URL, URL-encoding the identifier and filename.
// Many recordings (e.g. King Gizzard, Pearl Jam) use filenames with spaces,
// '&', quotes, parentheses, and commas; left raw these produce an invalid URL
// and MPD fails with "failed to decode". encodeURIComponent each path segment
// (splitting the filename on '/' so any subfolders stay as separators).
//
// Always use https://archive.org/download/{id}/{file}. That 302s to a live
// datanode. Pinning metadata.server (an earlier attempt) locked MPD onto a
// snapshot that can already be out of workable_servers, which showed up as
// intermittent "failed to decode". Extra server/dir args are ignored.
ControllerInternetArchive.prototype.iaDownloadUrl = function(identifier, fileName) {
  var encFile = String(fileName).split('/').map(encodeURIComponent).join('/');
  return iaDownloadBaseUrl + encodeURIComponent(identifier) + '/' + encFile;
};

// Normalize an archive.org date ("1995-02-03T00:00:00Z") to "1995-02-03".
ControllerInternetArchive.prototype.isoDate = function(date) {
  if (!date) return '';
  var t = date.indexOf('T');
  return t !== -1 ? date.substring(0, t) : date;
};

// Best-effort 4-digit year for a doc (year field, else parsed from date).
ControllerInternetArchive.prototype.docYear = function(doc) {
  if (doc.year) return String(doc.year);
  var iso = this.isoDate(doc.date);
  return iso ? iso.substring(0, 4) : '';
};

// "1995-02-03" -> "Feb 3, 1995"
ControllerInternetArchive.prototype.formatDate = function(isoDate) {
  var parts = isoDate.split('-');
  if (parts.length < 3) return isoDate;
  var monthIdx = parseInt(parts[1], 10) - 1;
  var month = (monthIdx >= 0 && monthIdx < 12) ? MONTHS[monthIdx] : parts[1];
  return month + ' ' + parseInt(parts[2], 10) + ', ' + parts[0];
};

ControllerInternetArchive.prototype.compareSortKey = function(a, b) {
  const sortKeyA = a.sortKey;
  const sortKeyB = b.sortKey;

  let comparison = 0;
  if (sortKeyA > sortKeyB) {
    comparison = 1;
  } else if (sortKeyA < sortKeyB) {
    comparison = -1;
  }
  return comparison;
};

ControllerInternetArchive.prototype.compareSortKeyDesc = function(a, b) {
  const sortKeyA = a.sortKey;
  const sortKeyB = b.sortKey;

  let comparison = 0;
  if (sortKeyA < sortKeyB) {
    comparison = 1;
  } else if (sortKeyA > sortKeyB) {
    comparison = -1;
  }
  return comparison;
};
