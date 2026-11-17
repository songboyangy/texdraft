import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { decryptSecret, encryptSecret } from './crypto.js';

test('API keys round-trip through AES-256-GCM and never appear in the ciphertext', () => {
  const key = 'sk-test-' + crypto.randomBytes(16).toString('hex');
  const enc = encryptSecret(key);
  assert.ok(enc.startsWith('v1:'));
  assert.ok(!enc.includes(key));
  assert.notEqual(encryptSecret(key), enc, 'random IV per encryption');
  assert.equal(decryptSecret(enc), key);
});

test('tampered or foreign ciphertext is rejected', () => {
  const enc = encryptSecret('secret-value');
  const [v, iv, tag, data] = enc.split(':');
  const flipped = Buffer.from(data, 'base64url');
  flipped[0] ^= 1;
  assert.equal(decryptSecret([v, iv, tag, flipped.toString('base64url')].join(':')), null);
  assert.equal(decryptSecret('v1:bad:data:here'), null);
  assert.equal(decryptSecret('plain-text-key'), null);
});
