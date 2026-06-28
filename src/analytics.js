/* ============================ Analytics ============================ */
// Fire-and-forget page-visit beacon to the `analytics` service
// (/Users/jeremy/projects/analytics). One counter event, deferred to idle so it stays
// off the cold-load critical path. Skips local dev/preview; never throws.
export function trackPageview() {
  const h = location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "") return; // dev / preview / file://
  (window.requestIdleCallback || setTimeout)(() => {
    // A string body is sent as text/plain (no CORS preflight); the server parses JSON.
    // The lone try/catch is the whole safety net: sendBeacon is universal (no fetch
    // fallback needed) and a dead endpoint can't be allowed to surface as an error.
    try {
      navigator.sendBeacon(
        "https://analytics.jeremyvun.com/e",
        JSON.stringify({ p: "mortgage-calc", t: "pageview" }),
      );
    } catch {}
  });
}
