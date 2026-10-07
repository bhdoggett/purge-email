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

/** Encrypts `value` as JSON with AES-GCM under a fresh random IV. */
export async function encryptJson(key: CryptoKey, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { iv, data };
}

/** Decrypts a value sealed by `encryptJson`; rejects on a wrong key or tampered data. */
export async function decryptJson<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, key, sealed.data);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** True for a record written by `encryptJson` (plaintext records from before encryption have no `iv`). */
export function isSealed(value: unknown): value is Sealed {
  return typeof value === "object" && value !== null && (value as Sealed).iv instanceof Uint8Array && (value as Sealed).data instanceof ArrayBuffer;
}
