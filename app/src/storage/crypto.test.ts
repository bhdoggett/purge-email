import { describe, expect, it } from "vitest";
import { randomKeyBase64 } from "../test/key.ts";
import { decryptJson, encryptJson, importDataKey } from "./crypto.ts";

describe("local data crypto", () => {
  it("round-trips JSON values", async () => {
    const key = await importDataKey(randomKeyBase64());
    const value = { subject: "Hello", n: 3, list: ["a", "ü"], nested: { ok: true } };
    const sealed = await encryptJson(key, value);
    expect(sealed.iv).toBeInstanceOf(Uint8Array);
    expect(sealed.iv.byteLength).toBe(12);
    expect(sealed.data).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(sealed.data)).not.toContain("Hello");
    expect(await decryptJson(key, sealed)).toEqual(value);
  });

  it("imports the key as non-extractable AES-GCM 256", async () => {
    const key = await importDataKey(randomKeyBase64());
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  });

  it("rejects a key that is not 256 bits", async () => {
    await expect(importDataKey(btoa("short"))).rejects.toThrow();
  });

  it("uses a fresh IV for every record", async () => {
    const key = await importDataKey(randomKeyBase64());
    const a = await encryptJson(key, "same");
    const b = await encryptJson(key, "same");
    expect(Array.from(a.iv)).not.toEqual(Array.from(b.iv));
    expect(new Uint8Array(a.data)).not.toEqual(new Uint8Array(b.data));
  });

  it("fails on tampered data or the wrong key", async () => {
    const key = await importDataKey(randomKeyBase64());
    const other = await importDataKey(randomKeyBase64());
    const sealed = await encryptJson(key, { a: 1 });
    await expect(decryptJson(other, sealed)).rejects.toThrow();
    const bytes = new Uint8Array(sealed.data.slice(0));
    bytes[0]! ^= 1;
    await expect(decryptJson(key, { iv: sealed.iv, data: bytes.buffer })).rejects.toThrow();
    const iv = sealed.iv.slice();
    iv[0]! ^= 1;
    await expect(decryptJson(key, { iv, data: sealed.data })).rejects.toThrow();
  });
});
