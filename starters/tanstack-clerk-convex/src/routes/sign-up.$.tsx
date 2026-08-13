import { SignUp } from "@clerk/tanstack-react-start";
import { Link, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up/$")({ component: SignUpPage });

function SignUpPage() {
  return (
    <main className="auth-shell">
      <Link to="/" className="auth-brand">Launchpad<span>.</span></Link>
      <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" fallbackRedirectUrl="/dashboard" />
    </main>
  );
}
