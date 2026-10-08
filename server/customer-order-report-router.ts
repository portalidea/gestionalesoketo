import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { staffProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { getUserCompanyIds } from "./services/multiCompanyAccess";
import {
  generateCustomerOrderPdf,
  generateCustomerOrderXlsx,
  loadCustomerOrderReport,
  reportFilename,
} from "./services/customerOrderReportService";

const reportInput = z.object({
  retailerId: z.string().uuid(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato data iniziale atteso YYYY-MM-DD"),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato data finale atteso YYYY-MM-DD"),
  includeRelatedProfiles: z.boolean().default(true),
});

async function loadAuthorizedReport(
  ctx: { user?: { id: string } | null; activeCompanyId: string },
  input: z.infer<typeof reportInput>,
) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database non disponibile" });

  const authorizedCompanyIds = await getUserCompanyIds(ctx.user!.id);
  if (!authorizedCompanyIds.includes(ctx.activeCompanyId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Company attiva non autorizzata" });
  }

  try {
    return await loadCustomerOrderReport(db, {
      ...input,
      authorizedCompanyIds,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    const message = error instanceof Error ? error.message : "Impossibile generare il report cliente";
    if (message.includes("non trovato") || message.includes("non autorizzato")) {
      throw new TRPCError({ code: "NOT_FOUND", message });
    }
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
}

/**
 * Report read-only per invio al cliente. L'aggregazione per P. IVA resta
 * limitata alle sole company che lo staff ha già autorizzate nel proprio
 * contesto: non è una scorciatoia ai filtri multi-company.
 */
export const customerOrderReportRouter = router({
  preview: staffProcedure
    .input(reportInput)
    .query(async ({ ctx, input }) => loadAuthorizedReport(ctx, input)),

  exportPdf: staffProcedure
    .input(reportInput)
    .mutation(async ({ ctx, input }) => {
      const report = await loadAuthorizedReport(ctx, input);
      const fileBase64 = await generateCustomerOrderPdf(report);
      return {
        filename: reportFilename(report, "pdf"),
        fileBase64,
        mimeType: "application/pdf",
      };
    }),

  exportXlsx: staffProcedure
    .input(reportInput)
    .mutation(async ({ ctx, input }) => {
      const report = await loadAuthorizedReport(ctx, input);
      const fileBase64 = await generateCustomerOrderXlsx(report);
      return {
        filename: reportFilename(report, "xlsx"),
        fileBase64,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
    }),
});
