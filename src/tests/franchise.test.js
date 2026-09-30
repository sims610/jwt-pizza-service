const request = require('supertest');
const app = require('../service');
const { randomName, registerUser, createAdminUser } = require('./testUtils');

let diner;
let admin;
let franchisee;

async function createFranchise() {
  const franchiseReq = { name: randomName(), admins: [{ email: franchisee.user.email }] };
  const res = await request(app).post('/api/franchise').set('Authorization', `Bearer ${admin.token}`).send(franchiseReq);
  return res.body;
}

async function createStore(franchiseId, token) {
  return request(app).post(`/api/franchise/${franchiseId}/store`).set('Authorization', `Bearer ${token}`).send({ name: randomName() });
}

beforeAll(async () => {
  diner = await registerUser();
  admin = await createAdminUser();
  franchisee = await registerUser();
});

test('list franchises', async () => {
  const franchise = await createFranchise();
  const listRes = await request(app).get(`/api/franchise?page=0&limit=10&name=${franchise.name}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body.more).toBe(false);
  expect(listRes.body.franchises).toEqual([{ id: franchise.id, name: franchise.name, stores: [] }]);
});

test('list franchises as admin', async () => {
  const franchise = await createFranchise();
  const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`).set('Authorization', `Bearer ${admin.token}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body.franchises[0]).toMatchObject({ id: franchise.id, name: franchise.name, admins: [{ id: franchisee.user.id, email: franchisee.user.email }] });
});

test('list user franchises', async () => {
  const franchise = await createFranchise();
  const listRes = await request(app).get(`/api/franchise/${franchisee.user.id}`).set('Authorization', `Bearer ${franchisee.token}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body).toContainEqual(expect.objectContaining({ id: franchise.id, name: franchise.name }));
});

test('list other user franchises returns empty', async () => {
  await createFranchise();
  const listRes = await request(app).get(`/api/franchise/${franchisee.user.id}`).set('Authorization', `Bearer ${diner.token}`);
  expect(listRes.status).toBe(200);
  expect(listRes.body).toEqual([]);
});

test('list user franchises unauthorized', async () => {
  const listRes = await request(app).get(`/api/franchise/${franchisee.user.id}`);
  expect(listRes.status).toBe(401);
});

test('create franchise', async () => {
  const franchiseReq = { name: randomName(), admins: [{ email: franchisee.user.email }] };
  const createRes = await request(app).post('/api/franchise').set('Authorization', `Bearer ${admin.token}`).send(franchiseReq);
  expect(createRes.status).toBe(200);
  expect(createRes.body).toMatchObject({ name: franchiseReq.name, admins: [{ email: franchisee.user.email, id: franchisee.user.id }] });
  expect(createRes.body.id).toBeDefined();
});

test('create franchise as diner forbidden', async () => {
  const createRes = await request(app).post('/api/franchise').set('Authorization', `Bearer ${diner.token}`).send({ name: randomName(), admins: [] });
  expect(createRes.status).toBe(403);
});

test('create franchise unknown admin', async () => {
  const createRes = await request(app).post('/api/franchise').set('Authorization', `Bearer ${admin.token}`).send({ name: randomName(), admins: [{ email: randomName() + '@nobody.com' }] });
  expect(createRes.status).toBe(404);
});

test('delete franchise', async () => {
  const franchise = await createFranchise();
  const deleteRes = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${admin.token}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body.message).toBe('franchise deleted');

  const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`);
  expect(listRes.body.franchises).toEqual([]);
});

test('delete franchise as non-admin forbidden', async () => {
  const franchise = await createFranchise();
  const dinerRes = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${diner.token}`);
  expect(dinerRes.status).toBe(403);
  const franchiseeRes = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${franchisee.token}`);
  expect(franchiseeRes.status).toBe(403);

  const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`);
  expect(listRes.body.franchises).toHaveLength(1);
});

test('delete franchise unauthorized', async () => {
  const franchise = await createFranchise();
  const deleteRes = await request(app).delete(`/api/franchise/${franchise.id}`);
  expect(deleteRes.status).toBe(401);

  const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`);
  expect(listRes.body.franchises).toHaveLength(1);
});

test('create store as franchisee', async () => {
  const franchise = await createFranchise();
  const storeRes = await createStore(franchise.id, franchisee.token);
  expect(storeRes.status).toBe(200);
  expect(storeRes.body).toMatchObject({ franchiseId: franchise.id });
  expect(storeRes.body.id).toBeDefined();
});

test('create store as admin', async () => {
  const franchise = await createFranchise();
  const storeRes = await createStore(franchise.id, admin.token);
  expect(storeRes.status).toBe(200);
});

test('create store as diner forbidden', async () => {
  const franchise = await createFranchise();
  const storeRes = await createStore(franchise.id, diner.token);
  expect(storeRes.status).toBe(403);
});

test('create store unauthorized', async () => {
  const franchise = await createFranchise();
  const storeRes = await request(app).post(`/api/franchise/${franchise.id}/store`).send({ name: 'SLC' });
  expect(storeRes.status).toBe(401);
});

test('delete store', async () => {
  const franchise = await createFranchise();
  const store = (await createStore(franchise.id, franchisee.token)).body;
  const deleteRes = await request(app).delete(`/api/franchise/${franchise.id}/store/${store.id}`).set('Authorization', `Bearer ${franchisee.token}`);
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body.message).toBe('store deleted');

  const listRes = await request(app).get(`/api/franchise?name=${franchise.name}`);
  expect(listRes.body.franchises[0].stores).toEqual([]);
});

test('delete store as diner forbidden', async () => {
  const franchise = await createFranchise();
  const store = (await createStore(franchise.id, franchisee.token)).body;
  const deleteRes = await request(app).delete(`/api/franchise/${franchise.id}/store/${store.id}`).set('Authorization', `Bearer ${diner.token}`);
  expect(deleteRes.status).toBe(403);
});
