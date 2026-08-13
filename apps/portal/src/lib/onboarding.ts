export type OnboardingStepId =
  | "clerk"
  | "imessage"
  | "chatgpt"
  | "github"
  | "cloudflare"
  | "convex";

export type OnboardingState = Record<OnboardingStepId, boolean>;

export interface OnboardingStep {
  id: OnboardingStepId;
  eyebrow: string;
  title: string;
  detail: string;
  action: string;
}

export const onboardingSteps: readonly OnboardingStep[] = [
  {
    id: "clerk",
    eyebrow: "Identity",
    title: "Sign in securely",
    detail: "Clerk binds your account to every instruction and approval.",
    action: "Sign in with Clerk",
  },
  {
    id: "imessage",
    eyebrow: "Your line",
    title: "Prove iMessage",
    detail: "Send the one-time phrase back to iChef from the address you control.",
    action: "Verify this address",
  },
  {
    id: "chatgpt",
    eyebrow: "Your intelligence",
    title: "Connect ChatGPT",
    detail: "Use your own ChatGPT account through Pi's native Codex transport.",
    action: "Connect ChatGPT",
  },
  {
    id: "github",
    eyebrow: "Your source",
    title: "Connect GitHub",
    detail: "Every project starts in a repository that you own and can leave with.",
    action: "Install GitHub App",
  },
  {
    id: "cloudflare",
    eyebrow: "Your runtime",
    title: "Connect Cloudflare",
    detail: "Deploy previews and production Workers into infrastructure you control.",
    action: "Authorize Cloudflare",
  },
  {
    id: "convex",
    eyebrow: "Your backend",
    title: "Connect Convex",
    detail: "Provision the database and functions for each project in your Convex team.",
    action: "Authorize Convex",
  },
] as const;

export function evaluateProjectReadiness(state: OnboardingState) {
  const completed = onboardingSteps.filter((step) => state[step.id]).length;
  const next = onboardingSteps.find((step) => !state[step.id]) ?? null;

  return {
    ready: completed === onboardingSteps.length,
    completed,
    total: onboardingSteps.length,
    next,
    percent: Math.round((completed / onboardingSteps.length) * 100),
  };
}
