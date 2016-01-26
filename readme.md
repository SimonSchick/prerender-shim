# Enviroment variables

```
BROWSER_COUNT: number default 1
PORT: number default 3000
ADDRESS: string default localhost
EXPLICIT_TIMEOUT: number in milliseconds default 15000ms
IMPLICIT_TIMEOUT: number in milliseconds default 2000ms
CACHE_TTL: number in seconds default 300
BROWSER_LOGGING_PATH: string default /dev/null
MAX_RETRIES: number default 2
```

No caching will be performed when element that matches selector `meta[name=fragment]` is not found.
User agent is `Prerender`, will not request images.
