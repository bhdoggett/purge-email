export function formatDuration(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function formatUsd(usd: number): string {
  return usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`;
}

export function displaySubject(subject: string): string {
  return subject.trim() || "(no subject)";
}
