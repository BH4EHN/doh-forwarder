var Dnsd = require('dnsd');
var DnsdConstants = require('dnsd/constants');
var Request = require('request');
var Yargs = require('yargs');
var Socks5HttpsAgent = require('socks5-https-client/lib/Agent');
var Redis = require('ioredis');

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

var argv = Yargs.argv;
var useProxy = !argv.dontUseProxy || true;
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
console.log('DohAddress: {0}'.format(dohAddress));
console.log('listenAddress: {0}:{1}'.format(listenHost, listenPort));
console.log('useProxy: {0}'.format(useProxy));
if (useProxy) {
    console.log('proxyAddress: {0}:{1}'.format(proxyHost, proxyPort));
}
console.log('useRedis: {0}'.format(useRedis));
if (useRedis) {
    console.log('redisAddress: {0}:{1}'.format(redisHost, redisPort));
}

var redisClient = useRedis ? new Redis(redisPort, redisHost) : null;
Dnsd.createServer(dnsRequestHandler).listen(listenPort, listenHost, function() { console.log('DNS server running') });

process.on('uncaughtException', function(err) {
    console.error('UncaughtException: {0}'.format(err.message));
});

function dnsRequestHandler(req, res) {
    var question = res.question && req.question[0];
    var requestName = question.name;
    var requestType = question.type;
    console.log('Request: name={0}, type={1}'.format(requestName, requestType));

    var redisKey = null;
    if (useRedis) {
        redisKey = JSON.stringify({ name: question.name, type: question.type });
        console.log('RedisKey: {0}'.format(redisKey));
        redisClient.smembers(redisKey, function(err, result) {
            if (result !== undefined && result.length > 0) {
                console.log('RedisKey: {0} HIT'.format(redisKey));
                responseDns(res, result.map(function(t) { return JSON.parse(t) }));
            } else {
                console.log('RedisKey: {0} MISS'.format(redisKey));
                queryDns(dohAddress, requestName, requestType, function(answers) {
                    responseDns(res, answers);
                    redisClient.sadd(redisKey, answers.map(function (t) { return JSON.stringify(t) }), function(err, result) {
                        redisClient.expire(redisKey, 600);
                    });
                });
            }
        });
    } else {
        queryDns(dohAddress, requestName, requestType, function(answers) {
            responseDns(res, answers);
        });
    }
}

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
            console.log('DOH: status={0} answers=[{1}]'
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

function responseDns(res, answers) {
    res.answer = res.answer.concat(
        answers
            .filter(function (t) { return [1, 5, 6].indexOf(t.type) !== -1 })
            .map(function (t) { return {name: t.name, type: DnsdConstants.type_to_label(t.type), data: t.data, ttl: t.ttl} }));
    res.end();
}