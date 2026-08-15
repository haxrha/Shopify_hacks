import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInbound, detectsStopIntent, matchesOptOutKeyword } from './optout.ts';

describe('matchesOptOutKeyword — mirrors Linq\'s server-side rule', () => {
  it('matches the exact keywords', () => {
    for (const keyword of ['STOP', 'UNSUBSCRIBE', 'OPTOUT', 'CANCEL', 'END', 'QUIT']) {
      assert.equal(matchesOptOutKeyword(keyword), true, keyword);
    }
  });

  it('is case-sensitive for everything except OPT OUT', () => {
    assert.equal(matchesOptOutKeyword('stop'), false);
    assert.equal(matchesOptOutKeyword('Stop'), false);
    assert.equal(matchesOptOutKeyword('cancel'), false);
    assert.equal(matchesOptOutKeyword('Quit'), false);
  });

  it('accepts OPT OUT in any casing, spaced or hyphenated', () => {
    for (const variant of ['OPT OUT', 'opt out', 'Opt-Out', 'opt-out', 'optout', 'OptOut']) {
      assert.equal(matchesOptOutKeyword(variant), true, variant);
    }
  });

  it('requires the keyword to be the whole message', () => {
    assert.equal(matchesOptOutKeyword('please stop'), false);
    assert.equal(matchesOptOutKeyword('STOP the order'), false);
    assert.equal(matchesOptOutKeyword('I want to CANCEL my food'), false);
  });

  it('tolerates surrounding whitespace', () => {
    assert.equal(matchesOptOutKeyword('  STOP  '), true);
    assert.equal(matchesOptOutKeyword('\nQUIT\n'), true);
  });

  it('ignores empty messages', () => {
    assert.equal(matchesOptOutKeyword(''), false);
    assert.equal(matchesOptOutKeyword('   '), false);
  });
});

describe('detectsStopIntent — the part Linq does not enforce', () => {
  it('catches conversational stop requests', () => {
    const phrases = [
      'stop texting me',
      'please stop',
      'stop messaging me please',
      "don't text me again",
      'do not contact me',
      'take me off this list',
      'remove me',
      'leave me alone',
      'no more messages',
      'I don\'t want any more of these',
    ];
    for (const phrase of phrases) {
      assert.equal(detectsStopIntent(phrase), true, phrase);
    }
  });

  it('does not fire on ordinary group chatter', () => {
    const phrases = [
      'order pad thai',
      'stop by the store on your way',
      'can you get me a burrito',
      'that place is terrible',
      'I want more fries',
      'cancel the extra sauce on mine',
    ];
    for (const phrase of phrases) {
      assert.equal(detectsStopIntent(phrase), false, phrase);
    }
  });
});

describe('classifyInbound', () => {
  it('reports keyword matches distinctly from intent matches', () => {
    const keyword = classifyInbound('STOP');
    assert.equal(keyword.optedOut, true);
    assert.equal(keyword.optedOut && keyword.kind, 'keyword');

    const intent = classifyInbound('please stop texting me');
    assert.equal(intent.optedOut, true);
    assert.equal(intent.optedOut && intent.kind, 'intent');
  });

  it('leaves an ordinary order request alone', () => {
    assert.equal(classifyInbound('order me a burrito').optedOut, false);
  });
});
