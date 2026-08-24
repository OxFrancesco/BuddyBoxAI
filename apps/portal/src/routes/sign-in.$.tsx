import { SignIn } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { BrandMark } from "~/components/brand-mark";

export const Route = createFileRoute("/sign-in/$")({ component: SignInPage });

function SignInPage() {
  return (
    <main className="auth-page">
      <a className="brand" href="/" aria-label="BuddyBox home">
        <BrandMark />
        <span>BuddyBox</span>
      </a>
      <div className="auth-card">
        <p className="eyebrow">Google sign-in · secured by Clerk</p>
        <h1>Sign in to keep cooking.</h1>
        <p>Continue with Google. GitHub is connected separately later, only for repositories and code.</p>
        <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
      </div>
    </main>
  );
}
