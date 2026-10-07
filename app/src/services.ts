import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { proxyFetch } from "./bridge/proxyFetch.ts";
import { createGmail, type Gmail } from "./gmail/client.ts";
import { createJudge } from "./jev/client.ts";
import { ScanEngine } from "./scan/engine.ts";
import { openStore, type Store } from "./storage/db.ts";

export const LABEL_NAME = import.meta.env.VITE_PURGE_LABEL ?? "purge";

export interface Services {
  store: Store;
  gmail: Gmail;
  engine: ScanEngine;
  labelName: string;
}

/** Best effort: a notification that can't be shown is not worth an error. */
async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch (err) {
    console.warn("notification failed", err);
  }
}

let services: Promise<Services> | null = null;

export function getServices(): Promise<Services> {
  services ??= (async () => {
    const store = await openStore();
    let engine: ScanEngine | undefined;
    const gmail = createGmail({ fetch: proxyFetch, onRateLimit: (ms) => engine?.noteRateLimit(ms) });
    engine = new ScanEngine({ gmail, judge: createJudge(), store, labelName: LABEL_NAME, notify: (t, b) => void notify(t, b) });
    return { store, gmail, engine, labelName: LABEL_NAME };
  })();
  services.catch(() => {
    services = null;
  });
  return services;
}
