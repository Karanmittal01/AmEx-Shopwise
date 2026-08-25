import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { registerSecret } from './log.js';

/**
 * Card details and portal credentials are encrypted at rest with AES-256-GCM,
 * using a key derived from a passphrase via scrypt. Never store the plaintext.
 *
 * For unattended (cron) runs the passphrase comes from one of, in order:
 *   1. $SHOPWISE_VAULT_PASS
 *   2. the file named by $SHOPWISE_VAULT_KEYFILE (default ./vault.key, mode 0600)
 *   3. an interactive prompt
 *
 * A keyfile sitting next to the vault is only a modest improvement over plaintext
 * against someone who already has your filesystem; it is a real improvement against
 * backups, screen-sharing, shell history and accidental `git add`.
 */

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 512 * 1024 * 1024,
  });
}

export function encryptVault(data, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = {
    v: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  };
  return JSON.stringify(payload, null, 2);
}

export function decryptVault(serialized, passphrase) {
  const payload = JSON.parse(serialized);
  const key = deriveKey(passphrase, Buffer.from(payload.salt, 'base64'));
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

export function saveVault(data, passphrase) {
  fs.writeFileSync(config.vaultFile, encryptVault(data, passphrase), { mode: 0o600 });
  fs.chmodSync(config.vaultFile, 0o600);
}

export function vaultExists() {
  return fs.existsSync(config.vaultFile);
}

function passphraseFromEnvOrKeyfile() {
  if (process.env.SHOPWISE_VAULT_PASS) return process.env.SHOPWISE_VAULT_PASS;
  const keyfile = process.env.SHOPWISE_VAULT_KEYFILE || path.join(ROOT, 'vault.key');
  if (fs.existsSync(keyfile)) {
    const stat = fs.statSync(keyfile);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `Keyfile ${keyfile} is readable by other users. Run: chmod 600 ${keyfile}`,
      );
    }
    return fs.readFileSync(keyfile, 'utf8').trim();
  }
  return null;
}

/**
 * @param {() => Promise<string>} [interactivePrompt] used when no env/keyfile passphrase exists
 */
export async function loadVault(interactivePrompt) {
  if (!vaultExists()) {
    throw new Error('No vault found. Run `node src/index.js setup` first.');
  }
  let passphrase = passphraseFromEnvOrKeyfile();
  if (!passphrase) {
    if (!interactivePrompt) {
      throw new Error(
        'No vault passphrase available. Set SHOPWISE_VAULT_PASS or create vault.key (chmod 600).',
      );
    }
    passphrase = await interactivePrompt();
  }

  let data;
  try {
    data = decryptVault(fs.readFileSync(config.vaultFile, 'utf8'), passphrase);
  } catch {
    throw new Error('Could not decrypt vault — wrong passphrase or the file is corrupt.');
  }

  for (const key of ['portalPassword', 'cardNumber', 'cardCvv']) {
    if (data[key]) registerSecret(data[key]);
  }
  return data;
}
