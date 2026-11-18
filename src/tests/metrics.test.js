const request = require('supertest');
const app = require('../service');
const metrics = require('../metrics');

function requestCount(method) {
  const [httpRequests] = metrics.collectMetrics();
  const point = httpRequests.sum.dataPoints.find((dp) => dp.attributes.some((a) => a.key === 'method' && a.value.stringValue === method));
  return point ? point.asInt : 0;
}

test('counts requests by method', async () => {
  const getBefore = requestCount('GET');
  const deleteBefore = requestCount('DELETE');

  await request(app).get('/');
  await request(app).get('/api/docs');
  await request(app).delete('/api/auth');

  expect(requestCount('GET')).toBe(getBefore + 2);
  expect(requestCount('DELETE')).toBe(deleteBefore + 1);
});

test('http_requests is a cumulative monotonic sum', () => {
  const [httpRequests] = metrics.collectMetrics();
  expect(httpRequests.name).toBe('http_requests');
  expect(httpRequests.sum.isMonotonic).toBe(true);
  expect(httpRequests.sum.aggregationTemporality).toBe('AGGREGATION_TEMPORALITY_CUMULATIVE');
  expect(httpRequests.sum.dataPoints.map((dp) => dp.attributes.find((a) => a.key === 'method').value.stringValue)).toEqual(
    expect.arrayContaining(['GET', 'PUT', 'POST', 'DELETE'])
  );
});

test('buildMetric gauge uses double for fractional values', () => {
  const m = metrics.buildMetric('cpu', 'gauge', '%', [{ value: 12.5 }]);
  expect(m.gauge.dataPoints[0].asDouble).toBe(12.5);
  expect(m.gauge.sum).toBeUndefined();
});

test('startReporting is a no-op without metrics config', () => {
  const config = require('../config');
  const saved = config.metrics;
  delete config.metrics;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect(metrics.startReporting()).toBeNull();
  config.metrics = saved;
});

describe('active users', () => {
  const { registerUser } = require('./testUtils');

  test('register adds an active user and logout removes them', async () => {
    const before = metrics.activeUserCount();
    const { token } = await registerUser();
    expect(metrics.activeUserCount()).toBe(before + 1);

    await request(app).delete('/api/auth').set('Authorization', `Bearer ${token}`);
    expect(metrics.activeUserCount()).toBe(before);
  });

  test('users age out after 5 minutes of inactivity', () => {
    metrics.userActive({ id: -42 });
    const now = Date.now();
    expect(metrics.activeUserCount(now)).toBeGreaterThanOrEqual(1);
    const countAfterWindow = metrics.activeUserCount(now + 5 * 60 * 1000 + 1);
    expect(countAfterWindow).toBe(0);
  });

  test('active_users is reported as a gauge', () => {
    const activeUsers = metrics.collectMetrics().find((m) => m.name === 'active_users');
    expect(activeUsers.gauge.dataPoints[0]).toHaveProperty('asInt');
  });
});

describe('auth attempts', () => {
  function authCount(result) {
    const m = metrics.collectMetrics().find((x) => x.name === 'auth_attempts');
    return m.sum.dataPoints.find((dp) => dp.attributes.some((a) => a.key === 'result' && a.value.stringValue === result)).asInt;
  }

  test('counts successful and failed logins', async () => {
    const { registerUser } = require('./testUtils');
    const { user } = await registerUser();
    const successBefore = authCount('success');
    const failureBefore = authCount('failure');

    const ok = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
    expect(ok.status).toBe(200);
    const bad = await request(app).put('/api/auth').send({ email: user.email, password: 'wrong' });
    expect(bad.status).not.toBe(200);

    expect(authCount('success')).toBe(successBefore + 1);
    expect(authCount('failure')).toBe(failureBefore + 1);
  });
});

describe('system metrics', () => {
  test('cpu is load average divided by core count', () => {
    const os = require('os');
    jest.spyOn(os, 'loadavg').mockReturnValue([2, 1, 1]);
    jest.spyOn(os, 'cpus').mockReturnValue(new Array(4).fill({}));
    expect(metrics.getCpuUsagePercentage()).toBe(50);
    jest.restoreAllMocks();
  });

  test('memory is a percentage between 0 and 100', () => {
    const value = metrics.getMemoryUsagePercentage();
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(100);
  });

  test('cpu and memory are reported as gauges', () => {
    const names = metrics.collectMetrics().filter((m) => m.gauge).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['cpu_usage_percent', 'memory_usage_percent']));
  });
});

describe('pizza metrics', () => {
  function value(name) {
    const dp = metrics.collectMetrics().find((m) => m.name === name).sum.dataPoints[0];
    return dp.asInt ?? dp.asDouble;
  }

  let token;
  beforeAll(async () => {
    const { registerUser } = require('./testUtils');
    ({ token } = await registerUser());
  });

  afterEach(() => jest.restoreAllMocks());

  const orderReq = {
    franchiseId: 1,
    storeId: 1,
    items: [
      { menuId: 1, description: 'Veggie', price: 0.05 },
      { menuId: 1, description: 'Veggie', price: 0.0038 },
    ],
  };

  test('successful order counts pizzas sold and revenue', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ reportUrl: 'r', jwt: 'j' }) });
    const [sold, revenue, failures] = [value('pizzas_sold'), value('pizza_revenue'), value('pizza_failures')];

    const res = await request(app).post('/api/order').set('Authorization', `Bearer ${token}`).send(orderReq);
    expect(res.status).toBe(200);

    expect(value('pizzas_sold')).toBe(sold + 2);
    expect(value('pizza_revenue')).toBeCloseTo(revenue + 0.0538, 6);
    expect(value('pizza_failures')).toBe(failures);
  });

  test('factory rejection counts a failure and no sales', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, json: async () => ({ reportUrl: 'r' }) });
    const [sold, failures] = [value('pizzas_sold'), value('pizza_failures')];

    const res = await request(app).post('/api/order').set('Authorization', `Bearer ${token}`).send(orderReq);
    expect(res.status).toBe(500);

    expect(value('pizzas_sold')).toBe(sold);
    expect(value('pizza_failures')).toBe(failures + 1);
  });

  test('factory network error counts a failure', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('factory down'));
    const failures = value('pizza_failures');

    const res = await request(app).post('/api/order').set('Authorization', `Bearer ${token}`).send(orderReq);
    expect(res.status).toBe(500);
    expect(value('pizza_failures')).toBe(failures + 1);
  });

  test('revenue is always sent as a double', () => {
    const revenue = metrics.collectMetrics().find((m) => m.name === 'pizza_revenue');
    expect(revenue.sum.dataPoints[0]).toHaveProperty('asDouble');
  });
});

describe('latency metrics', () => {
  function value(name) {
    const dp = metrics.collectMetrics().find((m) => m.name === name).sum.dataPoints[0];
    return dp.asInt ?? dp.asDouble;
  }

  afterEach(() => jest.restoreAllMocks());

  test('endpoint latency is recorded for each request', async () => {
    const [ms, count] = [value('endpoint_latency_ms'), value('endpoint_latency_count')];
    await request(app).get('/');
    expect(value('endpoint_latency_count')).toBe(count + 1);
    expect(value('endpoint_latency_ms')).toBeGreaterThan(ms);
  });

  test('pizza creation latency times the factory call, including failures', async () => {
    const { registerUser } = require('./testUtils');
    const { token } = await registerUser();
    const orderReq = { franchiseId: 1, storeId: 1, items: [{ menuId: 1, description: 'Veggie', price: 0.05 }] };
    const [ms, count] = [value('pizza_creation_latency_ms'), value('pizza_creation_latency_count')];

    jest.spyOn(global, 'fetch').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({}) }), 50))
    );
    await request(app).post('/api/order').set('Authorization', `Bearer ${token}`).send(orderReq);

    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('factory down'));
    await request(app).post('/api/order').set('Authorization', `Bearer ${token}`).send(orderReq);

    expect(value('pizza_creation_latency_count')).toBe(count + 2);
    expect(value('pizza_creation_latency_ms') - ms).toBeGreaterThanOrEqual(45);
  });
});
