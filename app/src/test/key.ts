import { importDataKey } from "../storage/crypto.ts";

/** A fresh random base64 key, as the Rust `local_data_key` command returns. */
export function randomKeyBase64(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

const shared = importDataKey(randomKeyBase64());
/** Key provider shared by tests that only need a working store. */
export const testKey = (): Promise<CryptoKey> => shared;
