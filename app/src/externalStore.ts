import { useSyncExternalStore } from "react";

export interface ExternalStore<T> {
  get(): T;
  set(value: T): void;
  subscribe(fn: () => void): () => void;
}

/** A tiny shared value that React components can follow with `useStore`. */
export function createStore<T>(initial: T): ExternalStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

export function useStore<T>(store: ExternalStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
