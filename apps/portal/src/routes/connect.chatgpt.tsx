import { useUser } from "@clerk/tanstack-react-start";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useAction, useConvexAuth, useMutation } from "convex/react";
import { Check, ExternalLink, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../../../../convex/_generated/api";
import { BrandMark } from "~/components/brand-mark";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/connect/chatgpt")({ component: ConnectChatGpt });

type ConnectionStatus =
  | { state: "disconnected" }
  | { state: "pending"; sessionId: string; userCode: string; verificationUri: string; expiresAt: number; retryAfterMs: number }
  | { state: "busy"; retryAfterMs: number }
  | { state: "connected" }
  | { state: "failed"; code: string };

function ConnectChatGpt() {
  const { user, isLoaded } = useUser();
  const { isAuthenticated } = useConvexAuth();
  const syncCurrent = useMutation(api.users.syncCurrent);
  const startConnection = useAction(api.codexConnectionActions.start);
  const pollConnection = useAction(api.codexConnectionActions.poll);
  const readStatus = useAction(api.codexConnectionActions.status);
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !user || connection !== null) return;
    void syncCurrent({
      displayName: user.fullName ?? user.username ?? undefined,
      primaryEmail: user.primaryEmailAddress?.emailAddress,
      imageUrl: user.imageUrl,
    }).then(() => readStatus({})).then(setConnection).catch(() => setConnection({ state: "failed", code: "status_unavailable" }));
  }, [connection, isAuthenticated, readStatus, syncCurrent, user]);

  useEffect(() => {
    if (connection?.state !== "pending") return;
    const delay = Math.max(1_000, connection.retryAfterMs);
    const timer = window.setTimeout(() => {
      void pollConnection({ sessionId: connection.sessionId }).then(setConnection)
        .catch(() => setConnection({ state: "failed", code: "poll_unavailable" }));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [connection, pollConnection]);

  if (isLoaded && !user) return <Navigate to="/sign-in/$" params={{ _splat: "" }} />;

  const begin = async () => {
    if (working) return;
    setWorking(true);
    try {
      setConnection(await startConnection({}));
    } catch {
      setConnection({ state: "failed", code: "start_unavailable" });
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="connect-page">
      <header className="connect-nav">
        <Link className="brand" to="/"><BrandMark /><span>BuddyBox</span></Link>
        <span>Tokens stay encrypted outside active runs</span>
      </header>
      <section className="connect-card">
        <div className="connect-icon"><Sparkles size={25} /></div>
        <p className="eyebrow">Connect ChatGPT</p>
        <h1>Bring your Codex access to Pi.</h1>
        {connection?.state === "connected" ? (
          <div className="challenge-result">
            <p><Check size={16} /> ChatGPT is connected. Pi can now use your Codex subscription through the private broker.</p>
            <Button asChild size="lg"><Link to="/">Continue setup</Link></Button>
          </div>
        ) : connection?.state === "pending" ? (
          <div className="challenge-result">
            <span>Open OpenAI’s device page and enter</span>
            <button type="button" onClick={() => void navigator.clipboard.writeText(connection.userCode)}>{connection.userCode}</button>
            <Button asChild size="lg">
              <a href={connection.verificationUri} target="_blank" rel="noreferrer">Open ChatGPT <ExternalLink size={16} /></a>
            </Button>
            <p>Waiting for authorization… this page checks automatically.</p>
          </div>
        ) : (
          <>
            <p className="connect-copy">
              BuddyBox uses OpenAI’s Codex device authorization. Your refresh credential is encrypted
              in Convex; only a current access token reaches the private broker for one authorized run.
            </p>
            <Button size="lg" disabled={working || !isAuthenticated} onClick={() => void begin()}>
              {working ? "Starting secure flow…" : "Connect ChatGPT"}
            </Button>
            {connection?.state === "failed" ? (
              <div className="connect-notice is-error">Connection failed safely ({connection.code}). You can start a fresh authorization.</div>
            ) : null}
          </>
        )}
        <Link className="text-link connect-back" to="/">← Back to setup</Link>
      </section>
    </main>
  );
}
