# Doctor-Patient Visit App

React + Vite PWA. Backend is a small JSON-based data store, run two ways
from the same shared logic in shared/dataEngine.cjs:

- Local dev: server/index.cjs (Express) reads/writes server/data/db.json
- Netlify: netlify/functions/api.js (same logic, using Netlify Blobs storage)

No Google account, no external service, no manual deployment steps required
for either environment.

See the setup instructions provided separately for exact run/deploy steps.
