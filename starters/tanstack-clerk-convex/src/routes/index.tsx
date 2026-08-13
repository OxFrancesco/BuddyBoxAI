import { Show, UserButton } from "@clerk/tanstack-react-start";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Database, LockKeyhole, RouteIcon } from "lucide-react";

export const Route = createFileRoute("/")({ component: HomePage });

const stack = [
  { icon: RouteIcon, label: "TanStack Start", copy: "Typed routing and server functions." },
  { icon: LockKeyhole, label: "Clerk", copy: "Identity at every protected boundary." },
  { icon: Database, label: "Convex", copy: "Reactive data with indexed access." },
];

function HomePage() {
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link to="/" className="text-lg font-bold tracking-tight">
          Launchpad<span className="text-sky-400">.</span>
        </Link>
        <div className="flex items-center gap-3">
          <Show when="signed-out">
            <Link className="button-secondary-dark" to="/sign-in/$" params={{ _splat: "" }}>
              Sign in
            </Link>
          </Show>
          <Show when="signed-in">
            <Link className="button-secondary-dark" to="/dashboard">
              Dashboard
            </Link>
            <UserButton />
          </Show>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-12 px-6 pb-24 pt-20 lg:grid-cols-[1.25fr_0.75fr] lg:items-center">
        <div>
          <p className="eyebrow">iChef starter</p>
          <h1 className="mt-5 max-w-3xl text-5xl font-bold leading-[1.02] tracking-tight sm:text-7xl">
            A sharp foundation for your next idea.
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-8 text-slate-300">
            Authentication, protected data, and a polished responsive shell are already wired. Replace the product copy and start building the part only you can make.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Show when="signed-out">
              <Link className="button-primary" to="/sign-up/$" params={{ _splat: "" }}>
                Create an account <ArrowRight size={17} />
              </Link>
            </Show>
            <Show when="signed-in">
              <Link className="button-primary" to="/dashboard">
                Open dashboard <ArrowRight size={17} />
              </Link>
            </Show>
          </div>
        </div>

        <div className="grid gap-3" aria-label="Included stack">
          {stack.map(({ icon: Icon, label, copy }) => (
            <article className="rounded-2xl border border-slate-700 bg-slate-900 p-5" key={label}>
              <Icon className="text-sky-400" size={22} aria-hidden />
              <h2 className="mt-4 font-semibold">{label}</h2>
              <p className="mt-1 text-sm leading-6 text-slate-300">{copy}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
