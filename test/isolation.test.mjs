import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer, sideMessages } from '../src/context.mjs';
import { SideChatStore } from '../src/client/store.mjs';
import { install, apply, inject } from '../src/index.mjs';
import { Context } from '@deepseek-ai/cordis';
import { acquireShared } from '../src/shared.mjs';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

test('snapshot closes pending tools without editing the source or losing completed results', () => {
  const source = [
    { role: 'system', content: [{ type: 'text', text: 'Main instructions' }] },
    { role: 'developer', id: 'update-1', content: [{ type: 'tool-addition', toolName: 'read' }] },
    { role: 'assistant', content: [
      { type: 'tool-call', id: 'a', name: 'read', arguments: {} },
      { type: 'tool-call', id: 'b', name: 'run', arguments: {} },
    ] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'Actual result' }] },
  ];
  const original = structuredClone(source);
  const projected = sideMessages(source, 'Why?', [{ question: 'Earlier?', answer: 'Earlier answer' }]);
  assert.deepEqual(source, original);
  assert.deepEqual(projected.slice(0, source.length), original);
  source.forEach((message, index) => assert.equal(projected[index], message));
  assert.equal(projected.filter(message => message.role === 'tool').length, 2);
  assert.equal(projected.find(message => message.toolCallId === 'a').content[0].text, 'Actual result');
  assert.match(projected.find(message => message.toolCallId === 'b').content[0].text, /not evidence/);
  assert.equal(projected.at(-1).content[0].text, 'Why?');
  assert.ok(projected.some(message => message.content.some(block => block.text === 'Earlier answer')));
  const replay = projected.find(message => message.content.some(block => block.text === 'Earlier answer'));
  assert.equal(replay.source.kind, 'model');
  assert.ok(replay.id);
  assert.throws(() => sideMessages(source, '', []));
});

test('side stream retains cache configuration but never executes tool calls', async () => {
  const signal = new AbortController().signal, events = [];
  const snapshot = {
    config: { provider: 'fixture', model: 'fixture', temperature: 0.5, maxTokens: 4096 },
    sessionId: 'main', tools: [{ name: 'read', description: 'read', parameters: {} }],
    toolHistory: { tools: [], updates: [] },
  };
  const llm = { async *stream(options) {
    assert.equal(options.tools, snapshot.tools);
    assert.equal(options.sessionId, snapshot.sessionId);
    assert.equal(options.toolHistory, snapshot.toolHistory);
    for (const [key, value] of Object.entries(snapshot.config)) assert.equal(options[key], value);
    yield { type: 'text-delta', text: 'Answer' };
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 2, cacheReadTokens: 4000 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  await answer(llm, snapshot, [], signal, event => events.push(event));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.find(event => event.type === 'usage').usage.cacheReadTokens, 4000);
  await assert.rejects(answer({ async *stream() { yield { type: 'text-delta', text: 'Partial' }; } }, {}, [], signal, () => {}), /提前结束/);
  await assert.rejects(answer({ async *stream() { yield { type: 'finish', reason: { kind: 'tool-calls' } }; } }, {}, [], signal, () => {}), /没有执行/);
});

test('closing a side window preserves its stream; cancellation stays within that conversation', async () => {
  const streams = new Map(), payloads = [];
  const store = new SideChatStore(async (_url, options) => {
    const data = JSON.parse(options.body); payloads.push(data);
    return new Response(new ReadableStream({
      start(controller) {
        streams.set(data.sessionId, controller);
        options.signal.addEventListener('abort', () => controller.error(Error('aborted')), { once: true });
      },
    }));
  });
  const send = (id, event) => streams.get(id).enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
  await store.ask('a', 'Question A');
  store.open('a'); store.close();
  send('a', { type: 'text', text: 'Partial A' });
  await store.ask('b', 'Question B');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get('a').entries[0].answer, 'Partial A');
  store.stop('a');
  send('b', { type: 'text', text: 'Complete B' });
  send('b', { type: 'done' });
  streams.get('b').close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get('a').entries[0].status, 'stopped');
  assert.equal(store.get('b').entries[0].status, 'done');
  assert.equal(store.isBusy('b'), false);
  assert.deepEqual(payloads[1].history, []);
  store.dispose();
});

test('unload cancels an unfinished request body before any snapshot or model request', async () => {
  const disposers = [];
  let handler, touched = 0;
  install({
    effect: factory => disposers.push(factory()),
    webServer: { register: route => { handler = route.handler; return () => {}; } },
    connection: { requestRejection: () => undefined },
    sessions: { get: () => { touched++; throw Error('must not read a session'); } },
    llm: { stream: () => { touched++; throw Error('must not call a model'); } },
  });
  const req = new PassThrough();
  req.method = 'POST';
  const res = new EventEmitter();
  Object.assign(res, { headersSent: false, writableEnded: false,
    writeHead() { this.headersSent = true; }, end() { this.writableEnded = true; } });
  const pending = handler(req, res);
  req.write('{"sessionId":');
  for (const dispose of disposers.reverse()) dispose?.();
  await pending;
  assert.equal(touched, 0);
  assert.equal(req.destroyed, true);
});


test('embedded and independent owners share one route and stop only after both unload', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  let registrations = 0, releases = 0;
  for (const service of inject) ctx.reflect.provide(service,
    service === 'webServer' ? { register() { registrations++; return () => { releases++; }; } } : {});
  const embedded = ctx.plugin({ name: 'embedded-btw', inject, apply });
  await embedded;
  const standalone = ctx.plugin({ name: 'standalone-btw', inject, apply });
  await standalone;
  assert.equal(registrations, 1);
  await embedded.dispose();
  assert.equal(releases, 0);
  await standalone.dispose();
  assert.equal(releases, 1);
  const remount = ctx.plugin({ name: 'embedded-btw', inject, apply });
  await remount;
  assert.equal(registrations, 2);
  await remount.dispose();
  assert.equal(releases, 2);
});

test('client owners preserve one input trigger and panel until the last owner unloads', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  let mounts = 0, active = 0;
  const component = { apply(scope) { mounts++; scope.effect(() => { active++; return () => active--; }); } };
  const plugin = name => ({ name, apply: scope => acquireShared(scope, 'client', component) });
  const standalone = ctx.plugin(plugin('standalone-client')); await standalone;
  const embedded = ctx.plugin(plugin('embedded-client')); await embedded;
  assert.equal(mounts, 1); assert.equal(active, 1);
  await standalone.dispose(); assert.equal(active, 1);
  await embedded.dispose(); assert.equal(active, 0);
});
