// Minimal isolation test — no imports, no server/*. If this returns 200,
// Vercel's CJS prebundle path works and the issue is in our app imports.
// If this still returns FUNCTION_INVOCATION_FAILED, the issue is at the
// @vercel/node + prebundled-CJS level itself.
export default function handler(_req: { url?: string }, res: any) {
  res.status(200).setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      marker: "minimal-handler-alive",
      nodeVersion: process.version,
      vercelEnv: process.env.VERCEL_ENV ?? "missing",
      vercelRegion: process.env.VERCEL_REGION ?? "missing",
    }),
  );
}
