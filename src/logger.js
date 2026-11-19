const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.js');

// Holds the current Express request for everything that runs while handling it,
// so code without access to `req` (like the database layer) can find the user.
const requestContext = new AsyncLocalStorage();

const MASK = '*****';
// Field names that hold secrets: password, token, accessToken, jwt, jwtSecret, apiKey, api_key, authorization, ...
const SENSITIVE_KEY = /password|token|jwt|secret|key|authorization/i;
// A JWT is three base64url parts, and the first always starts with "eyJ" (base64 for '{"').
const JWT_PATTERN = /eyJ[\w-]*\.[\w-]+\.[\w-]*/g;
// A bcrypt password hash: $2b$10$ followed by 53 characters.
const BCRYPT_PATTERN = /\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}/g;

class Logger {
  // Express middleware: logs every HTTP request once the response is sent.
  // Must run after express.json() (for req.body). req.user is read when the
  // response is sent, so it reflects setAuthUser even though that runs later.
  httpLogger = (req, res, next) => {
    const send = res.send;
    res.send = (resBody) => {
      const logData = {
        // Behind a proxy/load balancer req.ip is the proxy, so prefer the
        // original client address from X-Forwarded-For when present.
        ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip,
        userAgent: req.headers['user-agent'],
        authorized: !!req.headers.authorization,
        user: this.currentUser(),
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        reqBody: JSON.stringify(req.body ?? {}),
        resBody: typeof resBody === 'string' ? resBody : JSON.stringify(resBody),
      };
      const level = this.statusToLogLevel(res.statusCode);
      this.log(level, 'http', logData);
      res.send = send;
      return res.send(resBody);
    };
    requestContext.run(req, next);
  };

  // Logs a SQL statement with the user whose request triggered it.
  // Only the statement (with ? placeholders) is logged, never the parameter
  // values, since those include password hashes and auth tokens.
  dbLogger(sql) {
    this.log('info', 'db', { user: this.currentUser(), sql });
  }

  // Logs a call to the pizza factory: the user, what was sent, and what came back.
  factoryLogger(reqBody, resBody, ok, statusCode) {
    this.log(ok ? 'info' : 'error', 'factory', {
      user: this.currentUser(),
      url: `${config.factory.url}/api/order`,
      statusCode,
      reqBody: JSON.stringify(reqBody),
      resBody: JSON.stringify(resBody),
    });
  }

  // Logs an exception. Pass `req` when it happened while handling a request.
  // 4xx errors are expected (bad input, not found, forbidden), so they log as warn.
  // Returns the send promise so a crashing process can wait for it before exiting.
  unhandledErrorLogger(err, req) {
    const statusCode = err?.statusCode ?? 500;
    return this.log(this.statusToLogLevel(statusCode), 'exception', {
      user: this.currentUser(),
      method: req?.method,
      path: req?.originalUrl,
      statusCode,
      message: err?.message ?? String(err),
      stack: err?.stack,
    });
  }

  currentUser() {
    const user = requestContext.getStore()?.user;
    return user ? { id: user.id, email: user.email } : null;
  }

  log(level, type, logData) {
    const labels = { component: config.logging?.source ?? 'jwt-pizza-service', level, type };
    const values = [this.nowString(), this.sanitize(logData)];
    const logEvent = { streams: [{ stream: labels, values: [values] }] };
    return this.sendLogToGrafana(logEvent);
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  // Loki expects a nanosecond timestamp as a string.
  nowString() {
    return (Date.now() * 1000000).toString();
  }

  // Never ship secrets to Grafana. Returns the log entry as a JSON string.
  sanitize(logData) {
    return JSON.stringify(this.redact(logData));
  }

  // Walks the data and masks every field whose name looks secret, whatever type
  // its value is. Strings holding JSON (request/response bodies) are parsed and
  // walked too. Any other text has token- and hash-shaped substrings masked, as a
  // backstop for secrets that turn up in SQL, error messages, or stack traces.
  redact(value, key = '') {
    if (SENSITIVE_KEY.test(key) && value != null) return MASK;
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redact(v, k)]));
    }
    if (typeof value !== 'string') return value;

    if (/^\s*[[{]/.test(value)) {
      try {
        return JSON.stringify(this.redact(JSON.parse(value)));
      } catch {
        // Not JSON after all; treat it as plain text.
      }
    }
    return value.replace(JWT_PATTERN, MASK).replace(BCRYPT_PATTERN, MASK);
  }

  sendLogToGrafana(event) {
    const { logging } = config;
    if (!logging?.endpointUrl || process.env.NODE_ENV === 'test') return Promise.resolve();
    return fetch(logging.endpointUrl, {
      method: 'POST',
      body: JSON.stringify(event),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${logging.accountId}:${logging.apiKey}`,
      },
    })
      .then((res) => {
        if (!res.ok) console.log('Failed to send log to Grafana', res.status);
      })
      .catch((err) => console.log('Error sending log to Grafana', err.message));
  }
}

module.exports = new Logger();
