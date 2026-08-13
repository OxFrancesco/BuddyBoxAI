import { SignUp } from "@clerk/tanstack-react-start";
import { createFileRoute } from "@tanstack/react-router";

import { BrandMark } from "~/components/brand-mark";

export const Route = createFileRoute("/sign-up/$")({ component: SignUpPage });

function SignUpPage() {
  return (
    <main className="auth-page">
      <a className="brand" href="/" aria-label="iChef home">
        <BrandMark />
        <span>iChef</span>
      </a>
      <div className="auth-card">
        <p className="eyebrow">Invitation-only mise en place</p>
        <h1>Open your iChef kitchen.</h1>
        <p>Start with identity, then bind iMessage, ChatGPT, and GitHub before the first project.</p>
        <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
      </div>
    </main>
  );
}
