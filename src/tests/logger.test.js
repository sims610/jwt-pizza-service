const request = require('supertest');
const app = require('../service');
const logger = require('../logger');
const { registerUser } = require('./testUtils');

afterEach(() => jest.restoreAllMocks());

test('logs HTTP method, path, status, auth, and bodies', async () => {
  const logSpy = jest.spyOn(logger, 'log');
  await request(app).put('/api/auth').send({ email: 'nobody@test.com', password: 'secret' });

  const [level, type, data] = logSpy.mock.calls.find((c) => c[1] === 'http');
  expect(type).toBe('http');
  expect(['info', 'warn', 'error']).toContain(level);
  expect(data.method).toBe('PUT');
  expect(data.path).toBe('/api/auth');
  expect(data.authorized).toBe(false);
  expect(data.user).toBeNull();
  expect(data.reqBody).toContain('nobody@test.com');
  expect(typeof data.resBody).toBe('string');
});

test('sets authorized when an Authorization header is present', async () => {
  const logSpy = jest.spyOn(logger, 'log');
  await request(app).get('/api/user/me').set('Authorization', 'Bearer bogus');
  const [, , data] = logSpy.mock.calls.find((c) => c[1] === 'http');
  expect(data.authorized).toBe(true);
  expect(data.statusCode).toBe(401);
});

test('logs SQL queries with the authenticated user', async () => {
  const { user, token } = await registerUser();
  const logSpy = jest.spyOn(logger, 'log');
  await request(app).get('/api/order').set('Authorization', `Bearer ${token}`);

  const dbLogs = logSpy.mock.calls.filter((c) => c[1] === 'db').map((c) => c[2]);
  const orderQuery = dbLogs.find((d) => d.sql.includes('FROM dinerOrder'));
  expect(orderQuery).toBeDefined();
  expect(orderQuery.user).toEqual({ id: user.id, email: user.email });
  // The token lookup in setAuthUser runs before the user is known.
  expect(dbLogs.find((d) => d.sql.includes('FROM auth')).user).toBeNull();
});

test('SQL logged outside a request has no user', () => {
  const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => {});
  logger.dbLogger('SELECT 1');
  expect(logSpy).toHaveBeenCalledWith('info', 'db', { user: null, sql: 'SELECT 1' });
});

test('logs exceptions that reach the Express error handler', async () => {
  const logSpy = jest.spyOn(logger, 'log');
  const res = await request(app).put('/api/auth').send({ email: 'nobody@test.com', password: 'wrong' });

  const [level, , data] = logSpy.mock.calls.find((c) => c[1] === 'exception');
  expect(level).toBe('warn');
  expect(data).toMatchObject({ method: 'PUT', path: '/api/auth', statusCode: res.status, user: null });
  expect(data.message).toBe(res.body.message);
  expect(data.stack).toContain('Error');
});

test('logs exceptions outside a request as errors', () => {
  const logSpy = jest.spyOn(logger, 'log');
  logger.unhandledErrorLogger(new Error('boom'));
  logger.unhandledErrorLogger('not an Error object');

  expect(logSpy.mock.calls[0]).toEqual(['error', 'exception', expect.objectContaining({ statusCode: 500, message: 'boom', method: undefined, user: null })]);
  expect(logSpy.mock.calls[1][2].message).toBe('not an Error object');
});

test('statusToLogLevel maps status codes', () => {
  expect(logger.statusToLogLevel(200)).toBe('info');
  expect(logger.statusToLogLevel(404)).toBe('warn');
  expect(logger.statusToLogLevel(500)).toBe('error');
});

describe('sanitize', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.abcDEF123-_';
  const hash = '$2b$10$' + 'a'.repeat(53);
  // sanitize returns a string; parse it (and the bodies inside) back to check values.
  const clean = (data) => JSON.parse(logger.sanitize(data));
  const cleanBody = (body) => JSON.parse(clean({ reqBody: JSON.stringify(body) }).reqBody);

  test('masks secrets inside stringified request/response bodies', () => {
    expect(cleanBody({ email: 'a@b.com', password: 'hunter2' })).toEqual({ email: 'a@b.com', password: '*****' });
    expect(cleanBody({ user: { id: 1 }, token: jwt })).toEqual({ user: { id: 1 }, token: '*****' });
  });

  test.each([
    ['a quote', 'abc"hunter2'],
    ['a backslash', 'abc\\hunter2'],
    ['a number', 12345678],
    ['an object', { nested: 'hunter2' }],
  ])('masks a password containing %s', (_, password) => {
    expect(cleanBody({ password })).toEqual({ password: '*****' });
  });

  test('masks secret-looking field names in any case or style', () => {
    const out = clean({ accessToken: 'x', api_key: 'x', apiKey: 'x', jwtSecret: 'x', Authorization: 'x', items: [{ refreshToken: 'x' }] });
    expect(JSON.stringify(out)).not.toContain('"x"');
  });

  test('masks JWTs and bcrypt hashes embedded in plain text', () => {
    const out = clean({ message: `jwt malformed: ${jwt}`, sql: `UPDATE user SET password='${hash}'` });
    expect(out.message).toBe('jwt malformed: *****');
    expect(out.sql).toBe("UPDATE user SET password='*****'");
  });

  test('leaves ordinary data alone', () => {
    const data = { method: 'GET', statusCode: 200, user: null, authorized: false, reqBody: '{"price":0.05}', resBody: 'not {json', sql: 'SELECT * FROM menu' };
    expect(clean(data)).toEqual(data);
  });
});

test('DB log for a password update has no hash in it', async () => {
  const { user, token } = await registerUser();
  const logSpy = jest.spyOn(logger, 'log');
  await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${token}`).send({ name: 'new name', email: user.email, password: 'newpass' });

  const update = logSpy.mock.calls.find((c) => c[1] === 'db' && c[2].sql.startsWith('UPDATE user'));
  expect(update[2].sql).toBe('UPDATE user SET password=?, email=?, name=? WHERE id=?');
});

test('sendLogToGrafana posts to Loki outside of tests', async () => {
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 500 });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    logger.log('info', 'http', { method: 'GET' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.streams[0].stream).toMatchObject({ level: 'info', type: 'http' });
    expect(options.headers.Authorization).toMatch(/^Bearer /);
    await new Promise((r) => setImmediate(r));
  } finally {
    process.env.NODE_ENV = env;
  }
});
