/**
 * Supabase Storage helpers per DDT PDF.
 * Bucket: "ddt-imports" (private, admin/operator only)
 */
import { createClient } from "@supabase/supabase-js";
import { ENV } from "../server/_core/env";

const DDT_BUCKET = "ddt-imports";

function getStorageClient() {
  // Usa service_role per bypass RLS (server-side only)
  return createClient(ENV.supabase.url, ENV.supabase.serviceRoleKey, {
    auth: { persistSession: false },
  });
}

export interface UploadResult {
  path: string;
  fullPath: string;
}

/**
 * Upload un PDF nel bucket ddt-imports.
 * Path format: {YYYY}/{MM}/{uuid}-{originalName}.pdf
 */
export async function uploadDdtPdf(
  fileBuffer: Buffer,
  fileName: string,
  fileId: string
): Promise<UploadResult> {
  const supabase = getStorageClient();
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${year}/${month}/${fileId}-${safeName}`;

  const { error } = await supabase.storage
    .from(DDT_BUCKET)
    .upload(path, fileBuffer, {
      contentType: "application/pdf",
      upsert: false,
    });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  return { path, fullPath: `${DDT_BUCKET}/${path}` };
}

/**
 * Download un PDF dal bucket ddt-imports.
 * Ritorna il buffer del file.
 */
export async function downloadDdtPdf(path: string): Promise<Buffer> {
  const supabase = getStorageClient();

  const { data, error } = await supabase.storage
    .from(DDT_BUCKET)
    .download(path);

  if (error || !data) {
    throw new Error(`Storage download failed: ${error?.message ?? "no data"}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Genera un signed URL temporaneo per download diretto (TTL 1 ora).
 */
export async function getSignedUrl(path: string, expiresIn = 3600): Promise<string> {
  const supabase = getStorageClient();

  const { data, error } = await supabase.storage
    .from(DDT_BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error || !data?.signedUrl) {
    throw new Error(`Signed URL failed: ${error?.message ?? "no URL"}`);
  }

  return data.signedUrl;
}

/**
 * Elimina un file dal bucket ddt-imports.
 */
export async function deleteDdtPdf(path: string): Promise<void> {
  const supabase = getStorageClient();

  const { error } = await supabase.storage
    .from(DDT_BUCKET)
    .remove([path]);

  if (error) {
    throw new Error(`Storage delete failed: ${error.message}`);
  }
}
