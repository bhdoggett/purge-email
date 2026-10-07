/** An encrypted JSON value as stored in IndexedDB. */
export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

const IV_BYTES = 12;

/** Imports the base64 AES-256 key from the Keychain as a non-extractable WebCrypto key. */
export function importDataKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (raw.byteLength !== 32) return Promise.reject(new Error("Local data key must be 256 bits"));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function params(iv: Uint8Array<ArrayBuffer>, aad: string | undefined): AesGcmParams {
  return aad === undefined ? { name: "AES-GCM", iv } : { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) };
}

/**
 * Encrypts `value` as JSON with AES-GCM under a fresh random IV. `aad` (the record id) is
 * authenticated but not stored, so a sealed value only opens under the id it was saved for.
 */
export async function encryptJson(key: CryptoKey, value: unknown, aad?: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt(params(iv, aad), key, new TextEncoder().encode(JSON.stringify(value)));
  return { iv, data };
}

/** Decrypts a value sealed by `encryptJson` with the same `aad`; rejects on a wrong key, id, or tampered data. */
export async function decryptJson<T>(key: CryptoKey, sealed: Sealed, aad?: string): Promise<T> {
  const plain = await crypto.subtle.decrypt(params(sealed.iv, aad), key, sealed.data);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** True for a record written by `encryptJson` (plaintext records from before encryption have no `iv`). */
export function isSealed(value: unknown): value is Sealed {
  return typeof value === "object" && value !== null && (value as Sealed).iv instanceof Uint8Array && (value as Sealed).data instanceof ArrayBuffer;
}
