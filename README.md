## doh-forworder

---

command line parameters:
* `listenHost` (optional, default `127.0.0.1`)
* `listenPort` (optional, default `53`)
* `dontUseProxy` (optional, default `false`): requests will use direct network
* `proxyHost` (optional, default `127.0.0.1`): socks5 proxy host
* `proxyPort` (optional, default `1080`): socksS proxy port
* `useRedis` (optional, default `false`)
* `redisHost` (optional, default `127.0.0.1`)
* `redisPort` (optional, default `6379`)
* `redisExpire` (optional, default `1800`): entry in redis expire time, default 30 min
* `logLevel` (optional, default `info`): options are 'trace', 'debug', 'info', 'warn', 'error', 'fatal'