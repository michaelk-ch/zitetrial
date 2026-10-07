# Zitetrial

Next.js App Router project with React, strict TypeScript, ESLint, and CSS Modules.

## Development

Use Node.js 22 and npm. Install dependencies with `npm ci`, then run:

```sh
npm run dev
```

Open http://localhost:3000. Edit `src/app/page.tsx` to start building.

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

- `src/app/`: pages, layouts, styles, and server route handlers.
- `src/system-model/`: framework-independent Zod contract shared by the analyzer and viewer.
- `public/`: static assets.
- `next.config.ts`: Next.js configuration.
- `@/*`: import alias for `src/*`.

Keep local secrets in `.env.local` (ignored by Git). Commit dependencies through
`package.json` and `package-lock.json`; generated builds and `node_modules` are ignored.

Example checkouts live under `userdata/<project>/<sha>`. This directory is excluded
from this project's TypeScript and ESLint checks. See
[`src/system-model/README.md`](src/system-model/README.md) for the v1 contract.
