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

test('delete user', async () => {
  const deleteRes = await request(app).delete(`/api/user/${diner.user.id}`).set('Authorization', `Bearer ${diner.token}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body.message).toBe('not implemented');
});

test('list users', async () => {
  const listRes = await request(app).get('/api/user').set('Authorization', `Bearer ${admin.token}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body).toMatchObject({ message: 'not implemented', users: [], more: false });
});

test('list users unauthorized', async () => {
  const listRes = await request(app).get('/api/user');
  expect(listRes.status).toBe(401);
});
