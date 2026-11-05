import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

import { CODE_ALPHABET, PROTOCOL } from "./constants.ts";

/** X25519 identity. `publicKey` and `privateKey` are base64url raw key material. */
export interface Identity {
  publicKey: string;
  privateKey: string;
}

export function createIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const priv = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return {
    publicKey: pub.subarray(-32).toString("base64url"),
    privateKey: priv.subarray(-32).toString("base64url"),
  };
}

export function makeCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

export function importPublic(publicKey: string): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: publicKey },
    format: "jwk",
  });
}

export function importPrivate(identity: Identity): KeyObject {
  return createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: identity.publicKey, d: identity.privateKey },
    format: "jwk",
  });
}

/**
 * Session key from the ephemeral handshake plus both static keys.
 * The two mixed secrets are ordered by static public key so the sender and
 * the listener derive the same bytes. `code` is empty for a saved pairing.
 */
export function deriveSessionKey(
  ours: Identity,
  ourEphemeral: Identity,
  theirStatic: string,
  theirEphemeral: string,
  code: string,
): Buffer {
  const ee = diffieHellman({
    privateKey: importPrivate(ourEphemeral),
    publicKey: importPublic(theirEphemeral),
  });
  const staticToEph = diffieHellman({
    privateKey: importPrivate(ours),
    publicKey: importPublic(theirEphemeral),
  });
  const ephToStatic = diffieHellman({
    privateKey: importPrivate(ourEphemeral),
    publicKey: importPublic(theirStatic),
  });
  const weAreLower = Buffer.compare(Buffer.from(ours.publicKey, "base64url"), Buffer.from(theirStatic, "base64url")) < 0;
  const ikm = Buffer.concat([ee, weAreLower ? staticToEph : ephToStatic, weAreLower ? ephToStatic : staticToEph]);
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.from(code), PROTOCOL, 32));
}

export function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([nonce, body]);
}

export function open(key: Buffer, payload: Buffer): Buffer {
  if (payload.length < 12 + 16) throw new Error("truncated encrypted frame");
  const nonce = payload.subarray(0, 12);
  const tag = payload.subarray(payload.length - 16);
  const body = payload.subarray(12, payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
