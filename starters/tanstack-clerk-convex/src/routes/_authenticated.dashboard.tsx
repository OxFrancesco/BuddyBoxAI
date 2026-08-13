import { UserButton } from "@clerk/tanstack-react-start";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { LoaderCircle, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";

import { api } from "../../convex/_generated/api";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";

export const Route = createFileRoute("/_authenticated/dashboard")({ component: DashboardPage });

function DashboardPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const projects = useQuery(api.projects.list, isAuthenticated ? {} : "skip");
  const createProject = useMutation(api.projects.create);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || submitting) return;
    setSubmitting(true);
    try {
      await createProject({ name: nextName });
      setName("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-300 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="font-bold">Launchpad<span className="text-sky-600">.</span></Link>
          <UserButton />
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-12">
        <p className="eyebrow text-sky-700">Protected workspace</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight">Your projects</h1>
        <p className="mt-3 max-w-2xl text-slate-600">This page is guarded by Clerk on the server and every data operation is authorized again inside Convex.</p>

        <Card className="mt-8 p-5">
          <form className="flex flex-col gap-3 sm:flex-row" onSubmit={handleSubmit}>
            <label className="sr-only" htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              className="min-h-10 flex-1 rounded-xl border border-slate-400 px-3 outline-none focus:border-sky-600 focus:ring-2 focus:ring-sky-200"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="A new product"
              value={name}
            />
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? <LoaderCircle className="animate-spin" size={17} /> : <Plus size={17} />}
              Add project
            </Button>
          </form>
        </Card>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {isLoading || projects === undefined ? (
            <Card className="flex min-h-36 items-center justify-center p-6 text-slate-500">
              <LoaderCircle className="animate-spin" aria-label="Loading projects" />
            </Card>
          ) : projects.length === 0 ? (
            <Card className="p-6 sm:col-span-2 lg:col-span-3">
              <h2 className="font-semibold">Nothing here yet</h2>
              <p className="mt-2 text-sm text-slate-600">Create the first project to verify the authenticated realtime path end to end.</p>
            </Card>
          ) : (
            projects.map((project) => (
              <Card className="p-6" key={project._id}>
                <div className="flex items-center justify-between gap-4">
                  <h2 className="font-semibold">{project.name}</h2>
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">{project.status}</span>
                </div>
                <p className="mt-8 text-xs text-slate-500">Updated {new Date(project.updatedAt).toLocaleDateString()}</p>
              </Card>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
