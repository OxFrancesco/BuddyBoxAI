import { SignIn } from "@clerk/tanstack-react-start";
import { Link, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in/$")({ component: SignInPage });

function SignInPage() {
  return (
    <main className="auth-shell">
      <Link to="/" className="auth-brand">Launchpad<span>.</span></Link>
      <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" fallbackRedirectUrl="/dashboard" />
    </main>
  );
}
