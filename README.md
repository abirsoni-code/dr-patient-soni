# Doctor-Patient Visit App

React + Vite PWA. No backend server — the app talks to Firebase directly
from the browser:

- **Firebase Authentication** handles login and registration
- **Cloud Firestore** stores everything else (profiles, appointments,
  prescriptions), read and written directly by the client, authorized by
  `firestore.rules`

Runs entirely on Firebase's free Spark plan — no Cloud Functions, no
Firebase Storage, no billing account required.

## Local development

```bash
npm install
npm run dev
```

To test against Firestore locally instead of the deployed project, use the
Firebase emulators:

```bash
firebase emulators:start --only firestore,auth
```

## Deploy

```bash
npm run build
firebase deploy --only hosting,firestore:rules
```
