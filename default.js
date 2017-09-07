var QueryString = require('querystring');
var Named = require('named/lib/index');
var Request = require('request');
var Yargs = require('yargs');
var Socks5HttpsAgent = require('socks5-https-client/lib/Agent');
var Redis = require('ioredis');
var Log4js = require('log4js');

Log4js.configure({
    appenders: {
        out: { type: 'stdout' }
    },
    categories: {
        default: { appenders: [ 'out' ], level: 'trace' }
    }
});
var logger = Log4js.getLogger('general');
var redisLogger = Log4js.getLogger('redis');

if (!String.prototype.format) {
    String.prototype.format = function () {
        var args = arguments;
        return this.replace(/{(\d+)}/g, function (match, number) {
            return typeof args[number] !== 'undefined'
                ? args[number]
                : match
                ;
        });
    };
}
if (!String.prototype.endsWith) {
    String.prototype.endsWith = function(suffix) {
        return this.indexOf(suffix, this.length - suffix.length) !== -1;
    }
}

var argv = Yargs.argv;
var useProxy = !argv.dontUseProxy;
var proxyHost = argv.proxyHost || '127.0.0.1';
var proxyPort = argv.proxyPort || 1080;
if (useProxy) {
    Request.defaults({
        agentClass: Socks5HttpsAgent,
        agentOptions: {
            socksHost: proxyHost,
            socksPort: proxyPort
        }
    })
}
var dohAddress = argv.dohAddress || 'https://dns.google.com/resolve';
var listenHost = argv.listenHost || '127.0.0.1';
var listenPort = argv.listenPort || 53;
var useRedis = (!!argv.useRedis);
var redisHost = argv.redisHost || '127.0.0.1';
var redisPort = argv.redisPort || 6379;
logger.info('dohAddress: {0}'.format(dohAddress));
logger.info('listenAddress: {0}:{1}'.format(listenHost, listenPort));
logger.info('useProxy: {0}'.format(useProxy));
if (useProxy) {
    logger.info('proxyAddress: {0}:{1}'.format(proxyHost, proxyPort));
}
logger.info('useRedis: {0}'.format(useRedis));
if (useRedis) {
    logger.info('redisAddress: {0}:{1}'.format(redisHost, redisPort));
}

var redisClient = useRedis ? new Redis(redisPort, redisHost) : null;
var dnsServer = Named.createServer();
dnsServer.listen(listenPort, listenHost, function() {});

dnsServer.on('query', function(query) {
    var requestName = query.name();
    var requestType = query.type();

    logger.trace('request: name={0}, type={1}'.format(requestName, requestType));

    var redisKey = null;
    if (useRedis) {
        redisKey = QueryString.stringify({ name: requestName, type: requestType });
        logger.trace('RedisKey: "{0}"'.format(redisKey));
        redisClient.smembers(redisKey, function(err, result) {
            if (result !== undefined && result.length > 0) {
                redisLogger.trace('key "{0}" HIT'.format(redisKey));
                responseDns(dnsServer, query, result.map(function(t) { return QueryString.parse(t) }));
            } else {
                redisLogger.trace('key "{0}" MISS'.format(redisKey));
                queryDns(dohAddress, requestName, requestType, function(answers) {
                    if (answers !== null) {
                        responseDns(dnsServer, query, answers);
                        if (answers.length > 0) {
                            redisClient.sadd(redisKey, answers.map(function (t) { return QueryString.stringify(t) }), function(err, result) {
                                redisLogger.trace('key "{0}" cached'.format(redisKey));
                                redisClient.expire(redisKey, 600);
                            });
                        }
                    }
                });
            }
        });
    } else {
        queryDns(dohAddress, requestName, requestType, function(answers) {
            if (answers !== null) {
                responseDns(dnsServer, query, answers);
            }
        });
    }
});

function queryDns(url, name, type, callback) {
    Request.get({
        url: url,
        qs: {
            name: name,
            type: type
        }
    }, function(err, response, body) {
        if (err || !response || response.statusCode !== 200) {
            callback(null);
        } else {
            var dnsResponse = JSON.parse(body);
            logger.trace('doh: status={0} answers=[{1}]'
                .format(
                    dnsResponse.Status, dnsResponse.Answer
                        ? dnsResponse.Answer.map(function (t) {
                            return "name={0} type={1} ttl={2} data={3}".format(t.name, t.type, t.TTL, t.data)
                        }).join(', ')
                        : ''
                )
            );
            if (dnsResponse.Status !== 0) {
                callback(null);
            } else {
                if (!dnsResponse.Answer || dnsResponse.Answer.length === 0) {
                    callback([]);
                } else {
                    var answers = dnsResponse.Answer.map(function (t) { return {name: t.name, type: t.type, data: t.data, ttl: t.TTL}; });
                    callback(answers);
                }
            }
        }
    });
}

var dnsTypes = {
    1: 'A',
    5: 'CNAME',
    6: 'SOA',
    15: 'MX',
    16: 'TXT',
    28: 'AAAA',
    33: 'SRV'
};

function responseDns(server, query, answers) {
    answers.forEach(function (a) {
        var target = null;
        switch (parseInt(a.type)) {
            case 1: // A
                target = new Named.ARecord(a.data);
                break;
            case 5: // CNAME
                target = new Named.CNAMERecord(a.data);
                break;
            case 6: // SOA
                var parts = a.data.split(' ');
                target = new Named.SOARecord(parts[0], {
                    admin: parts[1],
                    serial: !!parts[2] ? parseInt(parts[2]) : undefined,
                    refresh: !!parts[3] ? parseInt(parts[2]) : undefined,
                    retry: !!parts[4] ? parseInt(parts[2]) : undefined,
                    expire: !!parts[5] ? parseInt(parts[2]) : undefined,
                    ttl: !!parts[6] ? parseInt(parts[2]) : undefined
                });
                break;
            case 15: // MX
                var parts = a.data.split(' ');
                if (parts.length === 2) {
                    target = new Named.MXRecord(parts[1], { priority: parseInt(a[0]) });
                } else if (parts.length === 1) {
                    target = new Named.MXRecord(parts[0]);
                }
                break;
            case 16: // TXT
                target = new Named.TXTRecord(a.data);
                break;
            case 28: // AAAA
                target = new Named.AAAARecord(a.data);
                break;
            case 33: // SRV
                target = new Named.SRVRecord(a.data);
                break;
        }
        if (target !== null) {
            if (a.name.endsWith('.')) {
                a.name = a.name.slice(0, -1);
            }
            query.addAnswer(a.name, target, parseInt(a.ttl));
        }
    });
    server.send(query);
}