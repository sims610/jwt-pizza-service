const request = require('supertest');
const app = require('../service');
const { tokenPattern, randomName, registerUser } = require('./testUtils');

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };

beforeAll(async () => {
  testUser.email = randomName() + '@test.com';
  await request(app).post('/api/auth').send(testUser);
});

test('register', async () => {
  const newUser = { name: 'new diner', email: randomName() + '@test.com', password: 'b' };
  const registerRes = await request(app).post('/api/auth').send(newUser);
  expect(registerRes.status).toBe(200);
  expect(registerRes.body.token).toMatch(tokenPattern);
  expect(registerRes.body.user).toMatchObject({ name: newUser.name, email: newUser.email, roles: [{ role: 'diner' }] });
  expect(registerRes.body.user.password).toBeUndefined();
});

test('register missing fields', async () => {
  const registerRes = await request(app).post('/api/auth').send({ email: randomName() + '@test.com' });
  expect(registerRes.status).toBe(400);
  expect(registerRes.body.message).toBe('name, email, and password are required');
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(tokenPattern);

  const user = { ...testUser, roles: [{ role: 'diner' }] };
  delete user.password;
  expect(loginRes.body.user).toMatchObject(user);
});

test('login bad password', async () => {
  const loginRes = await request(app).put('/api/auth').send({ ...testUser, password: 'wrong' });
  expect(loginRes.status).toBe(404);
});

test('logout', async () => {
  const { token } = await registerUser();
  const logoutRes = await request(app).delete('/api/auth').set('Authorization', `Bearer ${token}`);
  expect(logoutRes.status).toBe(200);
  expect(logoutRes.body.message).toBe('logout successful');

  // The token should no longer be accepted.
  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token}`);
  expect(meRes.status).toBe(401);
});

test('logout without token', async () => {
  const logoutRes = await request(app).delete('/api/auth');
  expect(logoutRes.status).toBe(401);
});
