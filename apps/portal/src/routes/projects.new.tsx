import { useUser } from "@clerk/tanstack-react-start";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useConvexAuth, useMutation } from "convex/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardCheck,
  Github,
  MessageCircleMore,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useState } from "react";

import { api } from "../../../../convex/_generated/api";
import { BrandMark } from "~/components/brand-mark";
import { Button } from "~/components/ui/button";
import {
  buildProjectProposal,
  PROJECT_BRIEF_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectProposalInput,
  validateProjectProposalInput,
} from "~/lib/project-proposal";

export const Route = createFileRoute("/projects/new")({ component: NewProject });

type FormErrors = Partial<Record<keyof ProjectProposalInput | "form", string>>;

function NewProject() {
  const { isLoaded, user } = useUser();
  const { isAuthenticated } = useConvexAuth();
  const syncCurrent = useMutation(api.users.syncCurrent);
  const propose = useMutation(api.projects.propose);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [status, setStatus] = useState<"idle" | "submitting" | "submitted">("idle");
  const [submitted, setSubmitted] = useState<{ name: string; expiresAt: number } | null>(null);

  if (isLoaded && !user) {
    return <Navigate to="/sign-in/$" params={{ _splat: "" }} />;
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "submitting") return;

    const validation = validateProjectProposalInput({ name, brief });
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    if (!user || !isAuthenticated) {
      setErrors({ form: "Your secure session is still loading. Try again in a moment." });
      return;
    }

    setErrors({});
    setStatus("submitting");
    try {
      await syncCurrent({
        displayName: user.fullName ?? user.username ?? undefined,
        primaryEmail: user.primaryEmailAddress?.emailAddress,
        imageUrl: user.imageUrl,
      });
      const payload = await buildProjectProposal(validation.value);
      await propose(payload);
      setSubmitted({ name: payload.name, expiresAt: payload.expiresAt });
      setStatus("submitted");
    } catch {
      setErrors({
        form: "iChef could not save this proposal. Check that every setup step is connected, then try again.",
      });
      setStatus("idle");
    }
  };

  return (
    <main className="proposal-page">
      <div className="proposal-ambient" />
      <header className="connect-nav proposal-nav">
        <Link className="brand" to="/"><BrandMark /><span>iChef</span><em>technical preview</em></Link>
        <span><ShieldCheck size={14} /> Clerk-authenticated proposal</span>
      </header>

      <section className="proposal-layout" aria-labelledby="proposal-heading">
        <div className="proposal-intro">
          <Link className="text-link proposal-back" to="/">
            <ArrowLeft size={14} /> Back to setup
          </Link>
          <p className="eyebrow">First project · mise en place</p>
          <h1 id="proposal-heading">Tell the kitchen what to <i>make.</i></h1>
          <p>
            This creates a reviewable Proposed Project—not a repository, website, or deployment.
            It is saved for the messaging approval workflow; live channel delivery is pending operator configuration.
          </p>
          <div className="proposal-ledger" aria-label="What happens next">
            <div><span>01</span><strong>Draft</strong><small>Name the product and describe its first useful version.</small></div>
            <div><span>02</span><strong>Confirm</strong><small>Once delivery is configured, approve the bound plan from verified iMessage or X Chat.</small></div>
            <div><span>03</span><strong>Provision</strong><small>Only then can iChef create source, backend, and a managed site.</small></div>
          </div>
        </div>

        <div className="proposal-card">
          {status === "submitted" && submitted ? (
            <div className="proposal-success" role="status">
              <span className="proposal-success__icon"><Check size={24} /></span>
              <p className="eyebrow">Awaiting approval</p>
              <h2>{submitted.name} is on the pass.</h2>
              <p>
                The proposal is saved until {new Date(submitted.expiresAt).toLocaleString()}.
                It is awaiting the messaging approval workflow; live channel delivery is still pending operator configuration.
              </p>
              <div className="proposal-truth-note">
                <ClipboardCheck size={18} />
                <span><strong>Nothing has been provisioned yet.</strong> No GitHub repository or live site exists for this proposal.</span>
              </div>
              <Button asChild size="lg"><Link to="/">Return to setup <ArrowRight size={16} /></Link></Button>
            </div>
          ) : (
            <form onSubmit={(event) => void submit(event)} noValidate>
              <div className="proposal-card__heading">
                <div>
                  <small>Proposal card</small>
                  <strong>One focused first course</strong>
                </div>
                <ClipboardCheck size={21} />
              </div>

              <label className="proposal-field">
                <span><strong>Project name</strong><small>{name.length} / {PROJECT_NAME_MAX_LENGTH}</small></span>
                <input
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={PROJECT_NAME_MAX_LENGTH}
                  placeholder="Field Notes"
                  autoComplete="off"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "project-name-error" : undefined}
                />
                {errors.name ? <em id="project-name-error">{errors.name}</em> : null}
              </label>

              <label className="proposal-field">
                <span><strong>What should it do?</strong><small>{brief.length.toLocaleString()} / {PROJECT_BRIEF_MAX_LENGTH.toLocaleString()}</small></span>
                <textarea
                  name="brief"
                  value={brief}
                  onChange={(event) => setBrief(event.target.value)}
                  maxLength={PROJECT_BRIEF_MAX_LENGTH}
                  rows={8}
                  placeholder="A calm, editorial field guide for seasonal ingredients. People can sign in, save notes, and browse by season…"
                  aria-invalid={Boolean(errors.brief)}
                  aria-describedby={errors.brief ? "project-brief-error" : "project-brief-help"}
                />
                {errors.brief
                  ? <em id="project-brief-error">{errors.brief}</em>
                  : <small id="project-brief-help">Describe the audience, essential actions, and the feeling you want.</small>}
              </label>

              <div className="proposal-recipe">
                <span><Github size={16} /> Your GitHub source</span>
                <span><ShieldCheck size={16} /> Clerk authentication</span>
                <span><MessageCircleMore size={16} /> Message-bound approval</span>
              </div>

              {errors.form ? <div className="connect-notice is-error" role="alert">{errors.form}</div> : null}
              <Button type="submit" size="lg" disabled={!isAuthenticated || status === "submitting"}>
                {status === "submitting" ? "Plating proposal…" : "Save for confirmation"}
                {status !== "submitting" ? <ArrowRight size={16} /> : null}
              </Button>
              <p className="proposal-disclaimer">
                Submission stores an awaiting-approval proposal for 23 hours. It does not authorize provisioning.
              </p>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
