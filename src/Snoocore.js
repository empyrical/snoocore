"use strict";

var urlLib = require('url');
var events = require('events');
var util = require('util');
var path = require('path');

var he = require('he');
var when = require('when');
var delay = require('when/delay');

var Endpoint = require('./endpoint');
var utils = require('./utils');

var pkg = require('../package');

module.exports = Snoocore;

Snoocore.version = pkg.version;

Snoocore.oauth = require('./oauth');
Snoocore.request = require('./request');
Snoocore.file = require('./request/file');

Snoocore.when = when;


// - - -


util.inherits(Snoocore, events.EventEmitter);
function Snoocore(config) {

  var self = this;

  events.EventEmitter.call(self);

  self._test = {}; // expose internal functions for testing

  self._serverOAuth = thisOrThat(config.serverOAuth, 'oauth.reddit.com');
  self._serverWWW = thisOrThat(config.serverWWW, 'www.reddit.com');

  var missingMsg = 'Missing required config value ';

  self._userAgent = thisOrThrow(config.userAgent, 'Missing required config value `userAgent`');
  self._isNode = thisOrThat(config.browser, utils.isNode());
  self._apiType = thisOrThat(config.apiType, 'json');
  self._decodeHtmlEntities = thisOrThat(config.decodeHtmlEntities, false);
  self._retryAttempts = thisOrThat(config.retryAttempts, 60);
  self._retryDelay = thisOrThat(config.retryDelay, 5000);

  self._authenticatedAuthData = {}; // Set if Authenticated with OAuth
  self._applicationOnlyAuthData = {}; // Set if authenticated with Application Only OAuth

  self._refreshToken = ''; // Set when calling `refresh` and when duration: 'permanent'

  self._oauth = thisOrThat(config.oauth, {});
  self._oauth.scope = thisOrThat(self._oauth.scope, []);
  self._oauth.deviceId = thisOrThat(self._oauth.deviceId, 'DO_NOT_TRACK_THIS_DEVICE');
  self._oauth.type = thisOrThrow(self._oauth.type, missingMsg + '`oauth.type`');
  self._oauth.key = thisOrThrow(self._oauth.key, missingMsg + '`oauth.key`');

  if (!isOAuthType('explicit') && !isOAuthType('implicit') && !isOAuthType('script')) {
    throw new Error('Invalid `oauth.type`. Must be one of: explicit, implicit, or script');
  }

  if (isOAuthType('explicit') || isOAuthType('script')) {
    self._oauth.secret = thisOrThrow(self._oauth.secret, missingMsg + '`oauth.secret` for type explicit/script');
  }


  if (isOAuthType('script')) {
    self._oauth.username = thisOrThrow(self._oauth.username,  missingMsg + '`oauth.username` for type script');
    self._oauth.password = thisOrThrow(self._oauth.password, missingMsg + '`oauth.password` for type script');
  }

  if (isOAuthType('implicit') || isOAuthType('explicit')) {
    self._oauth.redirectUri = thisOrThrow(self._oauth.redirectUri,
                                          missingMsg + '`oauth.redirectUri` for type implicit/explicit');
  }

  //
  //--- end of initial configuration
  //

  /*
     The current throttle delay before a request will go through
     increments every time a call is made, and is reduced when a
     call finishes.

     Time is added & removed based on the throttle variable.
   */
  self._throttleDelay = 1;


  self._test.getThrottle = getThrottle;
  function getThrottle() {
    return 1000; // OAuth only requires 1000ms
  }

  /*
     Return the value of `tryThis` unless it's undefined, then return `that`
   */
  self._test.thisOrThat = thisOrThat;
  function thisOrThat(tryThis, that) {
    return (typeof tryThis !== 'undefined') ? tryThis : that;
  }

  self._test.thisOrThrow = thisOrThrow;
  function thisOrThrow(tryThis, orThrowMessage) {
    if (typeof tryThis !== 'undefined') { return tryThis; }
    throw new Error(orThrowMessage);
  }

  /*
     Have we authorized with OAuth?
   */
  self._test.hasAuthenticatedData = hasAuthenticatedData;
  function hasAuthenticatedData() {
    return (typeof self._authenticatedAuthData.access_token !== 'undefined' &&
      typeof self._authenticatedAuthData.token_type !== 'undefined');
  }

  /*
     Have we authenticated with application only OAuth?
   */
  self._test.hasApplicationOnlyData = hasApplicationOnlyData;
  function hasApplicationOnlyData() {
    return (typeof self._applicationOnlyAuthData.access_token !== 'undefined' &&
      typeof self._applicationOnlyAuthData.token_type !== 'undefined');
  }

  /*
     Checks if the oauth is of a specific type, e.g.

     isOAuthType('script')
   */
  self._test.isOAuthType = isOAuthType;
  function isOAuthType(type) {
    return self._oauth.type === type;
  }

  /*
     Do we have a refresh token defined?
   */
  self._test.hasRefreshToken = hasRefreshToken;
  function hasRefreshToken() {
    return self._refreshToken !== '';
  }

  /*
     Are we in application only mode?
     Has the user not called `.auth()` yet?
     Or has the user called `.deauth()`?
   */
  self._test.isApplicationOnly = isApplicationOnly;
  function isApplicationOnly() {
    return !hasAuthenticatedData();
  }

  /*
     Gets the authorization header for when we are using application only OAuth
   */
  self._test.getApplicationOnlyAuthorizationHeader = getApplicationOnlyAuthorizationHeader;
  function getApplicationOnlyAuthorizationHeader() {
    return self._applicationOnlyAuthData.token_type + ' ' + self._applicationOnlyAuthData.access_token;
  }

  /*
     Gets the authorization header for when we are authenticated with OAuth
   */
  self._test.getAuthenticatedAuthorizationHeader = getAuthenticatedAuthorizationHeader;
  function getAuthenticatedAuthorizationHeader() {
    return self._authenticatedAuthData.token_type + ' ' + self._authenticatedAuthData.access_token;
  }

  /*
     Takes an url, and an object of url parameters and replaces
     them, e.g.

     endpointUrl:
     'http://example.com/$foo/$bar/test.html'

     givenArgs: { $foo: 'hello', $bar: 'world' }

     would output:

     'http://example.com/hello/world/test.html'
   */
  self._test.replaceUrlParams = replaceUrlParams;
  function replaceUrlParams(endpointUrl, givenArgs) {
    // nothing to replace!
    if (endpointUrl.indexOf('$') === -1) {
      return endpointUrl;
    }

    // pull out variables from the url
    var params = endpointUrl.match(/\$[\w\.]+/g);

    // replace with the argument provided
    params.forEach(function(param) {
      if (typeof givenArgs[param] === 'undefined') {
        throw new Error('missing required url parameter ' + param);
      }
      endpointUrl = endpointUrl.replace(param, givenArgs[param]);
    });

    return endpointUrl;
  }

  /*
     Builds the URL that we will query reddit with.
   */
  self._test.buildUrl = buildUrl;
  function buildUrl(givenArgs, endpoint, options) {
    options = options || {};
    var serverOAuth = thisOrThat(options.serverOAuth, self._serverOAuth);

    var url = 'https://' + path.join(serverOAuth, endpoint.path);
    url = replaceUrlParams(url, givenArgs);
    return url;
  }

  /*
     Build the arguments that we will send to reddit in our
     request. These customize the request that we send to reddit
   */
  self._test.buildArgs = buildArgs;
  function buildArgs(endpointArgs, endpoint) {

    endpointArgs = endpointArgs || {};
    var args = {};

    // Skip any url parameters (e.g. items that begin with $)
    for (var key in endpointArgs) {
      if (key.substring(0, 1) !== '$') {
        args[key] = endpointArgs[key];
      }
    }

    var apiType = thisOrThat(endpointArgs.api_type, self._apiType);

    if (apiType && endpoint.needsApiTypeJson) {
      args.api_type = apiType;
    }

    return args;
  }

  /*
     Returns a set of options that effect how each call to reddit behaves.
   */
  self._test.normalizeCallContextOptions = normalizeCallContextOptions;
  function normalizeCallContextOptions(callContextOptions) {

    var ccOptions = callContextOptions || {};

    // by default we do not bypass authentication
    ccOptions.bypassAuth = thisOrThat(ccOptions.bypassAuth, false);

    // decode html enntities for this call?
    ccOptions.decodeHtmlEntities = thisOrThat(ccOptions.decodeHtmlEntities, self._decodeHtmlEntities);

    // how many attempts left do we have to retry an endpoint?
    ccOptions.retryAttemptsLeft = thisOrThat(ccOptions.retryAttemptsLeft, ccOptions.retryAttempts);
    ccOptions.retryAttemptsLeft = thisOrThat(ccOptions.retryAttemptsLeft, self._retryAttempts);

    // delay between retrying an endpoint
    ccOptions.retryDelay = thisOrThat(ccOptions.retryDelay, self._retryDelay);

    // how many reauthentication attempts do we have left?
    ccOptions.reauthAttemptsLeft = thisOrThat(ccOptions.reauthAttemptsLeft, ccOptions.retryAttemptsLeft);

    return ccOptions;
  }


  /*
     Returns a uniform error for all response errors.
   */
  self._test.getResponseError = getResponseError;
  function getResponseError(message, response, url, args) {

    var responseError = new Error([
      message,
      '>>> Response Status: ' + response._status,
      '>>> Endpoint URL: '+ url,
      '>>> Arguments: ' + JSON.stringify(args, null, 2),
      '>>> Response Body:',
      response._body
    ].join('\n\n'));

    responseError.url = url;
    responseError.args = args;
    responseError.status = response._status;
    responseError.body = response._body;

    return responseError;
  }

  /*
     Handle a reddit 500 / server error. This will try to call the endpoint again
     after the given retryDelay. If we do not have any retry attempts left, it
     will reject the promise with the error.
   */
  self._test.handleServerErrorResponse = handleServerErrorResponse;
  function handleServerErrorResponse(response, endpoint, givenArgs, callContextOptions) {

    --callContextOptions.retryAttemptsLeft;

    var args = buildArgs(givenArgs, endpoint);
    var url = buildUrl(givenArgs, endpoint, callContextOptions);

    var responseError = getResponseError('Server Error Response', response, url, args);
    responseError.retryAttemptsLeft = callContextOptions.retryAttemptsLeft;
    self.emit('server_error', responseError);

    if (callContextOptions.retryAttemptsLeft <= 0) {
      responseError.message = 'All retry attempts exhausted.\n\n' + responseError.message;
      return when.reject(responseError);
    }

    return delay(callContextOptions.retryDelay).then(function() {
      return callRedditApi(endpoint, givenArgs, callContextOptions);
    });
  }

  /*
     Handle a reddit 400 / client error. This is usually caused when our access_token
     has expired.

     If we can't renew our access token, we throw an error / emit the 'access_token_expired'
     event that users can then handle to re-authenticatet clients

     If we can renew our access token, we try to reauthenticate, and call the reddit
     endpoint again.
   */
  self._test.handleClientErrorResponse = handleClientErrorResponse;
  function handleClientErrorResponse(response, endpoint, givenArgs, callContextOptions) {

    var args = buildArgs(givenArgs, endpoint);
    var url = buildUrl(givenArgs, endpoint, callContextOptions);

    // If we are *not* application only oauth and can't renew the access token
    // then we should throw an error
    if (!isApplicationOnly() && !hasRefreshToken() && !isOAuthType('script')) {
      self.emit('access_token_expired');
      return when.reject(new Error('Access token has expired. Listen for ' +
                                   'the "access_token_expired" event to handle ' +
                                   'this gracefully in your app.'));

    }

    // Check reddit's response and throw a more specific error if possible
    try {
      var data = JSON.parse(response._body);
    } catch(e) {} // do nothing, may be unauthenticated

    if (typeof data === 'object' && data.reason === 'USER_REQUIRED') {
      return when.reject(new Error('Must be authenticated with a user to make a call to this endpoint.'));
    }

    // If a call to an `any` OAuth scope returns a 4xx status, we need to
    // authenticate. Else, the user has probably forgotten a scope or the
    // endpoint requires reddit gold
    var requestOptions = {
      method: endpoint.method.toUpperCase(),
      hostname: self._serverOAuth,
      path: '/api/needs_captcha',
      headers: buildHeaders(callContextOptions)
    };

    return Snoocore.request.https(requestOptions).then(function(anyResponse) {
      // If we can successfuly make a call to the `any` OAuth scope
      // then the origional call is invalid. Let the user know
      if (String(anyResponse._status).substring(0, 1) !== '4') {
        // make the error with the origional response object
        return when.reject(getResponseError(
          'Missing a required scope or this call requires reddit gold',
          response,
          url,
          args));
      }

      --callContextOptions.reauthAttemptsLeft;

      if (callContextOptions.reauthAttemptsLeft <= 0) {
        return when.reject(new Error('Unable to refresh the access_token.'));
      }

      var reauth;

      // If we are application only, or are bypassing authentication for a call
      // go ahead and use application only OAuth
      if (isApplicationOnly() || callContextOptions.bypassAuth) {
        reauth = self.applicationOnlyAuth();
      } else {
        // If we have been authenticated with a permanent refresh token
        if (hasRefreshToken()) { reauth = self.refresh(self._refreshToken); }
        // If we are OAuth type script and not implicit authenticated
        if (isOAuthType('script')) { reauth = self.auth(); }
      }

      return reauth.then(function() {
        return callRedditApi(endpoint, givenArgs, callContextOptions);
      });

    });
  }

  /*
     Handle reddit response status of 2xx.

     Finally return the data if there were no problems.
   */
  self._test.handleSuccessResponse = handleSuccessResponse;
  function handleSuccessResponse(response, endpoint, givenArgs, callContextOptions) {
    var data = response._body || {};
    var args = buildArgs(givenArgs, endpoint);
    var url = buildUrl(givenArgs, endpoint, callContextOptions);

    if (callContextOptions.decodeHtmlEntities) {
      data = he.decode(data);
    }

    // Attempt to parse some JSON, otherwise continue on (may be empty, or text)
    try {
      data = JSON.parse(data);
    } catch(e) {}

    return when.resolve(data);
  }

  /*
     Handles various reddit response cases.
   */
  self._test.handleRedditResponse = handleRedditResponse;
  function handleRedditResponse(response, endpoint, givenArgs, callContextOptions) {

    switch(String(response._status).substring(0, 1)) {
      case '5':
        return handleServerErrorResponse(response, endpoint, givenArgs, callContextOptions);
      case '4':
        return handleClientErrorResponse(response, endpoint, givenArgs, callContextOptions);
      case '2':
        return handleSuccessResponse(response, endpoint, givenArgs, callContextOptions);
    }

    return when.reject(new Error('Invalid reddit response status of ' + response._status));
  }

  /*
     Builds up the headers for a call to reddit.
   */
  self._test.buildHeaders = buildHeaders;
  function buildHeaders(callContextOptions) {
    callContextOptions = callContextOptions || {};
    var headers = {};

    if (self._isNode) {
      headers['User-Agent'] = self._userAgent; // Can't set User-Agent in browser
    }

    if (callContextOptions.bypassAuth || isApplicationOnly()) {
      headers['Authorization'] = getApplicationOnlyAuthorizationHeader();
    } else {
      headers['Authorization'] = getAuthenticatedAuthorizationHeader();
    }

    return headers;
  }

  /*
     Call the reddit api.
   */
  self._test.callRedditApi = callRedditApi;
  function callRedditApi(endpoint, givenArgs, callContextOptions) {

    callContextOptions = normalizeCallContextOptions(callContextOptions);

    var args = buildArgs(givenArgs, endpoint);
    var url = buildUrl(givenArgs, endpoint, callContextOptions);
    var parsedUrl = urlLib.parse(url);

    var requestOptions = {
      method: endpoint.method.toUpperCase(),
      hostname: parsedUrl.hostname,
      path: parsedUrl.path,
      headers: buildHeaders(callContextOptions)
    };

    if (parsedUrl.port) {
      requestOptions.port = parsedUrl.port;
    }

    var throttle = getThrottle();
    var startCallTime = Date.now();
    self._throttleDelay += throttle;

    // Wait for the throttle delay amount, then call the Reddit API
    return delay(self._throttleDelay - throttle).then(function() {
      return Snoocore.request.https(requestOptions, args);
    }).then(function(response) {
      return handleRedditResponse(response, endpoint, givenArgs, callContextOptions);
    }).finally(function() {
      // decrement the throttle delay. If the call is quick and snappy, we
      // only decrement the total time that it took to make the call.
      var endCallTime = Date.now();
      var callDuration = endCallTime - startCallTime;

      if (callDuration < throttle) {
        self._throttleDelay -= callDuration;
      } else {
        self._throttleDelay -= throttle;
      }
    });

  }

  /*
     Listing support.
   */
  function getListing(endpoint, givenArgs, options) {

    givenArgs = givenArgs || {};
    options = options || {};

    // number of results that we have loaded so far. It will
    // increase / decrease when calling next / previous.
    var count = 0;
    var limit = givenArgs.limit || 25;
    // keep a reference to the start of this listing
    var start = givenArgs.after || null;

    function getSlice(givenArgs) {
      return callRedditApi(endpoint, givenArgs, options).then(function(result) {

        var slice = {};
        var listing = result || {};

        slice.get = result || {};

        if (result instanceof Array) {
          if (typeof options.listingIndex === 'undefined') {
            throw new Error('Must specify a `listingIndex` for this listing.');
          }

          listing = result[options.listingIndex];
        }

        slice.count = count;

        slice.before = listing.data.before || null;
        slice.after = listing.data.after || null;
        slice.allChildren = listing.data.children || [];

        slice.empty = slice.allChildren.length === 0;

        slice.children = slice.allChildren.filter(function(child) {
          return !child.data.stickied;
        });

        slice.stickied = slice.allChildren.filter(function(child) {
          return child.data.stickied;
        });

        slice.next = function() {
          count += limit;

          var args = givenArgs;
          args.before = null;
          args.after = slice.children[slice.children.length - 1].data.name;
          args.count = count;
          return getSlice(args);
        };

        slice.previous = function() {
          count -= limit;

          var args = givenArgs;
          args.before = slice.children[0].data.name;
          args.after = null;
          args.count = count;
          return getSlice(args);
        };

        slice.start = function() {
          count = 0;

          var args = givenArgs;
          args.before = null;
          args.after = start;
          args.count = count;
          return getSlice(args);
        };

        slice.requery = function() {
          return getSlice(givenArgs);
        };

        return slice;
      });

    }

    return getSlice(givenArgs);
  }

  /*
     Enable path syntax support, e.g. reddit('/path/to/$endpoint/etc')

     Can take an url as well, but the first part of the url is chopped
     off because it is not needed. We will always use the server oauth
     to call the API...

     e.g. https://www.example.com/api/v1/me

     will only use the path: /api/v1/me
   */
  self.path = function(urlOrPath) {

    var parsed = urlLib.parse(urlOrPath);
    var path = parsed.pathname;

    var calls = {};

    ['get', 'post', 'put', 'patch', 'delete', 'update'].forEach(function(verb) {
      calls[verb] = function(givenArgs, callContextOptions) {
        return callRedditApi(new Endpoint(verb, path),
                             givenArgs,
                             callContextOptions);
      };
    });

    // Add listing support
    calls.listing = function(givenArgs, callContextOptions) {
      return getListing(new Endpoint('get', path),
                        givenArgs,
                        callContextOptions);
    };

    return calls;
  };

  /*
     Get the Explicit Auth Url
   */
  self.getExplicitAuthUrl = function(state, options) {
    var options = self._oauth;
    options.state = state || Math.ceil(Math.random() * 1000);
    options.serverWWW = thisOrThat(options.serverWWW, self._serverWWW);
    return Snoocore.oauth.getExplicitAuthUrl(options);
  };

  /*
     Get the Implicit Auth Url
   */
  self.getImplicitAuthUrl = function(state, options) {
    var options = self._oauth;
    options.state = state || Math.ceil(Math.random() * 1000);
    options.serverWWW = thisOrThat(options.serverWWW, self._serverWWW);
    return Snoocore.oauth.getImplicitAuthUrl(options);
  };

  /*
     Authenticate with a refresh token
   */
  self.refresh = function(refreshToken, options) {
    options = options || {};
    var serverWWW = thisOrThat(options.serverWWW, self._serverWWW);

    return Snoocore.oauth.getAuthData('refresh', {
      refreshToken: refreshToken,
      key: self._oauth.key,
      secret: self._oauth.secret,
      redirectUri: self._oauth.redirectUri,
      scope: self._oauth.scope,
      serverWWW: serverWWW
    }).then(function(authDataResult) {
      // only set the internal refresh token if reddit
      // agrees that it was OK and sends back authData
      self._refreshToken = refreshToken;

      self._authenticatedAuthData = authDataResult;
    });
  };

  /*
     Sets the auth data from the oauth module to allow OAuth calls.

     This function can authenticate with:

     - Script based OAuth (no parameter)
     - Raw authentication data
     - Authorization Code (request_type = "code")
     - Access Token (request_type = "token") / Implicit OAuth
     - Application Only. (void 0, true);
   */
  self.auth = function(authDataOrAuthCodeOrAccessToken, isApplicationOnly, options) {

    options = options || {};
    var serverWWW = thisOrThat(options.serverWWW, self._serverWWW);

    var authData;

    switch(self._oauth.type) {
      case 'script':
        authData = Snoocore.oauth.getAuthData(self._oauth.type, {
          key: self._oauth.key,
          secret: self._oauth.secret,
          scope: self._oauth.scope,
          username: self._oauth.username,
          password: self._oauth.password,
          applicationOnly: isApplicationOnly,
          serverWWW: serverWWW
        });
        break;

      case 'explicit':
        authData = Snoocore.oauth.getAuthData(self._oauth.type, {
          authorizationCode: authDataOrAuthCodeOrAccessToken, // auth code in this case
          key: self._oauth.key,
          secret: self._oauth.secret,
          redirectUri: self._oauth.redirectUri,
          scope: self._oauth.scope,
          applicationOnly: isApplicationOnly,
          serverWWW: serverWWW
        });
        break;

      case 'implicit':
        if (isApplicationOnly) {
          authData = Snoocore.oauth.getAuthData(self._oauth.type, {
            key: self._oauth.key,
            scope: self._oauth.scope,
            applicationOnly: true,
            serverWWW: serverWWW
          });
        } else {
          // Set the access token, no need to make another call to reddit
          // using the `Snoocore.oauth.getAuthData` call
          authData = {
            access_token: authDataOrAuthCodeOrAccessToken, // access token in this case
            token_type: 'bearer',
            expires_in: 3600,
            scope: self._oauth.scope
          };
        }
        break;

      default:
        // assume that it is the authData
        authData = authDataOrAuthCodeOrAccessToken;
    }

    return when(authData).then(function(authDataResult) {

      if (typeof authDataResult !== 'object') {
        return when.reject(new Error(
          'There was a problem authenticating: ', authDataResult));
      }

      if (!isApplicationOnly) {
        self._authenticatedAuthData = authDataResult;
      } else {
        self._applicationOnlyAuthData = authDataResult;
      }

      // if the explicit app used a perminant duration, send
      // back the refresh token that will be used to re-authenticate
      // later without user interaction.
      if (authDataResult.refresh_token) {
        // set the internal refresh token for automatic expiring
        // access_token management
        self._refreshToken = authDataResult.refresh_token;
        return authDataResult.refresh_token;
      }
    });
  };

  /*
     Only authenticates with Application Only OAuth
   */
  self.applicationOnlyAuth = function() {
    return self.auth(void 0, true);
  };

  /*
     Clears any authentication data & removes OAuth authentication

     By default it will only remove the "access_token". Specify
     the users refresh token to revoke that token instead.
   */
  self.deauth = function(refreshToken, options) {

    options = options || {};
    var serverWWW = thisOrThat(options.serverWWW, self._serverWWW);

    // no need to deauth if not authenticated
    if (!hasAuthenticatedData()) {
      return when.resolve();
    }

    var isRefreshToken = typeof refreshToken === 'string';
    var token = isRefreshToken ? refreshToken : self._authenticatedAuthData.access_token;

    return Snoocore.oauth.revokeToken(token, isRefreshToken, {
      key: self._oauth.key,
      secret: self._oauth.secret,
      serverWWW: serverWWW
    }).then(function() {
      self._authenticatedAuthData = {}; // clear internal authenticated auth data.
    });
  };



  /*
     Make self.path the primary function that we return, but
     still allow access to the objects defined on self
   */
  var key;
  for (key in self) {
    self.path[key] = self[key];
  }

  self = self.path;
  return self;
}