import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
const escCode = html.slice(html.indexOf('const esc ='), html.indexOf('function toast('));
const renderCode = html.slice(html.indexOf('function renderAgentTokens()'), html.indexOf('async function loadAgentTokens('));
const promptCode = html.slice(html.indexOf('function agentMarkdown()'), html.indexOf('async function copyAgentPrompt('));

test('Agent names are escaped before insertion and only active credentials can be revoked', () => {
  const output = { innerHTML: '' };
  const context = vm.createContext({ $: () => output, fmt: () => 'time', Date });
  vm.runInContext(`${escCode}\nlet agentTokens = ${JSON.stringify([
    { id: 'agt_active', label: '<img src=x onerror=alert(1)>', issued_by: 'a@example.test', created_at: 1, expires_at: 9999999999, revoked_at: null },
    { id: 'agt_revoked', label: 'old', issued_by: 'a@example.test', created_at: 1, expires_at: 9999999999, revoked_at: 1 },
  ])};\n${renderCode}\nrenderAgentTokens();`, context);
  assert.ok(output.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!output.innerHTML.includes('<img src=x'));
  assert.match(output.innerHTML, /data-agent-revoke="agt_active"/);
  assert.ok(!output.innerHTML.includes('data-agent-revoke="agt_revoked"'));
});

test('generic Agent instructions contain pairing steps but no generated code or secret', () => {
  const context = vm.createContext({ location: { origin: 'https://shop.example' } });
  vm.runInContext(promptCode, context);
  const prompt = context.agentMarkdown();
  assert.match(prompt, /https:\/\/shop\.example/);
  assert.match(prompt, /POST \/api\/agent\/pair/);
  assert.match(prompt, /5 分钟/);
  assert.match(prompt, /30 天/);
  assert.match(prompt, /<管理员给的10位配对码>/);
  assert.ok(!/\b\d{10}\b/.test(prompt));
  assert.ok(!/agt_[A-Za-z0-9_-]{43}/.test(prompt));
});
