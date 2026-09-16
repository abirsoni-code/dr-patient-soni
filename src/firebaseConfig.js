// Firebase SDK initialization for the frontend.
// Not yet used by App.jsx — wired in during the Auth step of the migration.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

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
