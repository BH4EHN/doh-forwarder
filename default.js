const QueryString = require('querystring');
const Named = require('named/lib/index');
const Request = require('request');
const Yargs = require('yargs');
const Socks5HttpsAgent = require('socks5-https-client/lib/Agent');
const Redis = require('ioredis');
const NodeCache = require( "node-cache" );
const Log4js = require('log4js');

const argv = Yargs.argv;
const useProxy = !argv.dontUseProxy;
const proxyHost = argv.proxyHost || '127.0.0.1';
const proxyPort = argv.proxyPort || 1080;
if (useProxy) {
    Request.defaults({
        agentClass: Socks5HttpsAgent,
        agentOptions: {
            socksHost: proxyHost,
            socksPort: proxyPort
        }
    })
}
const dohAddress = argv.dohAddress || 'https://dns.google.com/resolve';
const listenHost = argv.listenHost || '127.0.0.1';
const listenPort = argv.listenPort || 53;
const useRedis = (!!argv.useRedis);
const redisHost = argv.redisHost || '127.0.0.1';
const redisPort = argv.redisPort || 6379;
const cacheExpire = argv.cacheExpire || 1800;
const logLevel =
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].indexOf(argv.logLevel) === -1
        ? 'info'
        : argv.logLevel;

Log4js.configure({
    appenders: {
        out: { type: 'stdout' }
    },
    categories: {
        default: { appenders: [ 'out' ], level: logLevel }
    }
});
const logger = Log4js.getLogger('general');

logger.info(`dohAddress: ${dohAddress}`);
logger.info(`listenAddress: ${listenHost}:${listenPort}`);
logger.info(`useProxy: ${useProxy}`);
if (useProxy) {
    logger.info(`proxyAddress: ${proxyHost}:${proxyPort}`);
}
logger.info(`useRedis: ${useRedis}`);
if (useRedis) {
    logger.info(`redisAddress: ${redisHost}:${redisPort}`);
}

const redisClient = useRedis ? new Redis(redisPort, redisHost) : null;
const redisLogger = Log4js.getLogger('redis');
const nodeCache = useRedis ? null : new NodeCache({ stdTTL: cacheExpire });
const dnsServer = Named.createServer();
dnsServer.listen(listenPort, listenHost, () => {
    logger.info(`named server started and running on ${listenHost}:${listenPort}`);
});

const withRedis = (server, query) => {
    let requestName = query.name();
    let requestType = query.type();
    let redisKey = QueryString.stringify({ name: requestName, type: requestType });
    logger.trace(`Key: ${redisKey}`);
    redisClient.smembers(redisKey, (err, result) => {
        if (result !== undefined && result.length > 0) {
            redisLogger.trace(`Key "${redisKey}" HIT`);
            responseDns(server, query, result.map((t) => QueryString.parse(t)));
        } else {
            redisLogger.trace(`Key "${redisKey}" MISS`);
            queryDns(dohAddress, requestName, requestType, (answers) => {
                if (answers !== null) {
                    responseDns(server, query, answers);
                    if (answers.length > 0) {
                        redisClient.del(redisKey, function() {
                            redisLogger.trace(`Key "${redisKey}" deleted`);
                            redisClient.sadd(redisKey, answers.map((t) => QueryString.stringify(t)), (err, result) => {
                                redisLogger.trace(`Key "${redisKey}" cached`);
                                redisClient.expire(redisKey, cacheExpire, () => {
                                    redisLogger.trace(`Key "${redisKey} set expire"`);
                                });
                            });
                        });
                    }
                }
            });
        }
    });
};

const withCache = (server, query) => {
    let requestName = query.name();
    let requestType = query.type();
    let cacheKey = QueryString.stringify({ name: requestName, type: requestType });
    logger.trace(`CacheKey: ${cacheKey}`);
    nodeCache.get(cacheKey, function(err, value) {
        if (value !== undefined) {
            logger.trace(`CacheKey: ${cacheKey} HIT`);
            responseDns(server, query, value);
            nodeCache.ttl(cacheKey, cacheExpire);
        } else {
            logger.trace(`CacheKey: ${cacheKey} MISS`);
            queryDns(dohAddress, requestName, requestType, function(answers) {
                if (answers !== null) {
                    responseDns(server, query, answers);
                    if (answers.length > 0) {
                        nodeCache.set(cacheKey, answers);
                    }
                }
            });
        }
    });
};

const withNothing = (server, query) => {
    let requestName = query.name();
    let requestType = query.type();
    queryDns(dohAddress, requestName, requestType, function (answers) {
        if (answers !== null) {
            responseDns(server, query, answers);
        }
    });
};

const processQuery = useRedis ? withRedis : withCache;

dnsServer.on('query', (query) => {
    let requestName = query.name();
    let requestType = query.type();
    logger.debug(`request: name=${requestName}, type=${requestType}`);
    processQuery(dnsServer, query);
});

const queryMap = new Map();
const queryDns = (url, name, type, callback) => {
    let key = QueryString.stringify({ name: name, type: type });
    if (queryMap.has(key)) {
        queryMap.get(key).push(callback);
    } else {
        queryMap.set(key, [callback]);
        Request.get({
            url: url,
            qs: {
                name: name,
                type: type
            }
        }, function(err, response, body) {
            let invokeAll = (c, r) => {
                c.forEach((t) => t(r));
            };
            let callbacks = queryMap.get(key);
            queryMap.delete(key);
            if (err || !response || response.statusCode !== 200) {
                invokeAll(callbacks, null);
            } else {
                let dnsResponse = JSON.parse(body);
                logger.trace(`doh: status=${dnsResponse.Status} answers=[${dnsResponse.Answer
                    ? dnsResponse.Answer.map(t => `{name=${t.name},type=${t.type},ttl=${t.TTL},data=${t.data}}`).join(', ')
                    : ''}]`);
                if (dnsResponse.Status !== 0) {
                    invokeAll(callbacks, null);
                } else {
                    if (!dnsResponse.Answer || dnsResponse.Answer.length === 0) {
                        invokeAll(callbacks, []);
                    } else {
                        let answers = dnsResponse.Answer.map(function (t) { return {name: t.name, type: t.type, data: t.data, ttl: t.TTL}; });
                        invokeAll(callbacks, answers);
                    }
                }
            }
        });
    }
};

const dnsTypes = {
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
        let target = null;
        switch (parseInt(a.type)) {
            case 1: // A
                target = new Named.ARecord(a.data);
                break;
            case 5: // CNAME
                if (a.data.endsWith('.')) {
                    a.data = a.data.slice(0, -1);
                }
                target = new Named.CNAMERecord(a.data);
                break;
            case 6: // SOA
                let soaParts = a.data.split(' ');
                target = new Named.SOARecord(soaParts[0], {
                    admin: soaParts[1],
                    serial: !!soaParts[2] ? parseInt(soaParts[2]) : undefined,
                    refresh: !!soaParts[3] ? parseInt(soaParts[2]) : undefined,
                    retry: !!soaParts[4] ? parseInt(soaParts[2]) : undefined,
                    expire: !!soaParts[5] ? parseInt(soaParts[2]) : undefined,
                    ttl: !!soaParts[6] ? parseInt(soaParts[2]) : undefined
                });
                break;
            case 15: // MX
                let mxParts = a.data.split(' ');
                if (mxParts.length === 2) {
                    target = new Named.MXRecord(mxParts[1], { priority: parseInt(a[0]) });
                } else if (mxParts.length === 1) {
                    target = new Named.MXRecord(mxParts[0]);
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