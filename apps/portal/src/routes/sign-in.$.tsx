import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { BrandMark } from "~/components/brand-mark";

export const Route = createFileRoute("/sign-in/$")({ component: SignInPage });

function SignInPage() {
  return (
    <main className="auth-page">
      <a className="brand" href="/" aria-label="iChef home">
        <BrandMark />
        <span>iChef</span>
      </a>
      <div className="auth-card">
        <p className="eyebrow">Your kitchen, securely yours</p>
        <h1>Sign in to keep cooking.</h1>
        <p>Every iMessage command, repository, preview, and release stays bound to your identity.</p>
        <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
      </div>
    </main>
  );
}
