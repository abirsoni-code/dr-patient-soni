// Firebase SDK initialization for the frontend.
import { initializeApp, deleteApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCEHhzEP8jtzPkre9Og-4LOgHVXFfDFDC4",
  authDomain: "dr-patient-b3b38.firebaseapp.com",
  projectId: "dr-patient-b3b38",
  storageBucket: "dr-patient-b3b38.firebasestorage.app",
  messagingSenderId: "204712074517",
  appId: "1:204712074517:web:08c9f7e434a1d35dbfdd1c",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);

// Creates a throwaway secondary Firebase App + Auth + Firestore instance.
// Used when a Swasthmitra agent creates a login account for a doctor/patient
// on their behalf: calling createUserWithEmailAndPassword on the PRIMARY
// auth instance would sign the agent out of their own session and into the
// new account. Running it on a separate app instance instead creates and
// signs in the new user there, leaving the agent's own primary session
// completely untouched. Call cleanup() when done to tear it down.
export function createSecondaryAuthSession() {
  const secondaryApp = initializeApp(firebaseConfig, `agent-create-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  const secondaryDb = getFirestore(secondaryApp);
  return {
    auth: secondaryAuth,
    db: secondaryDb,
    cleanup: () => deleteApp(secondaryApp).catch(() => {}),
  };
}
