const request = require('supertest');
const app = require('../service');
const { randomName, registerUser, createAdminUser } = require('./testUtils');

let diner;
let admin;
let menuItem;

beforeAll(async () => {
  diner = await registerUser();
  admin = await createAdminUser();

  const newItem = { title: randomName(), description: 'test pizza', image: 'pizza1.png', price: 0.0042 };
  const menuRes = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${admin.token}`).send(newItem);
  menuItem = menuRes.body.find((item) => item.title === newItem.title);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('get menu', async () => {
  const menuRes = await request(app).get('/api/order/menu');
  expect(menuRes.status).toBe(200);
  expect(Array.isArray(menuRes.body)).toBe(true);
  expect(menuRes.body).toContainEqual(menuItem);
});

test('add menu item as admin', async () => {
  const newItem = { title: randomName(), description: 'another test pizza', image: 'pizza2.png', price: 0.001 };
  const addRes = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${admin.token}`).send(newItem);
  expect(addRes.status).toBe(200);
  expect(addRes.body).toContainEqual(expect.objectContaining(newItem));
});

test('add menu item as diner forbidden', async () => {
  const addRes = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${diner.token}`).send({ title: 'nope', description: 'x', image: 'x.png', price: 1 });
  expect(addRes.status).toBe(403);
});

test('add menu item unauthorized', async () => {
  const addRes = await request(app).put('/api/order/menu').send({ title: 'nope', description: 'x', image: 'x.png', price: 1 });
  expect(addRes.status).toBe(401);
});

test('create order', async () => {
  const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ reportUrl: 'http://report', jwt: 'factory.jwt.token' }) });
  const orderReq = { franchiseId: 1, storeId: 1, items: [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }] };

  const orderRes = await request(app).post('/api/order').set('Authorization', `Bearer ${diner.token}`).send(orderReq);
  expect(orderRes.status).toBe(200);
  expect(orderRes.body.order).toMatchObject(orderReq);
  expect(orderRes.body.order.id).toBeDefined();
  expect(orderRes.body.jwt).toBe('factory.jwt.token');
  expect(orderRes.body.followLinkToEndChaos).toBe('http://report');
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test('create order factory failure', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, json: async () => ({ reportUrl: 'http://report' }) });
  const orderReq = { franchiseId: 1, storeId: 1, items: [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }] };

  const orderRes = await request(app).post('/api/order').set('Authorization', `Bearer ${diner.token}`).send(orderReq);
  expect(orderRes.status).toBe(500);
  expect(orderRes.body.message).toBe('Failed to fulfill order at factory');
});

test('create order unauthorized', async () => {
  const orderRes = await request(app).post('/api/order').send({ franchiseId: 1, storeId: 1, items: [] });
  expect(orderRes.status).toBe(401);
});

test('get orders', async () => {
  const { token, user } = await registerUser();
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ reportUrl: 'http://report', jwt: 'factory.jwt.token' }) });
  const orderReq = { franchiseId: 1, storeId: 1, items: [{ menuId: menuItem.id, description: menuItem.title, price: menuItem.price }] };
  await request(app).post('/api/order').set('Authorization', `Bearer ${token}`).send(orderReq);

  const ordersRes = await request(app).get('/api/order').set('Authorization', `Bearer ${token}`);
  expect(ordersRes.status).toBe(200);
  expect(ordersRes.body.dinerId).toBe(user.id);
  expect(ordersRes.body.orders).toHaveLength(1);
  expect(ordersRes.body.orders[0].items[0]).toMatchObject({ menuId: menuItem.id, description: menuItem.title, price: menuItem.price });
});

test('get orders unauthorized', async () => {
  const ordersRes = await request(app).get('/api/order');
  expect(ordersRes.status).toBe(401);
});
