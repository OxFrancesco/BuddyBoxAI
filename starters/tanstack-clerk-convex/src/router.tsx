import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: () => (
      <main className="grid min-h-screen place-items-center bg-slate-950 text-white">
        <div className="text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-sky-300">404</p>
          <h1 className="mt-3 text-4xl font-bold">Page not found</h1>
          <a className="mt-6 inline-block text-sky-300 hover:text-sky-200" href="/">
            Return home
          </a>
        </div>
      </main>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
