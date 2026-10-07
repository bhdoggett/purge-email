import { useEffect, useState } from "react";
import { useRateLimit } from "../rateLimit.ts";

/** Counts down Gmail's shared pause; renders nothing unless a pause is still running. */
export function RateLimitNote({ className }: { className?: string }) {
  const until = useRateLimit();
  const [now, setNow] = useState(Date.now());
  const active = until !== null;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    // Tick faster than once a second so the countdown never skips or lingers on a second.
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  if (until === null || until <= now) return null;
  return (
    <p className={className} role="status">
      Gmail asked us to slow down. Continuing in {Math.ceil((until - now) / 1000)}s.
    </p>
  );
}
