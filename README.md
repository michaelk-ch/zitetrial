# Zitetrial

Next.js App Router project with React, strict TypeScript, ESLint, and Tailwind CSS.

## Setup

Set `OPENAI_API_KEY` in `.env.local`

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
- `src/app/api/workspaces/[workspace]/snapshot`: one POST route that returns analysis and interpretation; analysis runs in a worker so it never blocks the server.
- `src/app/_components/`: shared viewer UI; `views/` holds the overview, graph, interpretation, raw, and table views. The workspace page fetches one snapshot with TanStack Query.
- `src/system-snapshot/`: shared Zod contracts in `system-model.ts`, `interpretation.ts`, and `index.ts`; server orchestration in `build.ts`, plus derived views in `inference/`.
- `src/analyzer/`: static repository analysis with a reusable function and JSON CLI.
- `src/interpreter/`: cached OpenAI interpretation of analyzed facts, with a reusable function and CLI.
- `public/`: static assets.
- `next.config.ts`: Next.js configuration.
- `@/*`: import alias for `src/*`.

Keep local secrets in `.env.local` (ignored by Git). Commit dependencies through
`package.json` and `package-lock.json`; generated builds and `node_modules` are ignored.

Example checkouts live under `userdata/<workspace>/<sha>`. This directory is excluded
from this project's TypeScript and ESLint checks. See
[`src/system-snapshot/README.md`](src/system-snapshot/README.md) for the v1 contract.

To add a repository, use **+ Import** in the sidebar and either:

- enter an HTTPS Git URL (e.g. `https://github.com/zite/grant-management`); the latest commit of the
  default branch is shallow-cloned with the server's Git credentials, without `.git`; or
- paste the Zite repository files API response (`{ "files": [{ "path", "content" }], "headSha" }`).
