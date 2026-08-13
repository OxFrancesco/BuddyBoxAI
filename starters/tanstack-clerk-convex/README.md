# iChef TanStack + Clerk + Convex starter

A small production-shaped web app template for sites created by iChef. It includes:

- TanStack Start with file-based routing and SSR
- Clerk request middleware, hosted sign-in/sign-up components, and a server-protected route
- Clerk-to-Convex JWT authentication through `ConvexProviderWithClerk`
- Convex schema and authenticated, owner-scoped project functions
- Tailwind CSS 4 plus shadcn-compatible aliases, tokens, and starter UI primitives
- strict TypeScript, focused policy/environment tests, and a production build

## Create the app

This directory is designed to be copied into a fresh sandbox rather than edited in place:

```bash
cp -R starters/tanstack-clerk-convex /workspace/my-site
cd /workspace/my-site
bun install
cp .env.example .env.local
```

iChef should then replace the product name and copy while preserving the authentication and ownership checks. Never copy a user's credentials into source files or generated Git history.

## Configure Clerk and Convex

1. Create or select a Clerk application.
2. In Clerk, add a JWT template named `convex`. Use Convex's Clerk integration template.
3. Put the Clerk publishable key and secret key in `.env.local`.
4. Run `bunx convex dev` and select or create the site's Convex project.
5. Put the emitted `VITE_CONVEX_URL` and `CONVEX_DEPLOYMENT` in `.env.local`.
6. Configure the Clerk issuer on the Convex deployment:

```bash
bunx convex env set CLERK_JWT_ISSUER_DOMAIN https://your-instance.clerk.accounts.dev
```

The issuer must match the Clerk instance that signs the `convex` template. Configure it separately for development and production deployments.

## Run and verify

Use separate terminals for the frontend and the reactive backend:

```bash
bunx convex dev
bun run dev
```

Before shipping:

```bash
bun run verify
bunx convex deploy
```

Run the production server locally after building:

```bash
bun run start
```

## Security boundaries

- `src/routes/_authenticated.tsx` protects `/dashboard` during server navigation.
- `convex/projects.ts` independently calls `ctx.auth.getUserIdentity()` on every data operation. A protected page is not a substitute for backend authorization.
- Projects are read through `by_owner_token_identifier`; no table scan or cross-user lookup is exposed.
- Only `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_CONVEX_URL` enter the browser bundle. `CLERK_SECRET_KEY` must remain server-only.
- `.env.local`, build output, and dependencies are ignored. iChef should run a secret scan before committing a generated repository.
- Convex functions use validated arguments and return values. Keep those validators when extending the API.

## Template extension points

- Add shadcn components with `bunx shadcn@latest add <component>`; `components.json` and `~/` aliases are ready.
- Add new owner-scoped indexes to `convex/schema.ts` before introducing queries. Prefer indexed reads with bounded `.take()` or pagination.
- Put external network calls in Convex actions and persist their results through internal mutations.
- Keep route groups that require authentication below `_authenticated`.

Generated files under `convex/_generated` and `src/routeTree.gen.ts` are committed so a newly copied sandbox can typecheck immediately. Convex and TanStack regenerate them during normal development.
