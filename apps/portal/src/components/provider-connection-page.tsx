import { useUser } from "@clerk/tanstack-react-start";
import { Link, Navigate } from "@tanstack/react-router";
import { useAction, useConvexAuth, useMutation } from "convex/react";
import { ArrowLeft, Check, LockKeyhole } from "lucide-react";
import { type ReactNode, useState } from "react";

import { api } from "../../../../convex/_generated/api";
import { BrandMark } from "~/components/brand-mark";
import { Button } from "~/components/ui/button";
import {
  classifyProviderAuthorizationError,
  type ProviderConnectionRequirement,
} from "~/lib/provider-connections";

interface ProviderConnectionPageProps {
  icon: ReactNode;
  provider: ProviderConnectionRequirement;
}

export function ProviderConnectionPage({ icon, provider }: ProviderConnectionPageProps) {
  const { isLoaded, user } = useUser();
  const { isAuthenticated } = useConvexAuth();
  const syncCurrent = useMutation(api.users.syncCurrent);
  const startProviderOAuth = useAction(api.providerOAuth.start);
  const [authorizationState, setAuthorizationState] = useState<
    "idle" | "starting" | "configuration_required" | "failed"
  >("idle");

  if (isLoaded && !user) {
    return <Navigate to="/sign-in/$" params={{ _splat: "" }} />;
  }

  const beginAuthorization = async () => {
    if (!user || !isAuthenticated || authorizationState === "starting") return;
    setAuthorizationState("starting");
    try {
      await syncCurrent({
        displayName: user.fullName ?? user.username ?? undefined,
        primaryEmail: user.primaryEmailAddress?.emailAddress,
        imageUrl: user.imageUrl,
      });
      const { authorizationUrl } = await startProviderOAuth({ provider: provider.id });
      const destination = new URL(authorizationUrl);
      if (destination.protocol !== "https:") throw new Error("OAuth authorization URL must use HTTPS");
      window.location.assign(destination.toString());
    } catch (error) {
      setAuthorizationState(classifyProviderAuthorizationError(error));
    }
  };

  return (
    <main className="connect-page provider-connect-page">
      <header className="connect-nav">
        <Link className="brand" to="/"><BrandMark /><span>BuddyBox</span></Link>
        <span><LockKeyhole size={14} /> Protected by your Clerk session</span>
      </header>

      <section className="connect-card provider-connect-card" aria-labelledby={`${provider.id}-heading`}>
        <div className="connect-icon">{icon}</div>
        <div className="provider-status is-configured" role="status">
          <LockKeyhole size={13} /> Secure OAuth handoff
        </div>
        <p className="eyebrow">{provider.eyebrow}</p>
        <h1 id={`${provider.id}-heading`}>{provider.headline}</h1>
        <p className="connect-copy">{provider.summary}</p>

        <div className="provider-prerequisites">
          <div className="provider-prerequisites__heading">
            <span>Before authorization can open</span>
            <small>BuddyBox operator</small>
          </div>
          <ol>
            {provider.operatorPrerequisites.map((requirement) => (
              <li key={requirement}><Check size={14} /> <span>{requirement}</span></li>
            ))}
          </ol>
        </div>

        <div className="provider-user-step">
          <small>What you will approve</small>
          <p>{provider.userApproval}</p>
        </div>

        <div className="connect-notice is-warning">{provider.gateNotice}</div>

        <Button
          size="lg"
          disabled={!isAuthenticated || authorizationState === "starting"}
          aria-describedby={`${provider.id}-availability`}
          onClick={() => void beginAuthorization()}
        >
          {authorizationState === "starting"
            ? "Opening secure authorization…"
            : `Authorize ${provider.eyebrow.replace("Connect ", "")}`}
        </Button>
        <p id={`${provider.id}-availability`} className="provider-disabled-copy">
          BuddyBox creates a short-lived, one-use, Clerk-bound OAuth state before leaving this page.
        </p>
        {authorizationState === "configuration_required" ? (
          <div className="connect-notice is-warning" role="alert">
            This provider’s production OAuth application is not configured yet. No connection was recorded.
          </div>
        ) : authorizationState === "failed" ? (
          <div className="connect-notice is-error" role="alert">
            Authorization could not start safely. No connection was recorded; please try again.
          </div>
        ) : null}

        <Link className="text-link connect-back" to="/"><ArrowLeft size={14} /> Back to setup</Link>
      </section>
    </main>
  );
}
