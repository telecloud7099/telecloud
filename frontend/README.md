# TeleCloud — Frontend

React 19 + TypeScript + Vite SPA for TeleCloud.

📖 **Full project documentation lives in the [root README](../README.md)** — setup, architecture, API reference, everything.

## Quick commands

```bash
npm install        # install dependencies
npm run dev        # dev server with HMR on :5173 (proxies API → :5001)
npm run build      # production build → ../static/app/
npm run lint       # eslint
```

## Layout

```
src/
├── api/client.ts     # typed API layer (CSRF, 401 handling, all endpoints)
├── store/index.ts    # Zustand store
├── pages/            # Setup, Login, Dashboard, Consent, PrivacyPolicy
├── components/       # FileGrid, FolderGrid, Gallery, PreviewModal, UploadZone, …
└── hooks/            # useLazyLoad
```
