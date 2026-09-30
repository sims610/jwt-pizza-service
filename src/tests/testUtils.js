const request = require('supertest');
const app = require('../service');
const { DB, Role } = require('../database/database.js');

const tokenPattern = /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/;

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

async function registerUser() {
  const user = { name: 'pizza diner', email: randomName() + '@test.com', password: 'a' };
  const res = await request(app).post('/api/auth').send(user);
  return { user: { ...user, id: res.body.user.id }, token: res.body.token };
}

async function createAdminUser() {
  const user = { name: randomName(), email: randomName() + '@admin.com', password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  const created = await DB.addUser(user);
  const res = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  return { user: { ...user, id: created.id }, token: res.body.token };
}

module.exports = { tokenPattern, randomName, registerUser, createAdminUser };
