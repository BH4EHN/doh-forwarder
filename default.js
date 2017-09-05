var Dnsd = require('dnsd');
var DnsdConstants = require('dnsd/constants');
var Request = require('request');
var Yargs = require('yargs');
var Socks5HttpsAgent = require('socks5-https-client/lib/Agent');

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
if (!argv.dontUseProxy) {
    Request.defaults({
        agentClass: Socks5HttpsAgent,
        agentOptions: {
            socksHost: argv.proxyHost || 'localhost',
            socksPort: argv.proxyPort || 1080
        }
    })
}
var dohAddress = argv.dohAddress || 'https://dns.google.com/resolve';
var listenAddress = argv.listenAddress || 'localhost';
var listenPort = argv.listenPort || 53;

Dnsd.createServer(dnsRequestHandler).listen(listenPort, listenAddress, function() { console.log('DNS server running') });

function dnsRequestHandler(req, res) {
    var question = res.question && req.question[0];
    console.log('Request: name={0}, type={1}'.format(question.name, question.type));
    Request.get({
        url: dohAddress,
        qs: {
            name: question.name,
            type: question.type,
            cd: 0
        }
    }, function (error, response, body) {
        if (response && response.statusCode === 200) {
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

            if (dnsResponse.Status === 0) {
                if (dnsResponse.Answer && dnsResponse.Answer.length > 0) {
                    var answers = dnsResponse.Answer.filter(function(t) {
                        return [1, 5, 6].indexOf(t.type) !== -1;
                    }).map(function (t) {
                        return {name: t.name, type: DnsdConstants.type_to_label(t.type), data: t.data, ttl: t.TTL};
                    });
                    res.answer = res.answer.concat(answers);
                }
                /*if (dnsResponse.Authority && dnsResponse.Authority.length > 0) {
                    var authorities = dnsResponse.Authority.map(function (t) {
                        return {name: t.name, type: DnsdConstants.type_to_label(t.type), data: t.data, ttl: t.ttl}
                    });
                    res.authority = res.authority.concat(authorities);
                }*/
            }
        }
        res.end();
    });
}