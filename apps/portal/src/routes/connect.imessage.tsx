import { Show, SignInButton, useUser } from "@clerk/tanstack-react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction, useConvexAuth, useMutation } from "convex/react";
import { Check, Copy, MessageCircleMore, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { api } from "../../../../convex/_generated/api";
import { BrandMark } from "~/components/brand-mark";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/connect/imessage")({
  validateSearch: (search: Record<string, unknown>) => ({
    claim: typeof search.claim === "string" ? search.claim : "",
  }),
  component: ConnectImessage,
});

function ConnectImessage() {
  const { claim } = Route.useSearch();
  const { user } = useUser();
  const { isAuthenticated } = useConvexAuth();
  const syncCurrent = useMutation(api.users.syncCurrent);
  const attachClaim = useAction(api.bridgeActions.attachImessageClaim);
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
    <main className="connect-page">
      <header className="connect-nav">
        <Link className="brand" to="/"><BrandMark /><span>BuddyBox</span></Link>
        <span><ShieldCheck size={14} /> Clerk-bound verification</span>
      </header>
      <section className="connect-card">
        <div className="connect-icon"><MessageCircleMore size={25} /></div>
        <p className="eyebrow">Connect iMessage</p>
        <h1>Prove the conversation is yours.</h1>
        {!claim ? (
          <div className="connect-notice is-warning">
            Start by messaging the BuddyBox Spectrum line. Its reply contains a private, 15-minute connection link.
          </div>
        ) : result ? (
          <div className="challenge-result">
            <span>Reply in the same iMessage conversation with exactly</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(`BUDDYBOX-${result.challengeCode}`)}
            >
              BUDDYBOX-{result.challengeCode} <Copy size={16} />
            </button>
            <small>This one-use code expires at {new Date(result.expiresAt).toLocaleTimeString()}.</small>
            <p><Check size={16} /> Keep this page open until BuddyBox confirms the connection in Messages.</p>
          </div>
        ) : (
          <>
            <p className="connect-copy">
              The link identifies a pending iMessage conversation, not a person. Sign in with Clerk,
              then send the one-use phrase from that same address to bind both identities.
            </p>
            <Show when="signed-out">
              <SignInButton mode="modal">
                <Button size="lg">Sign in to continue</Button>
              </SignInButton>
            </Show>
            <Show when="signed-in">
              <Button size="lg" disabled={!isAuthenticated || status === "working"} onClick={() => void connect()}>
                {status === "working" ? "Securing claim…" : "Bind this iMessage"}
              </Button>
            </Show>
            {status === "failed" ? (
              <div className="connect-notice is-error">This link is invalid, expired, or already used. Ask BuddyBox for a new one.</div>
            ) : null}
          </>
        )}
        <Link className="text-link connect-back" to="/">← Back to setup</Link>
      </section>
    </main>
  );
}
