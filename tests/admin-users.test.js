import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
const usersCode = html.slice(html.indexOf('let USERS = {}'), html.indexOf('let bonusTarget = null'));
const toggleCode = html.slice(html.indexOf('async function toggleUser('), html.indexOf('async function deleteUser('));

function makeList(data) {
  const nodes = { usersOut: { innerHTML: '' }, usersMeta: { textContent: '' }, userQuery: { value: '' } };
  const calls = [], messages = [];
  const context = vm.createContext({
    $: selector => nodes[selector.slice(1)],
    rememberRaw: () => {}, esc: value => String(value ?? ''), fmt: value => value || '—',
    askConfirm: async () => true, toast: message => messages.push(message),
    api: async (path, options) => {
      calls.push({ path, options });
      if (path.startsWith('/api/admin/users?')) return data;
      return { ok: true };
    },
  });
  vm.runInContext(usersCode + '\n' + toggleCode, context);
  return { context, nodes, calls, messages };
}

function getRow(markup, id) {
  const rows = markup.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  return rows.find(row => row.includes(`<div class="mono">${id}</div>`)) || '';
}

const accounts = [
  { id: 'usr_admin_a', email: 'a@example.test', role: 'admin', disabled: 0 },
  { id: 'usr_admin_b', email: 'b@example.test', role: 'admin', disabled: 0 },
  { id: 'usr_off', email: 'off@example.test', role: 'user', disabled: 1 },
];

test('the current administrator is marked and cannot click their own disable action', async () => {
  const data = { total: 3, current_user_id: 'usr_admin_a', items: accounts };
  const list = makeList(data);
  await list.context.loadUsers();
  const own = getRow(list.nodes.usersOut.innerHTML, 'usr_admin_a');
  const otherAdmin = getRow(list.nodes.usersOut.innerHTML, 'usr_admin_b');
  const disabledUser = getRow(list.nodes.usersOut.innerHTML, 'usr_off');
  assert.match(own, /当前账号/);
  assert.match(own, /<button class="rowbtn" disabled title="不能停用当前登录的管理员账号">停用（当前账号）<\/button>/);
  assert.doesNotMatch(own, /onclick="toggleUser\(/);
  assert.doesNotMatch(otherAdmin, /当前账号/);
  assert.match(otherAdmin, /onclick="toggleUser\('usr_admin_b',1\)">停用/);
  assert.match(disabledUser, /onclick="toggleUser\('usr_off',0\)">启用/);
});

test('the protected row follows the authenticated identity returned with each user list', () => {
  const list = makeList();
  list.context.renderUsers({ total: 3, current_user_id: 'usr_admin_a', items: accounts });
  assert.match(getRow(list.nodes.usersOut.innerHTML, 'usr_admin_a'), /disabled title=/);
  list.context.renderUsers({ total: 3, current_user_id: 'usr_admin_b', items: accounts });
  assert.match(getRow(list.nodes.usersOut.innerHTML, 'usr_admin_a'), /onclick="toggleUser\('usr_admin_a',1\)">停用/);
  assert.match(getRow(list.nodes.usersOut.innerHTML, 'usr_admin_b'), /disabled title=/);
  list.context.renderUsers({ total: 1, current_user_id: 'usr_admin_b', items: [accounts[2]] });
  assert.match(getRow(list.nodes.usersOut.innerHTML, 'usr_off'), /onclick="toggleUser\('usr_off',0\)">启用/);
});

test('the user management controls still send disable and enable requests for other accounts', async () => {
  const data = { total: 3, current_user_id: 'usr_admin_a', items: accounts };
  const list = makeList(data);
  await list.context.loadUsers();
  await list.context.toggleUser('usr_admin_b', 1);
  await list.context.toggleUser('usr_off', 0);
  const actions = list.calls.filter(call => call.path.endsWith('/status'));
  assert.deepEqual(actions.map(call => [call.path, JSON.parse(call.options.body).disabled]), [
    ['/api/admin/users/usr_admin_b/status', true], ['/api/admin/users/usr_off/status', false],
  ]);
  assert.deepEqual(list.messages, ['账号已停用', '账号已启用']);
});
