// Handcrafted minimal CJS handler — isolation test for Vercel runtime.
// If this returns 200, the issue is with our esbuild prebundled output shape.
// If this also returns FUNCTION_INVOCATION_FAILED, the issue is at the
// Vercel CJS-handler level (function detection, runtime config, etc.).
module.exports = function handler(_req, res) {
  res.status(200).setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      marker: "handcrafted-minimal-cjs",
      nodeVersion: process.version,
      vercelEnv: process.env.VERCEL_ENV || "missing",
      vercelRegion: process.env.VERCEL_REGION || "missing",
    }),
  );
};
