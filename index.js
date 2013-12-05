var _ = require('underscore');
var crypto = require('crypto');

function getKey(arr) {
	var key = '';
	_(arr).each(function (part) {
		if (part) {
			key += crypto.createHash('sha256').update(part).digest('base64');
		}
	});
	return crypto.createHash('sha256').update(key).digest('base64');
}

var ExpressBrute = module.exports = function (store, options) {
	var i;
	ExpressBrute.instanceCount++;
	this.name = "brute"+ExpressBrute.instanceCount;
	_.bindAll(this, 'reset', 'getMiddleware');

	// set options
	this.options = _.extend({}, ExpressBrute.defaults, options);
	if (this.options.minWait < 1) {
		this.options.minWait++;
	}
	this.store = store;

	// build delays array
	this.delays = [];
	for (i = 0; i < this.options.freeRetries; i++) {
		this.delays[i] = 0;
	}
	this.delays.push(this.options.minWait);
	while(this.delays[this.delays.length-1] < this.options.maxWait) {
		var nextNum = this.delays[this.delays.length-1] + (this.delays.length > 1 ? this.delays[this.delays.length-2] : 0);
		this.delays.push(nextNum);
	}
	this.delays[this.delays.length-1] = this.options.maxWait;

	// set default lifetime
	if (typeof this.options.lifetime == "undefined") {
		this.options.lifetime = (this.options.maxWait/1000)*(this.delays.length);
		this.options.lifetime = Math.ceil(this.options.lifetime);
	}

	// generate "prevent" middleware
	this.prevent = this.getMiddleware();
};
ExpressBrute.prototype.getMiddleware = function (key) {
	// standardize input
	var keyFunc = key;
	if (typeof keyFunc !== 'function') {
		keyFunc = function (req, res, next) { next(key); };
	}

	// create middleware
	return _.bind(function (req, res, next) {
		keyFunc(req, res, _.bind(function (key) {
			key = getKey([req.connection.remoteAddress, this.name, key]);

			// attach a simpler "reset" functio to req.brute.reset
			var reset = _.bind(function (callback) {
				this.store.reset(key, callback);
			}, this);
			if (req.brute && req.brute.reset) {
				// wrap existing reset if one exists
				var oldReset = req.brute.reset;
				var newReset = reset;
				reset = function (callback) {
					oldReset(function () {
						newReset(callback);
					});
				};
			}
			req.brute = {
				reset: reset
			};

			// filter request
			this.store.get(key, _.bind(function (err, value) {
				if (err) {
					throw "Cannot get request count";
				}

				var count = 0,
					delayIndex = 0,
					lastValidRequestTime = this.now();
				if (value) {
					count = value.count;
					delayIndex = (count < this.delays.length ? count : this.delays.length) - 1;
					lastValidRequestTime = value.lastRequest.getTime();
				}
				var nextValidRequestTime = lastValidRequestTime+this.delays[delayIndex];
					
				if (count < 1 || nextValidRequestTime <= this.now()) {
					this.store.set(key, {count: count+1, lastRequest: new Date(this.now())}, this.options.lifetime || 0, function (err) {
						if (err) {
							throw "Cannot increment request count";
						}
						typeof next == 'function' && next();
					});
				} else {
					this.options.failCallback(req, res, next, new Date(nextValidRequestTime));
				}
			}, this));
		},this));
	}, this);
};
ExpressBrute.prototype.reset = function (ip, key, callback) {
	key = getKey([ip, this.name, key]);
	this.store.reset(key, callback);
};
ExpressBrute.prototype.now = function () {
	return Date.now();
};

ExpressBrute.FailForbidden = function (req, res, next, nextValidRequestDate) {
	res.send(403, {error: {text: "Too many requests in this time frame.", nextValidRequestDate: nextValidRequestDate}});
};
ExpressBrute.FailMark = function (req, res, next, nextValidRequestDate) {
	res.status(403);
	res.nextValidRequestDate = nextValidRequestDate;
	next();
};
ExpressBrute.MemoryStore = require('./lib/MemoryStore');
ExpressBrute.MemcachedStore = require('./lib/MemcachedStore');
ExpressBrute.defaults = {
	freeRetries: 2,
	minWait: 500,
	maxWait: 1000*60*15, // 15 minutes
	failCallback: ExpressBrute.FailForbidden
};
ExpressBrute.instanceCount = 0;