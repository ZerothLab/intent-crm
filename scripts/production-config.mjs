import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function productionConfigurationErrors(env, databaseOnly = false) {
  const errors = [];
  try {
    const value = env.DATABASE_URL;
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2 || url.hash || value !== value.trim() || value.includes('REPLACE_WITH_')) throw new Error();
  } catch {
    errors.push('DATABASE_URL must identify a PostgreSQL host and database with configured credentials.');
  }
  if (databaseOnly) return errors;
  try {
    const value = env.INTENT_PUBLIC_ORIGIN;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error();
  } catch {
    errors.push('INTENT_PUBLIC_ORIGIN must be an exact HTTPS origin without a path or trailing slash.');
  }
  const address = env.TEMPORAL_ADDRESS ?? '';
  try {
    const endpoint = /^(\[[a-f\d:.]+\]|[^:/@\s?#]+):([1-9]\d{0,4})$/i.exec(address);
    if (!endpoint || Number(endpoint[2]) > 65535) throw new Error();
    new URL(`http://${address}`);
  } catch {
    errors.push('TEMPORAL_ADDRESS must explicitly identify the production Temporal host and port.');
  }
  if (env.TEMPORAL_NAMESPACE !== undefined && !env.TEMPORAL_NAMESPACE.trim()) {
    errors.push('TEMPORAL_NAMESPACE must not be blank; omit it to use default.');
  }
  const key = env.INTENT_ENCRYPTION_KEY;
  if (key && (Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key)) {
    errors.push('INTENT_ENCRYPTION_KEY must be the canonical Base64 encoding of 32 random bytes.');
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = productionConfigurationErrors(process.env, process.argv[2] === 'database');
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.info('Production configuration syntax is valid. Connectivity and integration availability require separate checks.');
}
