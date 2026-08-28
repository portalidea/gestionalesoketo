import { Mail, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Il vecchio URL non espone più catalogo, listino o fasce. */
export default function ProspectSimulator() {
  return <main className="grid min-h-screen place-items-center bg-[#FAF7F0] p-6 text-[#254521]">
    <Card className="w-full max-w-xl border-[#2D5A27]/15 bg-white shadow-lg">
      <CardHeader className="bg-[#2D5A27] text-white"><CardTitle className="font-[Poppins] text-white">Ordini rivenditori SoKeto</CardTitle><CardDescription className="text-[#EAF3E6]">Accesso riservato ai prospect invitati.</CardDescription></CardHeader>
      <CardContent className="space-y-4 p-6"><p>Per compilare il tuo primo ordine usa il link personale ricevuto via email o WhatsApp.</p><p className="text-sm text-[#52634d]">Se il link non è più valido, contattaci per riceverne uno nuovo.</p><a className="inline-flex items-center gap-2 font-semibold text-[#2D5A27] underline" href="mailto:info@soketo.it"><Mail className="h-4 w-4" />Contatta SoKeto</a><p className="border-t pt-4 text-xs text-[#6B7C66]"><ShieldCheck className="mr-1 inline h-3.5 w-3.5" />Il listino commerciale viene mostrato solo all’interno di un invito personale valido.</p><Link href="/" className="block text-sm font-medium text-[#2D5A27] underline">Torna alla pagina principale</Link></CardContent>
    </Card>
  </main>;
}
