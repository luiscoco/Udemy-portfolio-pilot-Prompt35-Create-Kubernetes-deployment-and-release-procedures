#!/usr/bin/env node
// Computes a PostgreSQL SCRAM-SHA-256 password verifier (RFC 5802/7677, as stored in pg_authid),
// so `CREATE/ALTER ROLE ... PASSWORD '<verifier>'` never sends the plaintext password to the
// server or its logs. CLI: reads the password from stdin, prints the verifier.
//   printf '%s' "$PASSWORD" | node infra/azure/scripts/scram-verifier.mjs
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function scramVerifier(password, { iterations = 4096, salt = randomBytes(16) } = {}) {
  if (typeof password !== 'string' || password.length < 16) throw new Error('Password must be at least 16 characters');
  // PostgreSQL applies SASLprep; restricting to printable ASCII makes SASLprep the identity.
  if (!/^[\x21-\x7e]+$/.test(password)) throw new Error('Use printable ASCII without spaces (e.g. openssl rand -base64 32)');
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(`${scramVerifier(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, ''))}\n`);
}
