import { supabase } from "@/lib/supabase";
import { useEffect, useRef, useState } from "react";

type LogLevel = "info" | "warn" | "error" | "success";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

const REDIRECT_DELAY_MS = 5000;

export default function AuthCallback() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [redirectTarget, setRedirectTarget] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(
    Math.round(REDIRECT_DELAY_MS / 1000),
  );
  const cancelledRef = useRef(false);

  const appendLog = (level: LogLevel, message: string) => {
    const timestamp = new Date().toISOString().slice(11, 23);
    const consoleFn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.log;
    consoleFn(`[Auth callback] ${message}`);
    setLogs((prev) => [...prev, { level, message, timestamp }]);
  };

  const scheduleRedirect = (target: string) => {
    setRedirectTarget(target);
    appendLog(
      "info",
      `Redirect a "${target}" tra ${Math.round(REDIRECT_DELAY_MS / 1000)} secondi…`,
    );
  };

  useEffect(() => {
    cancelledRef.current = false;

    const run = async () => {
      const url = new URL(window.location.href);
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));

      appendLog("info", `URL completo: ${window.location.href}`);

      const queryEntries = Array.from(url.searchParams.entries());
      if (queryEntries.length === 0) {
        appendLog("info", "Query string: (vuota)");
      } else {
        appendLog(
          "info",
          `Query params: ${queryEntries
            .map(([k, v]) => `${k}=${v.length > 60 ? v.slice(0, 60) + "…" : v})`)
            .join(", ")}`,
        );
      }

      const hashEntries = Array.from(hashParams.entries());
      if (hashEntries.length === 0) {
        appendLog("info", "Hash fragment: (vuoto)");
      } else {
        appendLog(
          "info",
          `Hash params: ${hashEntries
            .map(([k, v]) => `${k}=${v.length > 60 ? v.slice(0, 60) + "…" : v})`)
            .join(", ")}`,
        );
      }

      const errorParam =
        url.searchParams.get("error") ?? hashParams.get("error");
      const errorDescription =
        url.searchParams.get("error_description") ??
        hashParams.get("error_description");
      if (errorDescription) {
        appendLog(
          "error",
          `Supabase ha restituito un errore esplicito: error="${errorParam ?? "(none)"}" description="${errorDescription}"`,
        );
        scheduleRedirect("/login");
        return;
      }

      const code = url.searchParams.get("code");
      if (code) {
        appendLog(
          "success",
          `Trovato parametro "code" (length=${code.length}, preview="${code.slice(0, 12)}…")`,
        );
        appendLog("info", "Chiamata exchangeCodeForSession in corso…");

        const { data, error: exchangeError } =
          await supabase.auth.exchangeCodeForSession(code);

        if (exchangeError) {
          const status = (exchangeError as { status?: number }).status;
          appendLog(
            "error",
            `exchangeCodeForSession FALLITO: name="${exchangeError.name}" status=${status ?? "n/a"} message="${exchangeError.message}"`,
          );
          try {
            appendLog(
              "error",
              `Dettagli errore: ${JSON.stringify(exchangeError, Object.getOwnPropertyNames(exchangeError))}`,
            );
          } catch {
            // ignore stringify failures
          }
          scheduleRedirect("/login");
          return;
        }

        if (!data.session) {
          appendLog(
            "error",
            "exchangeCodeForSession non ha restituito errori, ma data.session è null/undefined.",
          );
          scheduleRedirect("/login");
          return;
        }

        appendLog(
          "success",
          `Sessione creata. user.id=${data.session.user.id} email=${data.session.user.email ?? "(none)"} expires_at=${data.session.expires_at ?? "n/a"}`,
        );
        scheduleRedirect("/");
        return;
      }

      if (hashParams.get("access_token")) {
        appendLog(
          "info",
          "Trovato access_token nel fragment URL — attesa pickup SDK…",
        );
        for (let attempt = 0; attempt < 20; attempt++) {
          const { data } = await supabase.auth.getSession();
          if (data.session) {
            appendLog(
              "success",
              `Sessione recuperata da hash al tentativo ${attempt + 1}. user.id=${data.session.user.id}`,
            );
            scheduleRedirect("/");
            return;
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        appendLog(
          "error",
          "Timeout: SDK non ha agganciato la sessione dal fragment URL dopo 20 tentativi (~3s).",
        );
        scheduleRedirect("/login");
        return;
      }

      appendLog(
        "error",
        "Nessun parametro utile trovato (né code, né access_token, né error_description).",
      );
      scheduleRedirect("/login");
    };

    run().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog("error", `Eccezione non gestita: ${msg}`);
      scheduleRedirect("/login");
    });

    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!redirectTarget) return;

    setSecondsLeft(Math.round(REDIRECT_DELAY_MS / 1000));
    const tickInterval = window.setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);

    const redirectTimeout = window.setTimeout(() => {
      if (cancelledRef.current) return;
      window.location.replace(redirectTarget);
    }, REDIRECT_DELAY_MS);

    return () => {
      window.clearInterval(tickInterval);
      window.clearTimeout(redirectTimeout);
    };
  }, [redirectTarget]);

  const colorForLevel = (level: LogLevel) => {
    switch (level) {
      case "error":
        return "text-red-400";
      case "warn":
        return "text-yellow-400";
      case "success":
        return "text-green-400";
      default:
        return "text-zinc-200";
    }
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100 px-4 py-6 font-mono text-xs">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="flex items-baseline justify-between border-b border-zinc-700 pb-2">
          <h1 className="text-base font-semibold">Auth callback debug</h1>
          {redirectTarget ? (
            <span className="text-zinc-400">
              Redirect a <span className="text-zinc-100">{redirectTarget}</span>{" "}
              fra {secondsLeft}s
            </span>
          ) : (
            <span className="text-zinc-400">In esecuzione…</span>
          )}
        </div>

        <pre className="whitespace-pre-wrap break-all rounded bg-zinc-950 border border-zinc-800 p-3 leading-relaxed">
          {logs.map((entry, i) => (
            <div key={i} className={colorForLevel(entry.level)}>
              [{entry.timestamp}] {entry.level.toUpperCase().padEnd(7)}{" "}
              {entry.message}
            </div>
          ))}
          {logs.length === 0 && (
            <span className="text-zinc-500">(in attesa di log…)</span>
          )}
        </pre>

        {redirectTarget && (
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                cancelledRef.current = true;
                setRedirectTarget(null);
              }}
              className="rounded border border-zinc-700 px-3 py-1 text-zinc-200 hover:bg-zinc-900"
            >
              Annulla redirect
            </button>
            <a
              href={redirectTarget}
              className="rounded border border-zinc-700 px-3 py-1 text-zinc-200 hover:bg-zinc-900"
            >
              Vai subito a {redirectTarget}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
