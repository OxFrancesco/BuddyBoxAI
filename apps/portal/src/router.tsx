import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: () => (
      <main className="grid min-h-screen place-items-center bg-stone-950 text-stone-100">
        <div className="text-center">
          <p className="eyebrow">404 · Off menu</p>
          <h1 className="mt-3 text-4xl font-semibold">That dish isn't here.</h1>
          <a className="mt-6 inline-block text-lime-300" href="/">Return to iChef</a>
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
