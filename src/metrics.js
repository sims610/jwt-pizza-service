const os = require('os');
const config = require('./config.js');

const REPORT_INTERVAL_MS = 10000;

// Cumulative counters. Grafana computes per-minute rates from these with rate()/increase().
const requestsByMethod = { GET: 0, PUT: 0, POST: 0, DELETE: 0 };

// Latency, as cumulative total milliseconds + count. Grafana divides the rates to get average latency.
const latency = {
  endpoint: { totalMs: 0, count: 0 },
  pizza: { totalMs: 0, count: 0 },
};

function recordLatency(kind, ms) {
  latency[kind].totalMs += ms;
  latency[kind].count++;
}

function pizzaLatency(ms) {
  recordLatency('pizza', ms);
}

// Express middleware: counts every HTTP request by method and times it until the response finishes.
function requestTracker(req, res, next) {
  const method = req.method.toUpperCase();
  requestsByMethod[method] = (requestsByMethod[method] ?? 0) + 1;
  const start = performance.now();
  res.on('finish', () => recordLatency('endpoint', performance.now() - start));
  next();
}

function latencyMetrics(kind, name) {
  return [
    buildMetric(`${name}_latency_ms`, 'sum', '{ms}', [{ value: latency[kind].totalMs, double: true }]),
    buildMetric(`${name}_latency_count`, 'sum', '1', [{ value: latency[kind].count }]),
  ];
}

// Active users: anyone who logged in or made an authenticated request within ACTIVE_WINDOW_MS.
// Logging out removes the user immediately; idle users age out of the window.
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const lastSeenByUser = new Map();

function userActive(user) {
  if (user?.id != null) lastSeenByUser.set(user.id, Date.now());
}

function userLoggedOut(user) {
  if (user?.id != null) lastSeenByUser.delete(user.id);
}

// Express middleware: must run after setAuthUser so req.user is populated.
function activeUserTracker(req, res, next) {
  userActive(req.user);
  next();
}

function activeUserCount(now = Date.now()) {
  for (const [id, lastSeen] of lastSeenByUser) {
    if (now - lastSeen > ACTIVE_WINDOW_MS) lastSeenByUser.delete(id);
  }
  return lastSeenByUser.size;
}

// Authentication attempts (login via PUT /api/auth), cumulative by result.
const authAttempts = { success: 0, failure: 0 };

function authAttempt(success) {
  authAttempts[success ? 'success' : 'failure']++;
}

// Pizza sales, cumulative. Failures count failed order requests, not individual pizzas.
const pizzaStats = { sold: 0, failures: 0, revenue: 0 };

function pizzaPurchase(success, order) {
  if (!success) {
    pizzaStats.failures++;
    return;
  }
  const items = order?.items ?? [];
  pizzaStats.sold += items.length;
  pizzaStats.revenue += items.reduce((sum, item) => sum + (Number(item.price) || 0), 0);
}

// System CPU: 1-minute load average divided by core count.
// Note: os.loadavg() always returns 0 on Windows, so this reads 0 in local development.
function getCpuUsagePercentage() {
  return round2((os.loadavg()[0] / os.cpus().length) * 100);
}

function getMemoryUsagePercentage() {
  const total = os.totalmem();
  return round2(((total - os.freemem()) / total) * 100);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function attributes(extra = {}) {
  const attrs = { source: config.metrics?.source ?? 'jwt-pizza-service', ...extra };
  return Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}

// Builds one OTLP metric. type is 'sum' (monotonic counter) or 'gauge'.
// dataPoints is an array of { value, attributes } so a single metric can carry several series.
function buildMetric(name, type, unit, dataPoints) {
  const timeUnixNano = Date.now() * 1_000_000;
  const metric = {
    name,
    unit,
    [type]: {
      dataPoints: dataPoints.map((dp) => ({
        [Number.isInteger(dp.value) && !dp.double ? 'asInt' : 'asDouble']: dp.value,
        timeUnixNano,
        attributes: attributes(dp.attributes),
      })),
    },
  };
  if (type === 'sum') {
    metric.sum.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
    metric.sum.isMonotonic = true;
  }
  return metric;
}

function collectMetrics() {
  return [
    buildMetric(
      'http_requests',
      'sum',
      '1',
      Object.entries(requestsByMethod).map(([method, count]) => ({ value: count, attributes: { method } }))
    ),
    buildMetric('active_users', 'gauge', '{users}', [{ value: activeUserCount() }]),
    buildMetric(
      'auth_attempts',
      'sum',
      '1',
      Object.entries(authAttempts).map(([result, count]) => ({ value: count, attributes: { result } }))
    ),
    buildMetric('pizzas_sold', 'sum', '1', [{ value: pizzaStats.sold }]),
    buildMetric('pizza_failures', 'sum', '1', [{ value: pizzaStats.failures }]),
    // Always sent as a double so the series type doesn't flip between int and double.
    buildMetric('pizza_revenue', 'sum', '{BTC}', [{ value: pizzaStats.revenue, double: true }]),
    ...latencyMetrics('endpoint', 'endpoint'),
    ...latencyMetrics('pizza', 'pizza_creation'),
    buildMetric('cpu_usage_percent', 'gauge', '%', [{ value: getCpuUsagePercentage() }]),
    buildMetric('memory_usage_percent', 'gauge', '%', [{ value: getMemoryUsagePercentage() }]),
  ];
}

async function sendMetrics(metrics) {
  const body = { resourceMetrics: [{ scopeMetrics: [{ metrics }] }] };
  try {
    const response = await fetch(config.metrics.endpointUrl, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      console.error(`Failed to push metrics to Grafana: ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error('Error pushing metrics:', error.message);
  }
}

// Starts the periodic push to Grafana. Called from index.js only, so tests never send metrics.
function startReporting(intervalMs = REPORT_INTERVAL_MS) {
  if (!config.metrics?.endpointUrl) {
    console.warn('Metrics disabled: no metrics config found');
    return null;
  }
  const timer = setInterval(() => sendMetrics(collectMetrics()), intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  requestTracker,
  activeUserTracker,
  userActive,
  userLoggedOut,
  activeUserCount,
  authAttempt,
  pizzaPurchase,
  pizzaLatency,
  getCpuUsagePercentage,
  getMemoryUsagePercentage,
  startReporting,
  collectMetrics,
  buildMetric,
};
