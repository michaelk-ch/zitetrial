# Zitetrial

Next.js App Router project with React, strict TypeScript, ESLint, and Tailwind CSS.

## Development

Use Node.js 22 and npm. Install dependencies with `npm ci`, then run:

```sh
npm run dev
```

Open http://localhost:3000.

## Checks and production

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

`npm start` serves the production build; run `npm run build` first.

## Structure

- `src/app/`: routes only (layout, pages, `loading.tsx`, `not-found.tsx`) plus theme tokens in `globals.css`.
- `src/app/api/workspaces/[workspace]/model`: the only place the app runs the analyzer, in a worker thread so it never blocks the server; returns the system model JSON.
- `src/app/_components/`: shared viewer UI; `views/` holds the system views (overview, raw, CRUD) and their skeleton. The workspace page fetches the model from the API in the browser with TanStack Query.
- `src/system-model/`: framework-independent Zod contract shared by the analyzer and viewer, plus derived views in `inference/`.
- `src/analyzer/`: static repository analysis with a reusable function and JSON CLI.
- `public/`: static assets.
- `next.config.ts`: Next.js configuration.
- `@/*`: import alias for `src/*`.

Keep local secrets in `.env.local` (ignored by Git). Commit dependencies through
`package.json` and `package-lock.json`; generated builds and `node_modules` are ignored.

Example checkouts live under `userdata/<workspace>/<sha>`. This directory is excluded
from this project's TypeScript and ESLint checks. See
[`src/system-model/README.md`](src/system-model/README.md) for the v1 contract.

Run `npm run analyze -- userdata/<workspace>/<sha> model.json` to analyze a checkout.
See [`src/analyzer/README.md`](src/analyzer/README.md) for the API and supported patterns.
