import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Cloud, Globe2 } from "lucide-react";

import { BrandMark } from "~/components/brand-mark";
import { managedProjectHostname } from "~/lib/onboarding";

export const Route = createFileRoute("/hosting")({ component: ManagedHosting });

function ManagedHosting() {
  return (
    <main className="connect-page">
      <header className="connect-nav">
        <Link className="brand" to="/"><BrandMark /><span>BuddyBox</span></Link>
        <span><Check size={14} /> Included with every project</span>
      </header>
      <section className="connect-card provider-connect-card" aria-labelledby="hosting-heading">
        <div className="connect-icon"><Cloud size={25} /></div>
        <div className="provider-status is-configured" role="status"><Check size={12} /> Managed by BuddyBox</div>
        <p className="eyebrow">Cloudflare hosting included</p>
        <h1 id="hosting-heading">Ship without another account.</h1>
        <p className="connect-copy">
          BuddyBox hosts previews and approved releases in its Cloudflare account. You never need to connect
          Cloudflare or share a Cloudflare token.
        </p>
        <div className="provider-prerequisites">
          <div className="provider-prerequisites__heading">
            <span>Your project address pattern</span><small>Automatic</small>
          </div>
          <div className="provider-user-step">
            <small><Globe2 size={12} /> Managed hostname</small>
            <p><code>{managedProjectHostname}</code></p>
          </div>
        </div>
        <div className="connect-notice is-warning">
          This managed hostname convention is reserved for the hosted beta. Publication still requires
          your explicit release approval, and custom-domain support is not enabled yet.
        </div>
        <Link className="text-link connect-back" to="/">← Back to setup</Link>
      </section>
    </main>
  );
}
