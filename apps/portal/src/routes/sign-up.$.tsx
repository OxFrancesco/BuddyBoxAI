import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { BrandMark } from "~/components/brand-mark";

export const Route = createFileRoute("/sign-up/$")({ component: SignUpPage });

function SignUpPage() {
  return (
    <main className="auth-page">
      <a className="brand" href="/" aria-label="BuddyBox home">
        <BrandMark />
        <span>BuddyBox</span>
      </a>
      <div className="auth-card">
        <p className="eyebrow">Google sign-up · secured by Clerk</p>
        <h1>Open your BuddyBox kitchen.</h1>
        <p>Start with Google, then verify iMessage or X Chat and separately connect ChatGPT, GitHub, and Convex.</p>
        <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
      </div>
    </main>
  );
}
