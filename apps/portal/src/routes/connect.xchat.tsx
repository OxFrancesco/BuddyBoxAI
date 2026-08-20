import { Show, SignInButton, useUser } from "@clerk/tanstack-react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction, useConvexAuth, useMutation } from "convex/react";
import { AtSign, Check, Copy, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { api } from "../../../../convex/_generated/api";
import { BrandMark } from "~/components/brand-mark";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/connect/xchat")({
  validateSearch: (search: Record<string, unknown>) => ({
    claim: typeof search.claim === "string" ? search.claim : "",
  }),
  component: ConnectXChat,
});

function ConnectXChat() {
  const { claim } = Route.useSearch();
  const { user } = useUser();
  const { isAuthenticated } = useConvexAuth();
  const syncCurrent = useMutation(api.users.syncCurrent);
  const attachClaim = useAction(api.bridgeActions.attachXchatClaim);
  const [result, setResult] = useState<{ challengeCode: string; expiresAt: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "working" | "failed">("idle");

  const connect = async () => {
    if (!claim || !user || !isAuthenticated || status === "working") return;
    setStatus("working");
    try {
      await syncCurrent({
        displayName: user.fullName ?? user.username ?? undefined,
        primaryEmail: user.primaryEmailAddress?.emailAddress,
        imageUrl: user.imageUrl,
      });
      const attached = await attachClaim({ claimToken: claim });
      setResult(attached);
      setStatus("idle");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <main className="connect-page connect-page--xchat">
      <header className="connect-nav">
        <Link className="brand" to="/"><BrandMark /><span>iChef</span></Link>
        <span><ShieldCheck size={14} /> Google identity · Clerk-bound claim</span>
      </header>
      <section className="connect-card">
        <div className="connect-icon connect-icon--xchat"><AtSign size={25} /></div>
        <p className="eyebrow">Connect X Chat · early access</p>
        <h1>Prove the X conversation is yours.</h1>
        {!claim ? (
          <>
            <div className="connect-notice is-warning">
              X Chat claims become available after the iChef operator activates the X developer app,
              encrypted bridge, and webhook. Production credentials are not configured in this portal.
            </div>
            <p className="connect-copy">
              Once activated, message the official iChef account in X Chat. Its private reply will contain
              a one-use, 15-minute connection link that returns you here.
            </p>
          </>
        ) : result ? (
          <div className="challenge-result">
            <span>Reply in the same X Chat conversation with exactly</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(`ICHEF-${result.challengeCode}`)}
            >
              ICHEF-{result.challengeCode} <Copy size={16} />
            </button>
            <small>This one-use code expires at {new Date(result.expiresAt).toLocaleTimeString()}.</small>
            <p><Check size={16} /> Keep this page open until iChef confirms the connection in X Chat.</p>
          </div>
        ) : (
          <>
            <p className="connect-copy">
              This link identifies a pending encrypted X Chat conversation, not your general login.
              Continue with Google through Clerk, then send the one-use phrase from that same X account.
            </p>
            <Show when="signed-out">
              <SignInButton mode="modal">
                <Button size="lg">Continue with Google</Button>
              </SignInButton>
            </Show>
            <Show when="signed-in">
              <Button size="lg" disabled={!isAuthenticated || status === "working"} onClick={() => void connect()}>
                {status === "working" ? "Securing claim…" : "Bind this X Chat"}
              </Button>
            </Show>
            {status === "failed" ? (
              <div className="connect-notice is-error">This link is invalid, expired, or already used. Ask iChef for a new one in X Chat.</div>
            ) : null}
          </>
        )}
        <Link className="text-link connect-back" to="/">← Back to setup</Link>
      </section>
    </main>
  );
}
