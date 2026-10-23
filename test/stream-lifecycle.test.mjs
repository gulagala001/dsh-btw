import test from 'node:test';
import assert from 'node:assert/strict';
import { answer } from '../src/context.mjs';
import { SideChatStore } from '../src/client/store.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, LlmAdapter, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import * as btw from '../src/index.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const encode = events => new TextEncoder().encode(events.map(event => JSON.stringify(event) + '\n').join(''));
function streamFixture() {
  let writer, cancelled = 0;
  const body = new ReadableStream({
    start(value) { writer = value; },
    cancel() { cancelled++; },
  });
  return { body, send: (...events) => writer.enqueue(encode(events)),
    close: () => writer.close(), get cancelled() { return cancelled; } };
}

test('done releases the request without waiting for HTTP EOF and preserves exactly one history exchange', async t => {
  const streams = [], payloads = [];
  const store = new SideChatStore(async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    const stream = streamFixture(); streams.push(stream);
    return new Response(stream.body);
  });
  t.after(() => store.dispose());
  await store.ask('a', 'First');
  streams[0].send({ type: 'text', text: 'Complete' }, { type: 'done' });
  await tick();
  assert.equal(store.get('a').entries[0].status, 'done');
  assert.equal(store.isBusy('a'), false, 'logical completion must release the composer');
  assert.equal(streams[0].cancelled, 1, 'the completed response body must be released');
  await store.ask('a', 'Second');
  assert.deepEqual(payloads[1].history.map(({ question, answer }) => ({ question, answer })), [{ question: 'First', answer: 'Complete' }]);
  streams[1].send({ type: 'text', text: 'Second answer' }, { type: 'done' });
  await tick();
});

test('stop cancels a blocked response reader without relying on fetch to forward abort', async t => {
  const stream = streamFixture();
  const store = new SideChatStore(async () => new Response(stream.body));
  t.after(() => store.dispose());
  await store.ask('a', 'Question');
  stream.send({ type: 'text', text: 'Partial' }); await tick();
  store.stop('a'); await tick();
  assert.equal(store.isBusy('a'), false);
  assert.equal(stream.cancelled, 1);
  assert.equal(store.get('a').entries[0].status, 'stopped');
  assert.equal(store.get('a').entries[0].answer, 'Partial');
});

test('unload clears memory and rejects a late admission without resurrecting its history', async () => {
  let admit;
  const stream = streamFixture();
  const store = new SideChatStore(() => new Promise(resolve => { admit = resolve; }));
  const pending = store.ask('a', 'Question');
  store.dispose();
  admit(new Response(stream.body));
  await assert.rejects(pending, /停用|abort/i);
  await tick();
  assert.equal(stream.cancelled, 1);
  assert.equal(store.states.size, 0);
  assert.equal(store.running.size, 0);
  store.update('a', { draft: 'late form update' });
  store.get('a');
  assert.equal(store.states.size, 0);
});

test('stop during admission rejects the late response and keeps the question available', async t => {
  let admit;
  const stream = streamFixture();
  const store = new SideChatStore(() => new Promise(resolve => { admit = resolve; }));
  t.after(() => store.dispose());
  const pending = store.ask('a', 'Question');
  store.stop('a');
  admit(new Response(stream.body));
  await assert.rejects(pending, /停止/);
  assert.equal(stream.cancelled, 1);
  assert.equal(store.get('a').entries[0].status, 'stopped');
  assert.equal(store.get('a').entries[0].question, 'Question');
});

test('an error or premature EOF retains partial text and never enters follow-up history', async t => {
  for (const terminal of ['error', 'eof']) {
    const streams = [], payloads = [];
    const store = new SideChatStore(async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      const stream = streamFixture(); streams.push(stream); return new Response(stream.body);
    });
    t.after(() => store.dispose());
    await store.ask('a', 'Question');
    streams[0].send({ type: 'text', text: 'Partial' });
    if (terminal === 'error') streams[0].send({ type: 'error', error: 'Provider failed' });
    else streams[0].close();
    await tick();
    const entry = store.get('a').entries[0];
    assert.equal(entry.status, 'error'); assert.equal(entry.answer, 'Partial');
    assert.match(entry.error, terminal === 'error' ? /Provider failed/ : /提前结束/);
    assert.equal(store.isBusy('a'), false);
    await store.ask('a', 'Try again');
    assert.deepEqual(payloads[1].history, []);
    streams[1].send({ type: 'text', text: 'Complete' }, { type: 'done' }); await tick();
  }
});

test('a terminal reply is not rewritten by trailing transport data', async t => {
  const stream = streamFixture();
  const store = new SideChatStore(async () => new Response(stream.body));
  t.after(() => store.dispose());
  await store.ask('a', 'Question');
  stream.send({ type: 'text', text: 'Complete' }, { type: 'done' }, { type: 'error', error: 'Late failure' });
  stream.close(); await tick();
  assert.equal(store.get('a').entries[0].status, 'done');
  assert.equal(store.get('a').entries[0].error, '');
});

test('reasoning progress is one notification while text and usage stay intact', async () => {
  const events = [], signal = new AbortController().signal;
  const llm = { async *stream() {
    for (let i = 0; i < 10000; i++) yield { type: 'reasoning-delta', text: 'reasoning' };
    yield { type: 'text-delta', text: 'Answer' };
    yield { type: 'reasoning-delta', text: 'late reasoning' };
    yield { type: 'usage', usage: { outputTokens: 10001 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  await answer(llm, { config: {} }, [], signal, event => events.push(event));
  assert.equal(events.length, 4);
  assert.deepEqual(events, [
    { type: 'thinking' }, { type: 'text', text: 'Answer' },
    { type: 'usage', usage: { outputTokens: 10001 } }, { type: 'done', truncated: false },
  ]);
});

test('already cancelled side requests do not dispatch a model call', async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort(Error('Stopped'));
  await assert.rejects(answer({ async *stream() { calls++; } }, {}, [], controller.signal, () => {}), /Stopped/);
  assert.equal(calls, 0);
});

test('model iterator cleanup must succeed before the server emits done', async () => {
  const events = [];
  const llm = { async *stream() {
    yield { type: 'text-delta', text: 'Partial' };
    yield { type: 'finish', reason: { kind: 'stop' } };
    throw Error('Cleanup failed');
  } };
  await assert.rejects(answer(llm, { config: {} }, [], new AbortController().signal, event => events.push(event)), /Cleanup failed/);
  assert.deepEqual(events, [{ type: 'text', text: 'Partial' }]);
});

test('native runtime over HTTP completes before EOF, cancels only side calls and survives owner handoff', { timeout: 10000 }, async t => {
  const ctx = new Context(), session = Session.create('parent');
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Main task' }] }), { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'fixture' } }, reason: 'initial' });
  const original = structuredClone(session.snapshotEvents()), prefix = session.deriveMessages();
  let route, held = 0, mainLoopCalls = 0, started = 0, stopped = 0;
  const server = createServer((req, res) => {
    // Model a proxy that delivers the complete body but delays transport EOF.
    const end = res.end.bind(res);
    res.end = chunk => { if (chunk) res.write(chunk); held++; return res; };
    res.on('close', () => end());
    void route.handler(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = new SideChatStore((url, options) => fetch(base + url, options));
  t.after(async () => { store.dispose(); await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await ctx.plugin(LlmRuntime);
  class Adapter extends LlmAdapter {
    async *stream(options) {
      started++;
      assert.deepEqual(options.messages.slice(0, prefix.length), prefix);
      assert.equal(options.sessionId, 'parent');
      const question = options.messages.at(-1).content[0].text;
      try {
        yield { type: 'text-delta', text: question === 'Wait' ? 'Partial' : 'Complete' };
        if (question === 'Wait') {
          await new Promise(resolve => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener('abort', resolve, { once: true });
          });
          options.signal.throwIfAborted();
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally { stopped++; }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  ctx.on('llm/stream', (options, next) => { if (isAgentLoopRequest(options)) mainLoopCalls++; return next(); }, { global: true });
  ctx.reflect.provide('sessions', { get: id => id === 'parent' ? session : undefined });
  ctx.reflect.provide('sessionController', {});
  ctx.reflect.provide('connection', { requestRejection: () => undefined });
  ctx.reflect.provide('webServer', { register(value) { assert.equal(route, undefined); route = value; return () => { route = undefined; }; } });
  const embedded = ctx.plugin({ name: 'embedded', inject: btw.inject, apply: btw.apply }); await embedded;
  const standalone = ctx.plugin({ name: 'standalone', inject: btw.inject, apply: btw.apply }); await standalone;
  const waitFor = async accepts => {
    const deadline = Date.now() + 2000;
    while (!accepts()) { assert.ok(Date.now() < deadline, 'request did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  await store.ask('parent', 'Complete');
  await waitFor(() => !store.isBusy('parent'));
  assert.equal(store.get('parent').entries.at(-1).status, 'done');
  assert.equal(held, 1);
  await store.ask('parent', 'Wait');
  await waitFor(() => store.get('parent').entries.at(-1).answer === 'Partial');
  await embedded.dispose();
  assert.equal(stopped, 1, 'the remaining owner must keep the active call');
  store.stop('parent');
  await waitFor(() => !store.isBusy('parent') && stopped === 2);
  assert.equal(store.get('parent').entries.at(-1).status, 'stopped');
  await store.ask('parent', 'Wait');
  await waitFor(() => store.get('parent').entries.at(-1).answer === 'Partial');
  await standalone.dispose();
  await waitFor(() => !store.isBusy('parent') && stopped === 3);
  assert.equal(store.get('parent').entries.at(-1).status, 'error');
  assert.match(store.get('parent').entries.at(-1).error, /停用/);
  assert.equal(route, undefined);
  const remount = ctx.plugin({ name: 'remounted', inject: btw.inject, apply: btw.apply }); await remount;
  await store.ask('parent', 'Complete');
  await waitFor(() => !store.isBusy('parent'));
  assert.equal(store.get('parent').entries.at(-1).status, 'done');
  assert.equal(started, 4); assert.equal(stopped, 4); assert.equal(mainLoopCalls, 0);
  assert.deepEqual(session.snapshotEvents(), original);
});
