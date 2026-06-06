import { z } from "zod";

/**
 * Permissive UUID schema that accepts any hex-formatted UUID string,
 * including custom non-RFC-compliant UUIDs (e.g. seed companies).
 * 
 * Use this instead of z.string().uuid() which is strict (RFC 4122 v1-v8 only).
 */
export const uuidSchema = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "Invalid UUID format"
);
