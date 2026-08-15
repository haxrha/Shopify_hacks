import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from './intent.ts';

describe('parseIntent', () => {
  it('picks up an explicit order verb', () => {
    const intent = parseIntent('order pad thai');
    assert.equal(intent.kind, 'order');
    assert.equal(intent.kind === 'order' && intent.query, 'pad thai');
  });

  it('handles filler and quantities', () => {
    const intent = parseIntent('get me 2 burritos');
    assert.equal(intent.kind, 'order');
    assert.equal(intent.kind === 'order' && intent.quantity, 2);
    assert.equal(intent.kind === 'order' && intent.query, 'burritos');
  });

  it('clamps an implausible quantity rather than ordering 50 of something', () => {
    const intent = parseIntent('order 50 burritos');
    assert.equal(intent.kind === 'order' && intent.quantity, 1);
  });

  it('accepts a bare food item only when addressed to the bot', () => {
    assert.equal(parseIntent('sushi').kind, 'none');
    assert.equal(parseIntent('/sushi').kind, 'order');
    assert.equal(parseIntent('@chow sushi').kind, 'order');
  });

  it('stays quiet on ordinary group chatter', () => {
    for (const message of ['lol', 'what time are you free', 'that was so good', 'ok']) {
      assert.equal(parseIntent(message).kind, 'none', message);
    }
  });

  it('recognises the control commands', () => {
    assert.equal(parseIntent('split').kind, 'split');
    assert.equal(parseIntent('status').kind, 'status');
    assert.equal(parseIntent('help').kind, 'help');
    assert.equal(parseIntent('cancel').kind, 'cancel');
  });
});
