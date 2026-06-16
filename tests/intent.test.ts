import test from 'node:test';
import assert from 'node:assert/strict';

import { quickIntentOverride } from '../src/services/intent.js';

test('quickIntentOverride classifies report requests before anything else', () => {
  const result = quickIntentOverride('Please show report and send PDF for my tasks');

  assert.deepEqual(result, {
    intent: 'report',
    confidence: 1,
    target_date: undefined,
    target_time: undefined,
    date_ranges: [],
  });
});

test('quickIntentOverride catches task query phrases', () => {
  const result = quickIntentOverride('What do I have tomorrow?');

  assert.equal(result?.intent, 'query');
  assert.equal(result?.confidence, 1);
});

test('quickIntentOverride catches delete phrases', () => {
  const result = quickIntentOverride('удали встречу с врачом');

  assert.equal(result?.intent, 'delete');
});

test('quickIntentOverride catches reschedule phrases', () => {
  const result = quickIntentOverride('перенеси звонок на 15:30');

  assert.equal(result?.intent, 'reschedule');
});

test('quickIntentOverride returns null for plain new-task text', () => {
  const result = quickIntentOverride('Tomorrow I need to finish the landing page');

  assert.equal(result, null);
});
