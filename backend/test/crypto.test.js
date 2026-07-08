import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CREDENTIAL_ENCRYPTION_KEY ||= '0'.repeat(64);

const { encryptSecret, decryptSecret } = await import('../src/crypto.js');

test('encrypt/decrypt roundtrip', () => {
  const plaintext = 'sup3r-s3cret-password!';
  const encrypted = encryptSecret(plaintext);
  assert.notEqual(encrypted, plaintext);
  assert.equal(decryptSecret(encrypted), plaintext);
});

test('tampered ciphertext fails to decrypt', () => {
  const encrypted = encryptSecret('hello');
  const buf = Buffer.from(encrypted, 'base64');
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => decryptSecret(buf.toString('base64')));
});
