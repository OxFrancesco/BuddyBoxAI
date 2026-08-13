import { Show, UserButton, useUser } from "@clerk/tanstack-react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  Check,
  ChefHat,
  CircleDot,
  Cloud,
  Database,
  Github,
  MessageCircleMore,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api } from "../../../../convex/_generated/api";

import { BrandMark } from "~/components/brand-mark";
import { Button } from "~/components/ui/button";
import { evaluateProjectReadiness, onboardingSteps, type OnboardingState } from "~/lib/onboarding";

export const Route = createFileRoute("/")({ component: Home });

const conversation = [
  { from: "user", body: "Build a private recipe book. Calm, editorial, fast." },
  { from: "chef", body: "On it. I’ll use TanStack Start, Clerk, and Convex. Your GitHub repo will stay yours." },
  { from: "chef", body: "Preview is ready — auth, recipe CRUD, and mobile checks all pass.", action: "Open preview" },
  { from: "user", body: "Ship it" },
  { from: "chef", body: "Production needs your approval. Reply APPROVE 7K2." },
];

const stepIcons = {
  clerk: ShieldCheck,
  imessage: MessageCircleMore,
  chatgpt: Sparkles,
  github: Github,
  cloudflare: Cloud,
  convex: Database,
};

function Home() {
  return (
    <main className="site-shell">
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />
      <header className="nav-wrap">
        <a className="brand" href="#top" aria-label="iChef home">
          <BrandMark />
          <span>iChef</span>
          <em>private beta</em>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#how">How it works</a>
          <a href="#ownership">Your stack</a>
          <Show when="signed-in">
            <UserButton />
          </Show>
          <Show when="signed-out">
            <Button asChild variant="secondary" size="sm">
              <Link to="/sign-in/$" params={{ _splat: "" }}>Sign in</Link>
            </Button>
          </Show>
        </nav>
      </header>

      <section id="top" className="hero section-grid">
        <motion.div
          className="hero-copy"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <div className="status-pill"><span /> Private beta kitchen is open</div>
          <h1>Your next website starts with a <i>text.</i></h1>
          <p className="hero-lede">
            Meet iChef, the coding agent that lives in iMessage. Describe what you want;
            Pi cooks the code, verifies every course, and asks before it ships.
          </p>
          <div className="hero-actions">
            <Show when="signed-out">
              <Button asChild size="lg">
                <Link to="/sign-up/$" params={{ _splat: "" }}>Join the private beta <ArrowRight size={17} /></Link>
              </Button>
            </Show>
            <Show when="signed-in">
              <Button asChild size="lg">
                <a href="#onboarding">Finish setup <ArrowRight size={17} /></a>
              </Button>
            </Show>
            <a className="text-link" href="#how"><span className="play">↓</span> See how it works</a>
          </div>
          <div className="trust-row">
            <span><Check size={14} /> Your GitHub</span>
            <span><Check size={14} /> Your accounts</span>
            <span><Check size={14} /> Your code</span>
          </div>
        </motion.div>

        <motion.div
          className="phone-scene"
          initial={{ opacity: 0, scale: 0.94, rotate: 1.5 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          transition={{ delay: 0.15, duration: 0.8, ease: [0.2, 0.8, 0.2, 1] }}
        >
          <div className="service-note note--top"><TerminalSquare size={16} /> Pi is editing 6 files</div>
          <div className="phone">
            <div className="phone-island" />
            <div className="phone-header">
              <span className="mini-mark"><ChefHat size={16} /></span>
              <div><strong>iChef</strong><small>coding in your kitchen</small></div>
              <span className="phone-info">i</span>
            </div>
            <div className="messages">
              {conversation.map((message, index) => (
                <motion.div
                  key={`${message.body}-${index}`}
                  className={`bubble bubble--${message.from}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.45 + index * 0.13 }}
                >
                  {message.body}
                  {message.action ? <button type="button">{message.action} <ArrowRight size={13} /></button> : null}
                </motion.div>
              ))}
              <div className="typing"><span /><span /><span /></div>
            </div>
            <div className="message-bar"><span>＋</span><div>iMessage</div><span>◉</span></div>
          </div>
          <div className="service-note note--bottom"><ShieldCheck size={16} /> Approval required to ship</div>
        </motion.div>
      </section>

      <section id="how" className="service-strip">
        <p>One conversation. The complete service.</p>
        <div>
          <span><MessageCircleMore /> Brief</span><b>→</b>
          <span><TerminalSquare /> Build</span><b>→</b>
          <span><CircleDot /> Preview</span><b>→</b>
          <span><ShieldCheck /> Approve</span><b>→</b>
          <span><Cloud /> Live</span>
        </div>
      </section>

      <Show when="signed-in"><LiveOnboarding /></Show>
      <Show when="signed-out"><OnboardingSection state={{
        clerk: false,
        imessage: false,
        chatgpt: false,
        github: false,
        cloudflare: false,
        convex: false,
      }} /></Show>

      <section id="ownership" className="ownership">
        <div className="ownership-card">
          <div>
            <p className="eyebrow">Built to leave the kitchen</p>
            <h2>The work is yours.<br /><i>Actually yours.</i></h2>
          </div>
          <div className="ownership-grid">
            <article><Github /><strong>Repository</strong><p>Created in your GitHub account with every commit visible.</p></article>
            <article><Sparkles /><strong>Model access</strong><p>Your connected ChatGPT account, with OpenRouter fallback.</p></article>
            <article><Cloud /><strong>Infrastructure</strong><p>Cloudflare and Convex resources provisioned for your project.</p></article>
            <article><ShieldCheck /><strong>Release control</strong><p>Preview freely. Production and rollback always need approval.</p></article>
          </div>
        </div>
      </section>

      <footer>
        <a className="brand" href="#top"><BrandMark /><span>iChef</span></a>
        <p>From “I have an idea” to live, without leaving Messages.</p>
        <span>Cooked with Pi · TanStack · Clerk · Convex · Cloudflare</span>
      </footer>
    </main>
  );
}

function LiveOnboarding() {
  const { user, isLoaded } = useUser();
  const { isAuthenticated } = useConvexAuth();
  const syncCurrent = useMutation(api.users.syncCurrent);
  const [syncState, setSyncState] = useState<"idle" | "syncing" | "ready" | "failed">("idle");
  const connections = useQuery(api.connections.listMine, syncState === "ready" ? {} : "skip");

  useEffect(() => {
    if (!isLoaded || !user || !isAuthenticated || syncState !== "idle") return;
    setSyncState("syncing");
    void syncCurrent({
      displayName: user.fullName ?? user.username ?? undefined,
      primaryEmail: user.primaryEmailAddress?.emailAddress,
      imageUrl: user.imageUrl,
    }).then(() => setSyncState("ready")).catch(() => setSyncState("failed"));
  }, [isAuthenticated, isLoaded, syncCurrent, syncState, user]);

  const connected = new Set(
    connections?.services.filter((service) => service.status === "connected").map((service) => service.provider) ?? [],
  );
  const state: OnboardingState = {
    clerk: Boolean(isAuthenticated),
    imessage: Boolean(connections?.imessage.some((connection) => connection.status === "verified")),
    chatgpt: connected.has("chatgpt"),
    github: connected.has("github"),
    cloudflare: connected.has("cloudflare"),
    convex: connected.has("convex"),
  };
  return <OnboardingSection state={state} loading={syncState === "syncing" || connections === undefined} />;
}

function OnboardingSection({ state, loading = false }: { state: OnboardingState; loading?: boolean }) {
  const readiness = useMemo(() => evaluateProjectReadiness(state), [state]);
  const openStep = (id: keyof OnboardingState) => {
    if (state[id]) return;
    if (id === "clerk") {
      window.location.assign("/sign-in");
      return;
    }
    window.location.assign(`/connect/${id}`);
  };

  return (
    <section id="onboarding" className="onboarding section-grid">
        <div className="section-copy">
          <p className="eyebrow">Your mise en place</p>
          <h2>Six connections.<br />Then start cooking.</h2>
          <p>
            No mystery credentials and no platform lock-in. iChef proves who is texting,
            then works through accounts you explicitly connect.
          </p>
          <div className="progress-copy">
            <span>{readiness.completed} of {readiness.total} ready</span>
            <strong>{readiness.percent}%</strong>
          </div>
          <div className="progress-track"><motion.span animate={{ width: `${readiness.percent}%` }} /></div>
        </div>
        <div className="steps-card">
          {onboardingSteps.map((step, index) => {
            const complete = state[step.id];
            const Icon = stepIcons[step.id];
            return (
              <button
                type="button"
                className={`setup-step ${complete ? "is-complete" : ""}`}
                key={step.id}
                onClick={() => openStep(step.id)}
                disabled={loading}
              >
                <span className="step-index">{complete ? <Check size={16} /> : String(index + 1).padStart(2, "0")}</span>
                <span className="step-icon"><Icon size={19} /></span>
                <span className="step-text"><small>{step.eyebrow}</small><strong>{step.title}</strong><em>{step.detail}</em></span>
                <span className="step-action">{complete ? "Connected" : step.action}<ArrowRight size={15} /></span>
              </button>
            );
          })}
          <AnimatePresence mode="wait">
            <motion.div
              key={String(readiness.ready)}
              className={`create-gate ${readiness.ready ? "is-ready" : ""}`}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            >
              <div>
                <small>{readiness.ready ? "Kitchen open" : "Project creation locked"}</small>
                <strong>{readiness.ready ? "What should we make first?" : `${readiness.next?.title ?? "Finish setup"} to continue`}</strong>
              </div>
              <Button disabled={!readiness.ready}>Create project <ArrowRight size={15} /></Button>
            </motion.div>
          </AnimatePresence>
        </div>
    </section>
  );
}
