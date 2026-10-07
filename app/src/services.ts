import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { proxyFetch } from "./bridge/proxyFetch.ts";
import { localDataKey } from "./bridge/tauri.ts";
import { createGmail, type Gmail } from "./gmail/client.ts";
import { createJudge } from "./jev/client.ts";
import { rateLimit } from "./rateLimit.ts";
import { ApplyRunner } from "./scan/applyRunner.ts";
import { ScanEngine } from "./scan/engine.ts";
import { DEFAULT_SETTINGS } from "@core/decide.ts";
import { importDataKey } from "./storage/crypto.ts";
import { openStore, type Store } from "./storage/db.ts";

const DEFAULT_PREFIX = import.meta.env.VITE_PURGE_LABEL ?? "purge";

export interface Services {
  store: Store;
  gmail: Gmail;
  engine: ScanEngine;
  applier: ApplyRunner;
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

let dataKey: Promise<CryptoKey> | null = null;

/** The key that encrypts saved emails and Jev answers, read from the Keychain once per launch. */
function getDataKey(): Promise<CryptoKey> {
  if (!dataKey) {
    const pending = localDataKey().then(importDataKey);
    dataKey = pending;
    pending.catch(() => {
      if (dataKey === pending) dataKey = null;
    });
  }
  return dataKey;
}

let services: Promise<Services> | null = null;

export function getServices(): Promise<Services> {
  services ??= (async () => {
    const store = await openStore(getDataKey, undefined, { ...DEFAULT_SETTINGS, labelPrefix: DEFAULT_PREFIX });
    const gmail = createGmail({ fetch: proxyFetch, onRateLimit: (until) => rateLimit.set(until) });
    // Each checks the other before it starts: a scan and an Apply never run together.
    const applier: ApplyRunner = new ApplyRunner({ gmail, store, isScanning: () => engine.isBusy() });
    const engine: ScanEngine = new ScanEngine({ gmail, judge: createJudge(), store, notify: (t, b) => void notify(t, b), isBlocked: () => applier.busy() });
    return { store, gmail, engine, applier };
  })();
  services.catch(() => {
    services = null;
  });
  return services;
}
