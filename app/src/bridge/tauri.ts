import { invoke } from "@tauri-apps/api/core";
import { toAppError } from "./errors.ts";

export type SecretsStatus = { jev: boolean; googleClient: boolean; gmailEmail: string | null };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export const saveSecret = (kind: "jev" | "google_client", value: string) => call<void>("save_secret", { kind, value });
export const secretsStatus = () => call<SecretsStatus>("secrets_status");
export const googleSignIn = () => call<string>("google_sign_in");
export const signOut = () => call<void>("sign_out");
export const clearSecrets = () => call<void>("clear_secrets");
/** Base64 AES-256 key for encrypting email data in IndexedDB, created on first use. */
export const localDataKey = () => call<string>("local_data_key");

export interface ProxyRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
}
export interface ProxyResponse {
  status: number;
  headers: [string, string][];
  body: string;
}
export const apiRequest = (req: ProxyRequest) => call<ProxyResponse>("api_request", { req });
