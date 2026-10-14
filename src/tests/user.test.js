const request = require('supertest');
const app = require('../service');
const { tokenPattern, randomName, registerUser, createAdminUser } = require('./testUtils');

let diner;
let admin;

beforeAll(async () => {
  diner = await registerUser();
  admin = await createAdminUser();
});

test('get menu as registered user', async () => {
  const menuRes = await request(app).get('/api/order/menu').set('Authorization', `Bearer ${diner.token}`);
  expect(menuRes.status).toBe(200);
  expect(Array.isArray(menuRes.body)).toBe(true);
});

test('get me', async () => {
  const meRes = await request(app).get('/api/user/me').set('Authorization', `Bearer ${diner.token}`);
  expect(meRes.status).toBe(200);
  expect(meRes.body).toMatchObject({ id: diner.user.id, name: diner.user.name, email: diner.user.email, roles: [{ role: 'diner' }] });
});

test('get me unauthorized', async () => {
  const meRes = await request(app).get('/api/user/me');
  expect(meRes.status).toBe(401);
});

test('update own user', async () => {
  const { user, token } = await registerUser();
  const updated = { name: 'updated diner', email: randomName() + '@test.com', password: 'c' };
  const updateRes = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${token}`).send(updated);
  expect(updateRes.status).toBe(200);
  expect(updateRes.body.token).toMatch(tokenPattern);
  expect(updateRes.body.user).toMatchObject({ id: user.id, name: updated.name, email: updated.email });

  const loginRes = await request(app).put('/api/auth').send({ email: updated.email, password: updated.password });
  expect(loginRes.status).toBe(200);
});

test('update other user forbidden', async () => {
  const updateRes = await request(app).put(`/api/user/${admin.user.id}`).set('Authorization', `Bearer ${diner.token}`).send({ name: 'hacker' });
  expect(updateRes.status).toBe(403);
});

test('update other user as admin', async () => {
  const { user } = await registerUser();
  const updated = { name: 'admin renamed', email: randomName() + '@test.com', password: 'd' };
  const updateRes = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${admin.token}`).send(updated);
  expect(updateRes.status).toBe(200);
  expect(updateRes.body.user).toMatchObject({ id: user.id, name: updated.name, email: updated.email });
});

test('delete user as non-admin forbidden', async () => {
  const { user, token } = await registerUser();
  const selfDeleteRes = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${token}`);
  expect(selfDeleteRes.status).toBe(403);

  const otherDeleteRes = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${diner.token}`);
  expect(otherDeleteRes.status).toBe(403);

  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(loginRes.status).toBe(200);
});

test('delete user as admin', async () => {
  const { user } = await registerUser();
  const deleteRes = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${admin.token}`);
  expect(deleteRes.status).toBe(200);

  const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(loginRes.status).toBe(404);
});

test('list users unauthorized', async () => {
  const listUsersRes = await request(app).get('/api/user');
  expect(listUsersRes.status).toBe(401);
});

test('list users as non-admin forbidden', async () => {
  const listUsersRes = await request(app).get('/api/user').set('Authorization', `Bearer ${diner.token}`);
  expect(listUsersRes.status).toBe(403);
});

test('list users', async () => {
  const listUsersRes = await request(app).get('/api/user').set('Authorization', `Bearer ${admin.token}`);
  expect(listUsersRes.status).toBe(200);
  expect(Array.isArray(listUsersRes.body.users)).toBe(true);
  expect(typeof listUsersRes.body.more).toBe('boolean');
  for (const user of listUsersRes.body.users) {
    expect(user).toHaveProperty('id');
    expect(user).toHaveProperty('name');
    expect(user).toHaveProperty('email');
    expect(Array.isArray(user.roles)).toBe(true);
    expect(user).not.toHaveProperty('password');
  }
});

test('list users filtered by name', async () => {
  const name = randomName();
  const user = { name, email: randomName() + '@test.com', password: 'a' };
  const registerRes = await request(app).post('/api/auth').send(user);
  expect(registerRes.status).toBe(200);

  const listUsersRes = await request(app).get(`/api/user?name=${name}`).set('Authorization', `Bearer ${admin.token}`);
  expect(listUsersRes.status).toBe(200);
  expect(listUsersRes.body.users).toEqual([{ id: registerRes.body.user.id, name, email: user.email, roles: [{ role: 'diner' }] }]);
  expect(listUsersRes.body.more).toBe(false);
});

test('list users paginated', async () => {
  const prefix = randomName();
  for (let i = 0; i < 3; i++) {
    await request(app).post('/api/auth').send({ name: `${prefix}${i}`, email: randomName() + '@test.com', password: 'a' });
  }

  const page0 = await request(app).get(`/api/user?page=0&limit=2&name=${prefix}*`).set('Authorization', `Bearer ${admin.token}`);
  expect(page0.status).toBe(200);
  expect(page0.body.users.map((u) => u.name)).toEqual([`${prefix}0`, `${prefix}1`]);
  expect(page0.body.more).toBe(true);

  const page1 = await request(app).get(`/api/user?page=1&limit=2&name=${prefix}*`).set('Authorization', `Bearer ${admin.token}`);
  expect(page1.status).toBe(200);
  expect(page1.body.users.map((u) => u.name)).toEqual([`${prefix}2`]);
  expect(page1.body.more).toBe(false);
});
``