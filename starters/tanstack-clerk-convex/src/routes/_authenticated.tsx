import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: ({ context, location }) => {
    if (!context.userId) {
      throw redirect({
        href: `/sign-in?redirect_url=${encodeURIComponent(location.href)}`,
      });
    }
  },
  component: () => <Outlet />,
});
