import React, { useState, useEffect, useCallback, useMemo } from "react";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc, setDoc, writeBatch, collection, query, where, getDocs, deleteDoc, updateDoc, documentId } from "firebase/firestore";
import { auth, db } from "./firebaseConfig.js";

/**
 * ============================================================================
 * Doctor–Patient Visit App
 * ============================================================================
 * Backend: none — the app talks to Firebase directly from the browser.
 * Firebase Auth handles login/registration; Firestore (see firebaseConfig.js)
 * is read/written directly by the helper functions below, authorized by
 * firestore.rules. No server, no Cloud Functions, no Blaze plan required.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Design tokens
// ---------------------------------------------------------------------------
const COLORS = {
  ink: "#1B2321",
  teal: "#1B4B4A",
  tealDeep: "#123433",
  parchment: "#F7F4EE",
  parchmentDim: "#EFEAE0",
  clay: "#C1683A",
  clayDeep: "#A8532A",
  line: "#DAD3C4",
  lineDark: "#2E5E5C",
  good: "#3F7A5B",
  warn: "#B8863A",
  bad: "#B8452F",
  white: "#FFFFFF",
};

const FONT_DISPLAY = "'Source Serif 4', 'Georgia', serif";
const FONT_UI = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// ---------------------------------------------------------------------------
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// The real backend uses Firebase Authentication, which requires an email.
// Users only ever enter a username, so we derive a stable synthetic email
// from it — this keeps the existing username-based login UX unchanged
// while letting Firebase Auth own credentials (no passwords stored in our
// own database — see Step 3 of the Firebase migration).
function usernameToEmail(username) {
  return `${(username || "").trim().toLowerCase()}@dp-app.local`;
}

function friendlyAuthError(err) {
  const code = err && err.code;
  if (code === "auth/email-already-in-use") return "Username already taken";
  if (code === "auth/weak-password") return "Password should be at least 6 characters";
  if (code === "auth/invalid-email") return "Enter a valid username";
  if (code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-credential") {
    return "Invalid username or password";
  }
  return err.message || "Something went wrong. Please try again.";
}

// The public subset of a doctor's profile, mirrors what the old server-side
// listDoctors() action used to expose — kept in its own doctorDirectory/{uid}
// doc since Firestore rules can't redact individual fields of users/{uid}.
function doctorDirectoryFields(u) {
  return {
    userId: u.userId, name: u.name, surname: u.surname || "", photoUrl: u.photoUrl || "",
    city: u.city || "", area: u.area || "", opdTimings: u.opdTimings || "",
    specialization: u.specialization || "",
  };
}

// Writes users/{uid} and, for doctors, doctorDirectory/{uid} in one atomic
// batch, so a doctor's profile and their public directory entry never drift
// out of sync with each other.
async function writeUserProfile(uid, userDoc) {
  const batch = writeBatch(db);
  batch.set(doc(db, "users", uid), userDoc);
  if (userDoc.role === "Doctor") {
    batch.set(doc(db, "doctorDirectory", uid), doctorDirectoryFields(userDoc));
  }
  await batch.commit();
}

async function readUserProfile(uid, role) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists() || snap.data().role !== role) {
    throw new Error("No profile found for this account");
  }
  return snap.data();
}

function slotId(doctorId, date, time) {
  return `${doctorId}_${date}_${time}`;
}

async function listDoctorsDirect() {
  const snap = await getDocs(collection(db, "doctorDirectory"));
  return snap.docs.map((d) => d.data());
}

async function doctorAppointmentsDirect(doctorId, date) {
  const q = query(collection(db, "appointments"), where("doctorId", "==", doctorId), where("date", "==", date));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => d.data())
    .filter((a) => a.status !== "Cancelled")
    .sort((a, b) => (a.time > b.time ? 1 : -1));
}

async function patientAppointmentsDirect(patientId) {
  const q = query(collection(db, "appointments"), where("patientId", "==", patientId));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
}

// Books an appointment by writing appointments/{autoId} and slots/{doctorId_date_time}
// in one atomic batch. The slot doc's create rule requires it not already
// exist, so if two patients race for the same slot, only one batch commits —
// the loser gets a clear "slot just taken" error instead of a silent double-booking.
async function bookAppointmentDirect({ patientId, doctorId, patientName, doctorName, symptoms, date, time }) {
  const apptRef = doc(collection(db, "appointments"));
  const slotRef = doc(db, "slots", slotId(doctorId, date, time));
  const appt = {
    appointmentId: apptRef.id, patientId, doctorId,
    patientName: patientName || "", doctorName: doctorName || "",
    symptoms: symptoms || "", date, time, status: "Confirmed",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const batch = writeBatch(db);
  batch.set(apptRef, appt);
  batch.set(slotRef, { appointmentId: apptRef.id });
  try {
    await batch.commit();
  } catch {
    throw new Error("That slot was just booked by someone else — please pick another time.");
  }
  return appt;
}

async function rescheduleAppointmentDirect({ appointmentId, doctorId, oldDate, oldTime, date, time }) {
  const apptDateTime = new Date(oldDate + "T" + oldTime + ":00");
  const hoursUntilAppt = (apptDateTime - new Date()) / (1000 * 60 * 60);
  if (hoursUntilAppt < 24) {
    throw new Error("Cannot reschedule within 24 hours of the appointment");
  }
  const apptRef = doc(db, "appointments", appointmentId);
  const oldSlotRef = doc(db, "slots", slotId(doctorId, oldDate, oldTime));
  const newSlotRef = doc(db, "slots", slotId(doctorId, date, time));
  const batch = writeBatch(db);
  batch.update(apptRef, { date, time, status: "Rescheduled", updatedAt: new Date().toISOString() });
  batch.delete(oldSlotRef);
  batch.set(newSlotRef, { appointmentId });
  try {
    await batch.commit();
  } catch {
    throw new Error("That slot was just booked by someone else — please pick another time.");
  }
  return { date, time };
}

async function cancelAppointmentDirect({ appointmentId, doctorId, date, time }) {
  const apptRef = doc(db, "appointments", appointmentId);
  const oldSlotRef = doc(db, "slots", slotId(doctorId, date, time));
  const batch = writeBatch(db);
  batch.update(apptRef, { status: "Cancelled", updatedAt: new Date().toISOString() });
  batch.delete(oldSlotRef);
  await batch.commit();
}

// Prescriptions are split into two sibling docs per prescriptionId:
// - prescriptions/{id}: small metadata, cheap to list
// - prescriptionPhotos/{id}: the base64 photo, fetched only when "View" is clicked
// (the Firestore web SDK has no partial-field reads, so this split is what
// keeps listing cheap instead of downloading every photo just to show a list).
async function listPrescriptionsDirect(appointmentId) {
  const snap = await getDocs(collection(db, "appointments", appointmentId, "prescriptions"));
  return snap.docs.map((d) => d.data()).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
}

async function uploadPrescriptionDirect({ appointmentId, uploaderId, photoBase64, contentType, fileName }) {
  const prescriptionId = doc(collection(db, "appointments", appointmentId, "prescriptions")).id;
  const meta = {
    prescriptionId, uploaderId,
    fileName: fileName || "prescription.jpg",
    contentType: contentType || "image/jpeg",
    uploadedAt: new Date().toISOString(),
  };
  const batch = writeBatch(db);
  batch.set(doc(db, "appointments", appointmentId, "prescriptions", prescriptionId), meta);
  batch.set(doc(db, "appointments", appointmentId, "prescriptionPhotos", prescriptionId), {
    uploaderId, photoBase64, contentType: meta.contentType,
  });
  await batch.commit();
  return meta;
}

async function getPrescriptionPhotoDirect(appointmentId, prescriptionId) {
  const snap = await getDoc(doc(db, "appointments", appointmentId, "prescriptionPhotos", prescriptionId));
  if (!snap.exists()) throw new Error("Photo not found");
  return snap.data();
}

async function deletePrescriptionDirect(appointmentId, prescriptionId) {
  const batch = writeBatch(db);
  batch.delete(doc(db, "appointments", appointmentId, "prescriptions", prescriptionId));
  batch.delete(doc(db, "appointments", appointmentId, "prescriptionPhotos", prescriptionId));
  await batch.commit();
}

// slots/{doctorId_date_time} is openly readable (see firestore.rules), unlike
// appointments (participant-only) — so the "grey out already-booked slots"
// UI check reads from slots, not appointments. A patient browsing a doctor's
// calendar isn't a participant on other patients' appointment docs, so
// querying appointments directly would silently under-report taken slots.
async function takenTimesDirect(doctorId, date) {
  const prefix = `${doctorId}_${date}_`;
  const q = query(
    collection(db, "slots"),
    where(documentId(), ">=", prefix),
    where(documentId(), "<", prefix + "\uf8ff")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.id.slice(prefix.length));
}

// The backend (both mock and real) returns appointment fields in lowerCamelCase
// (appointmentId, patientName, date, ...). The UI components below were written
// against a capitalized shape (AppointmentID, PatientName, Date, ...) — this maps
// list results from doctorAppointments/patientAppointments into that shape so
// dates, names, and IDs actually render instead of coming through as undefined.
function toApptView(a) {
  return {
    AppointmentID: a.appointmentId,
    DoctorID: a.doctorId,
    PatientID: a.patientId,
    DoctorName: a.doctorName,
    PatientName: a.patientName,
    Symptoms: a.symptoms,
    Date: a.date,
    Time: a.time,
    Status: a.status,
    Prescriptions: a.prescriptions || [],
  };
}

// ---------------------------------------------------------------------------
// Small UI primitives
// ---------------------------------------------------------------------------

function IconUser({ size = 18, color = COLORS.teal }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="4" stroke={color} strokeWidth="1.6" />
      <path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function IconStethoscope({ size = 18, color = COLORS.teal }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M5 3v6a4 4 0 0 0 8 0V3" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9 13v2a5 5 0 0 0 10 0v-2.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="19" cy="9.5" r="2" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}
function IconCalendar({ size = 16, color = COLORS.teal }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3.5" y="5" width="17" height="15" rx="2" stroke={color} strokeWidth="1.6" />
      <path d="M3.5 9.5h17M8 3v3.5M16 3v3.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function IconClock({ size = 16, color = COLORS.teal }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.5" stroke={color} strokeWidth="1.6" />
      <path d="M12 7.5V12l3 2" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function IconArrowLeft({ size = 18, color = COLORS.ink }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M15 5l-7 7 7 7" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconCheck({ size = 22, color = COLORS.white }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 12.5l5 5L20 6" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Field({ label, required, children }) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.tealDeep, marginBottom: 6, letterSpacing: 0.2 }}>
        {label} {required && <span style={{ color: COLORS.clay }}>*</span>}
      </div>
      {children}
    </label>
  );
}

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "12px 14px",
  fontSize: 15,
  fontFamily: FONT_UI,
  border: `1.5px solid ${COLORS.line}`,
  borderRadius: 10,
  background: COLORS.white,
  color: COLORS.ink,
  outline: "none",
};

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, "0");
  const m = i % 2 === 0 ? "00" : "30";
  return `${h}:${m}`;
});

function opdTimingsToSessions(str) {
  const sessions = (str || "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [start, end] = r.split("-").map((s) => s.trim());
      return { start: start || "09:00", end: end || "11:00" };
    });
  return sessions.length > 0 ? sessions : [{ start: "09:00", end: "11:00" }];
}
function sessionsToOpdTimings(sessions) {
  return sessions
    .filter((s) => s.start && s.end)
    .map((s) => `${s.start}-${s.end}`)
    .join(", ");
}

function OpdTimingsInput({ value, onChange }) {
  const [sessions, setSessions] = useState(() => opdTimingsToSessions(value));

  useEffect(() => {
    if (!value) onChange(sessionsToOpdTimings(sessions));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(next) {
    setSessions(next);
    onChange(sessionsToOpdTimings(next));
  }
  function updateSession(i, field, val) {
    const next = sessions.map((s, idx) => (idx === i ? { ...s, [field]: val } : s));
    update(next);
  }
  function addSession() {
    update([...sessions, { start: "17:00", end: "19:00" }]);
  }
  function removeSession(i) {
    update(sessions.filter((_, idx) => idx !== i));
  }

  return (
    <div>
      {sessions.map((s, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <select value={s.start} onChange={(e) => updateSession(i, "start", e.target.value)} style={{ ...inputStyle, appearance: "auto", flex: 1 }}>
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <span style={{ color: "#6B7A76", fontSize: 13 }}>to</span>
          <select value={s.end} onChange={(e) => updateSession(i, "end", e.target.value)} style={{ ...inputStyle, appearance: "auto", flex: 1 }}>
            {TIME_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          {sessions.length > 1 && (
            <button type="button" onClick={() => removeSession(i)} style={{ border: "none", background: "none", color: "#B5533C", fontSize: 13, cursor: "pointer", padding: "4px 6px" }}>
              Remove
            </button>
          )}
        </div>
      ))}
      <button type="button" onClick={addSession} style={{ border: `1px dashed ${COLORS.line}`, background: "none", color: COLORS.teal, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "6px 10px", borderRadius: 8 }}>
        + Add another OPD session
      </button>
    </div>
  );
}

function PhotoUploadInput({ value, onChange, size = 72 }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputId = useMemo(() => `photo-upload-${Math.random().toString(36).slice(2)}`, []);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const { base64, contentType } = await compressImageFile(file, 480, 0.75);
      onChange(`data:${contentType};base64,${base64}`);
    } catch (err) {
      setError(err.message || "Could not process photo");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: size, height: size, borderRadius: "50%", background: COLORS.parchmentDim,
            border: `1.5px solid ${COLORS.line}`, display: "flex", alignItems: "center", justifyContent: "center",
            overflow: "hidden", flexShrink: 0,
          }}
        >
          {value ? (
            <img src={value} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <IconUser size={Math.round(size * 0.45)} color={COLORS.teal} />
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label
            htmlFor={inputId}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px dashed ${COLORS.line}`, borderRadius: 8, padding: "7px 12px", fontSize: 12.5, fontWeight: 600, color: COLORS.teal, cursor: "pointer" }}
          >
            {busy ? "Uploading…" : value ? "Change photo" : "Upload photo"}
          </label>
          <input id={inputId} type="file" accept="image/*" capture="user" onChange={handleFile} disabled={busy} style={{ display: "none" }} />
          {value && (
            <button type="button" onClick={() => onChange("")} style={{ border: "none", background: "none", color: COLORS.bad, fontSize: 12, fontWeight: 600, cursor: "pointer", textAlign: "left", padding: 0 }}>
              Remove photo
            </button>
          )}
        </div>
      </div>
      {error && <div style={{ fontSize: 12, color: COLORS.bad, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

function TextInput(props) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      {...props}
      onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
      style={{
        ...inputStyle,
        borderColor: focused ? COLORS.teal : COLORS.line,
        boxShadow: focused ? `0 0 0 3px ${COLORS.teal}22` : "none",
        ...(props.style || {}),
      }}
    />
  );
}

function Button({ children, onClick, variant = "primary", disabled, style, type = "button", full }) {
  const base = {
    fontFamily: FONT_UI,
    fontSize: 14.5,
    fontWeight: 600,
    padding: "13px 20px",
    borderRadius: 10,
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    transition: "transform 0.08s ease, opacity 0.15s ease",
    width: full ? "100%" : "auto",
    letterSpacing: 0.1,
  };
  const variants = {
    primary: { background: COLORS.teal, color: COLORS.white },
    clay: { background: COLORS.clay, color: COLORS.white },
    ghost: { background: "transparent", color: COLORS.teal, border: `1.5px solid ${COLORS.teal}` },
    subtle: { background: COLORS.parchmentDim, color: COLORS.ink },
    danger: { background: "transparent", color: COLORS.bad, border: `1.5px solid ${COLORS.bad}55` },
  };
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.transform = "scale(0.98)"; }}
      onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {children}
    </button>
  );
}

function StatusPill({ status }) {
  const map = {
    Confirmed: { bg: `${COLORS.good}18`, fg: COLORS.good },
    Rescheduled: { bg: `${COLORS.warn}18`, fg: COLORS.warn },
    Cancelled: { bg: `${COLORS.bad}18`, fg: COLORS.bad },
  };
  const c = map[status] || map.Confirmed;
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color: c.fg,
        background: c.bg,
        padding: "4px 9px",
        borderRadius: 999,
      }}
    >
      {status}
    </span>
  );
}

function Banner({ text, tone = "error", onClose }) {
  const tones = {
    error: { bg: "#FBEAE5", fg: COLORS.bad, border: "#F0C9BC" },
    info: { bg: "#EAF2F0", fg: COLORS.tealDeep, border: "#CFE0DC" },
  };
  const t = tones[tone];
  return (
    <div
      style={{
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.fg,
        fontSize: 13.5,
        padding: "11px 14px",
        borderRadius: 10,
        marginBottom: 16,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
      }}
    >
      <span>{text}</span>
      {onClose && (
        <button onClick={onClose} style={{ background: "none", border: "none", color: t.fg, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>
          ×
        </button>
      )}
    </div>
  );
}

function Spinner({ color = COLORS.white, size = 16 }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: `2px solid ${color}55`,
        borderTopColor: color,
        borderRadius: "50%",
        animation: "dp-spin 0.7s linear infinite",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Screen: Landing / Role select
// ---------------------------------------------------------------------------
function RoleSelectScreen({ onSelect }) {
  return (
    <div style={{ padding: "0 24px" }}>
      <div style={{ textAlign: "center", padding: "48px 0 32px" }}>
        <div
          style={{
            width: 56, height: 56, margin: "0 auto 18px", borderRadius: 16,
            background: COLORS.teal, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <IconStethoscope size={28} color={COLORS.white} />
        </div>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 15, color: COLORS.clay, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>
          The Visit Ledger
        </div>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 30, fontWeight: 600, color: COLORS.ink, margin: 0, lineHeight: 1.25 }}>
          One record, every visit,
          <br />both sides of the table.
        </h1>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <RoleCard
          role="Patient"
          title="I'm a Patient"
          desc="Book, view, and reschedule your appointments."
          icon={<IconUser size={22} color={COLORS.white} />}
          onClick={() => onSelect("Patient")}
        />
        <RoleCard
          role="Doctor"
          title="I'm a Doctor"
          desc="See your day's patient list at a glance."
          icon={<IconStethoscope size={22} color={COLORS.white} />}
          onClick={() => onSelect("Doctor")}
        />
      </div>

      <div
        style={{
          marginTop: 28, fontSize: 12, color: COLORS.good, background: `${COLORS.good}12`,
          border: `1px solid ${COLORS.good}33`, borderRadius: 10, padding: "10px 14px",
        }}
      >
        Welcome to Dr Patient Connect App
      </div>
    </div>
  );
}

function RoleCard({ title, desc, icon, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", alignItems: "center", gap: 16, textAlign: "left",
        background: COLORS.white, border: `1.5px solid ${hover ? COLORS.teal : COLORS.line}`,
        borderRadius: 14, padding: "18px 18px", cursor: "pointer",
        boxShadow: hover ? `0 6px 20px ${COLORS.teal}1a` : "0 1px 2px rgba(0,0,0,0.03)",
        transition: "all 0.15s ease", fontFamily: FONT_UI,
      }}
    >
      <div style={{ width: 46, height: 46, borderRadius: 12, background: COLORS.teal, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.ink }}>{title}</div>
        <div style={{ fontSize: 13, color: "#6B7A76", marginTop: 2 }}>{desc}</div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Screen: Login
// ---------------------------------------------------------------------------
function LoginScreen({ role, onBack, onLogin, onGoRegister }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!username || !password) {
      setError("Enter your username and password.");
      return;
    }
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
      const profile = await readUserProfile(cred.user.uid, role);
      onLogin(profile);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: "0 24px" }}>
      <TopNav onBack={onBack} label={`${role} Login`} />
      <div style={{ padding: "8px 0 24px" }}>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 26, color: COLORS.ink, margin: "8px 0 4px" }}>
          Welcome back
        </h1>
        <p style={{ fontSize: 13.5, color: "#6B7A76", margin: 0 }}>
          Sign in as a {role.toLowerCase()} to continue.
        </p>
      </div>

      {error && <Banner text={error} tone="error" onClose={() => setError("")} />}

      <form onSubmit={submit}>
        <Field label="Username" required>
          <TextInput value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. rohan.m" autoCapitalize="none" />
        </Field>
        <Field label="Password" required>
          <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        <Button type="submit" full disabled={loading} style={{ marginTop: 6 }}>
          {loading ? <Spinner /> : "Log in"}
        </Button>
      </form>

      <div style={{ textAlign: "center", marginTop: 20, fontSize: 13.5, color: "#6B7A76" }}>
        New here?{" "}
        <span style={{ color: COLORS.clay, fontWeight: 700, cursor: "pointer" }} onClick={onGoRegister}>
          Create an account
        </span>
      </div>
    </div>
  );
}

function TopNav({ onBack, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "18px 0 6px" }}>
      <button
        onClick={onBack}
        style={{ background: COLORS.parchmentDim, border: "none", borderRadius: 9, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
      >
        <IconArrowLeft />
      </button>
      <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: COLORS.tealDeep }}>
        {label}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen: Registration
// ---------------------------------------------------------------------------
function RegisterScreen({ role, onBack, onRegistered, onGoLogin }) {
  const [form, setForm] = useState({
    name: "", surname: "", address: "", mobile: "", photoUrl: "", username: "", password: "",
    city: "", area: "", opdTimings: "", specialization: "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!form.name || !form.mobile || !form.username || !form.password) {
      setError("Name, mobile number, username and password are required.");
      return;
    }
    if (!/^[0-9+\-\s]{7,15}$/.test(form.mobile)) {
      setError("Enter a valid mobile number.");
      return;
    }
    if (role === "Doctor" && (!form.city || !form.area || !form.opdTimings || !form.specialization)) {
      setError("City, area, specialization and OPD timings are required for doctors.");
      return;
    }
    setLoading(true);
    try {
      const { password, ...profileFields } = form;
      const cred = await createUserWithEmailAndPassword(auth, usernameToEmail(form.username), password);
      const userDoc = { userId: cred.user.uid, role, createdAt: new Date().toISOString(), ...profileFields };
      try {
        await writeUserProfile(cred.user.uid, userDoc);
      } catch (writeErr) {
        // Profile write failed after the Auth account was created — remove
        // the orphaned Auth account rather than leave a login with no profile.
        await cred.user.delete().catch(() => {});
        throw writeErr;
      }
      onRegistered(userDoc);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: "0 24px 32px" }}>
      <TopNav onBack={onBack} label={`${role} Registration`} />
      <div style={{ padding: "8px 0 20px" }}>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 26, color: COLORS.ink, margin: "8px 0 4px" }}>
          Create your account
        </h1>
        <p style={{ fontSize: 13.5, color: "#6B7A76", margin: 0 }}>
          One-time setup. Takes under a minute.
        </p>
      </div>

      {error && <Banner text={error} tone="error" onClose={() => setError("")} />}

      <form onSubmit={submit}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label="First name" required>
              <TextInput value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Rohan" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Surname">
              <TextInput value={form.surname} onChange={(e) => set("surname", e.target.value)} placeholder="Mehta" />
            </Field>
          </div>
        </div>

        <Field label="Address">
          <TextInput value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Street, City" />
        </Field>

        {role === "Doctor" && (
          <>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <Field label="City" required>
                  <TextInput value={form.city} onChange={(e) => set("city", e.target.value)} placeholder="Pune" />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Area" required>
                  <TextInput value={form.area} onChange={(e) => set("area", e.target.value)} placeholder="Baner" />
                </Field>
              </div>
            </div>
            <Field label="Specialization" required>
              <TextInput value={form.specialization} onChange={(e) => set("specialization", e.target.value)} placeholder="e.g. Cardiologist, General Physician" />
            </Field>
            <Field label="OPD timings" required>
              <OpdTimingsInput
                value={form.opdTimings}
                onChange={(val) => set("opdTimings", val)}
              />
            </Field>
          </>
        )}

        <Field label="Mobile number" required>
          <TextInput value={form.mobile} onChange={(e) => set("mobile", e.target.value)} placeholder="98765 00000" inputMode="tel" />
        </Field>

        <Field label="Photo (optional)">
          <PhotoUploadInput value={form.photoUrl} onChange={(val) => set("photoUrl", val)} />
        </Field>

        <div style={{ height: 1, background: COLORS.line, margin: "6px 0 20px" }} />

        <Field label="Username" required>
          <TextInput value={form.username} onChange={(e) => set("username", e.target.value)} placeholder="Choose a username" autoCapitalize="none" />
        </Field>
        <Field label="Password" required>
          <TextInput type="password" value={form.password} onChange={(e) => set("password", e.target.value)} placeholder="Choose a password" />
        </Field>

        <Button type="submit" full disabled={loading} style={{ marginTop: 6 }}>
          {loading ? <Spinner /> : `Register as ${role}`}
        </Button>
      </form>

      <div style={{ textAlign: "center", marginTop: 20, fontSize: 13.5, color: "#6B7A76" }}>
        Already registered?{" "}
        <span style={{ color: COLORS.clay, fontWeight: 700, cursor: "pointer" }} onClick={onGoLogin}>
          Log in
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen: Edit Profile
// ---------------------------------------------------------------------------
function EditProfileScreen({ user, onBack, onSaved }) {
  const [form, setForm] = useState({
    name: user.name || "", surname: user.surname || "", address: user.address || "",
    mobile: user.mobile || "", photoUrl: user.photoUrl || "",
    city: user.city || "", area: user.area || "", opdTimings: user.opdTimings || "",
    specialization: user.specialization || "",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!form.name || !form.mobile) {
      setError("Name and mobile number are required.");
      return;
    }
    if (!/^[0-9+\-\s]{7,15}$/.test(form.mobile)) {
      setError("Enter a valid mobile number.");
      return;
    }
    if (user.role === "Doctor" && (!form.city || !form.area || !form.opdTimings || !form.specialization)) {
      setError("City, area, specialization and OPD timings are required for doctors.");
      return;
    }
    setLoading(true);
    try {
      const updated = { ...user, ...form };
      await writeUserProfile(user.userId, updated);
      onSaved(updated);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: "0 24px 32px" }}>
      <TopNav onBack={onBack} label="Edit Profile" />
      <div style={{ padding: "8px 0 20px" }}>
        <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 26, color: COLORS.ink, margin: "8px 0 4px" }}>
          Your details
        </h1>
        <p style={{ fontSize: 13.5, color: "#6B7A76", margin: 0 }}>
          Update your profile information.
        </p>
      </div>

      {error && <Banner text={error} tone="error" onClose={() => setError("")} />}

      <form onSubmit={submit}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label="First name" required>
              <TextInput value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Rohan" />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Surname">
              <TextInput value={form.surname} onChange={(e) => set("surname", e.target.value)} placeholder="Mehta" />
            </Field>
          </div>
        </div>

        <Field label="Address">
          <TextInput value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="Street, City" />
        </Field>

        {user.role === "Doctor" && (
          <>
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <Field label="City" required>
                  <TextInput value={form.city} onChange={(e) => set("city", e.target.value)} placeholder="Pune" />
                </Field>
              </div>
              <div style={{ flex: 1 }}>
                <Field label="Area" required>
                  <TextInput value={form.area} onChange={(e) => set("area", e.target.value)} placeholder="Baner" />
                </Field>
              </div>
            </div>
            <Field label="Specialization" required>
              <TextInput value={form.specialization} onChange={(e) => set("specialization", e.target.value)} placeholder="e.g. Cardiologist, General Physician" />
            </Field>
            <Field label="OPD timings" required>
              <OpdTimingsInput value={form.opdTimings} onChange={(val) => set("opdTimings", val)} />
            </Field>
          </>
        )}

        <Field label="Mobile number" required>
          <TextInput value={form.mobile} onChange={(e) => set("mobile", e.target.value)} placeholder="98765 00000" inputMode="tel" />
        </Field>

        <Field label="Photo (optional)">
          <PhotoUploadInput value={form.photoUrl} onChange={(val) => set("photoUrl", val)} />
        </Field>

        <Button type="submit" full disabled={loading} style={{ marginTop: 6 }}>
          {loading ? <Spinner /> : "Save changes"}
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Doctor Dashboard
// ---------------------------------------------------------------------------
function DoctorDashboard({ user, onLogout, onEditProfile }) {
  const [date, setDate] = useState(todayISO());
  const [appts, setAppts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await doctorAppointmentsDirect(user.userId, date);
      setAppts(data.map(toApptView));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [user.userId, date]);

  useEffect(() => { load(); }, [load]);

  function shiftDate(days) {
    const d = new Date(date + "T00:00:00");
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    setDate(`${y}-${m}-${day}`);
  }

  const dateLabel = useMemo(() => {
    const d = new Date(date + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  }, [date]);

  return (
    <div>
      <Header user={user} onLogout={onLogout} onEditProfile={onEditProfile} subtitle="Doctor" />

      <div style={{ padding: "0 24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "18px 0 4px" }}>
          <button onClick={() => shiftDate(-1)} style={navArrowStyle}>‹</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 19, color: COLORS.ink, fontWeight: 600 }}>{dateLabel}</div>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ border: "none", background: "none", fontSize: 11.5, color: COLORS.clay, fontWeight: 600, cursor: "pointer" }}
            />
          </div>
          <button onClick={() => shiftDate(1)} style={navArrowStyle}>›</button>
        </div>

        <div style={{ fontSize: 12.5, color: "#6B7A76", margin: "14px 0 12px", fontWeight: 600, letterSpacing: 0.3 }}>
          {loading ? "Loading…" : `${appts.length} appointment${appts.length !== 1 ? "s" : ""} today`}
        </div>

        {error && <Banner text={error} tone="error" onClose={() => setError("")} />}

        {loading ? (
          <LoadingList />
        ) : appts.length === 0 ? (
          <EmptyState
            title="No appointments"
            desc={`Nothing on the books for ${dateLabel.split(",")[0]}.`}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 32 }}>
            {appts.map((a) => (
              <PatientEntry key={a.AppointmentID} appt={a} currentUserId={user.userId} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const navArrowStyle = {
  width: 36, height: 36, borderRadius: 10, border: `1.5px solid ${COLORS.line}`,
  background: COLORS.white, fontSize: 20, color: COLORS.teal, cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1,
};

// ---------------------------------------------------------------------------
// Prescription photo upload/view (shared by doctor + patient appointment views)
// ---------------------------------------------------------------------------
function compressImageFile(file, maxDim = 1280, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      img.onerror = () => reject(new Error("Could not read image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({ base64: dataUrl.split(",")[1], contentType: "image/jpeg" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function PrescriptionSection({ appointmentId, currentUserId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(null); // { photoBase64, contentType, fileName } | null
  const [viewLoadingId, setViewLoadingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listPrescriptionsDirect(appointmentId);
      setItems(list);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [appointmentId, currentUserId]);

  useEffect(() => { load(); }, [load]);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    setUploading(true);
    try {
      const { base64, contentType } = await compressImageFile(file);
      await uploadPrescriptionDirect({
        appointmentId, uploaderId: currentUserId,
        photoBase64: base64, contentType, fileName: file.name,
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function view(item) {
    setViewLoadingId(item.prescriptionId);
    setError("");
    try {
      const blob = await getPrescriptionPhotoDirect(appointmentId, item.prescriptionId);
      setViewing({ ...blob, fileName: item.fileName });
    } catch (err) {
      setError(err.message);
    } finally {
      setViewLoadingId(null);
    }
  }

  async function remove(item) {
    try {
      await deletePrescriptionDirect(appointmentId, item.prescriptionId);
      setItems((prev) => prev.filter((p) => p.prescriptionId !== item.prescriptionId));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: "#6B7A76", fontWeight: 700, marginBottom: 6 }}>
        Prescriptions
      </div>

      {error && <Banner text={error} tone="error" onClose={() => setError("")} />}

      {loading ? (
        <div style={{ fontSize: 12.5, color: "#9AA6A2" }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 12.5, color: "#9AA6A2", marginBottom: 8 }}>No prescription photos yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
          {items.map((item) => (
            <div key={item.prescriptionId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: COLORS.parchmentDim, borderRadius: 8, padding: "7px 10px" }}>
              <span style={{ fontSize: 12.5, color: COLORS.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>
                {item.fileName}
              </span>
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" onClick={() => view(item)} style={{ border: "none", background: "none", color: COLORS.teal, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
                  {viewLoadingId === item.prescriptionId ? "…" : "View"}
                </button>
                {item.uploaderId === currentUserId && (
                  <button type="button" onClick={() => remove(item)} style={{ border: "none", background: "none", color: COLORS.bad, fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <label style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px dashed ${COLORS.line}`, borderRadius: 8, padding: "7px 12px", fontSize: 12.5, fontWeight: 600, color: COLORS.teal, cursor: "pointer" }}>
        {uploading ? "Uploading…" : "+ Upload prescription photo"}
        <input type="file" accept="image/*" capture="environment" onChange={handleFile} disabled={uploading} style={{ display: "none" }} />
      </label>

      {viewing && (
        <div
          onClick={() => setViewing(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 24 }}
        >
          <img
            src={`data:${viewing.contentType};base64,${viewing.photoBase64}`}
            alt={viewing.fileName || "Prescription"}
            style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 10, boxShadow: "0 8px 30px rgba(0,0,0,0.4)" }}
          />
        </div>
      )}
    </div>
  );
}

function PatientEntry({ appt, currentUserId }) {
  return (
    <div
      style={{
        background: COLORS.white, border: `1.5px solid ${COLORS.line}`, borderLeft: `4px solid ${COLORS.teal}`,
        borderRadius: 12, padding: "16px 16px", display: "flex", flexDirection: "column", gap: 8,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", background: COLORS.parchmentDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <IconUser size={17} />
          </div>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: COLORS.ink, fontFamily: FONT_UI }}>
            {appt.PatientName || "Patient"}
          </div>
        </div>
        <StatusPill status={appt.Status} />
      </div>
      <div style={{ fontSize: 13.5, color: "#4B5A56", lineHeight: 1.5, paddingLeft: 46 }}>
        {appt.Symptoms || <em style={{ color: "#9AA6A2" }}>No symptoms noted</em>}
      </div>
      <div style={{ display: "flex", gap: 16, paddingLeft: 46, marginTop: 2 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: COLORS.tealDeep, fontWeight: 600 }}>
          <IconCalendar size={14} /> {appt.Date}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: COLORS.tealDeep, fontWeight: 600 }}>
          <IconClock size={14} /> {appt.Time}
        </span>
      </div>
      <div style={{ paddingLeft: 46, marginTop: 4 }}>
        <PrescriptionSection appointmentId={appt.AppointmentID} currentUserId={currentUserId} />
      </div>
    </div>
  );
}

function LoadingList() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ height: 92, borderRadius: 12, background: COLORS.parchmentDim, position: "relative", overflow: "hidden" }}>
          <div className="dp-shimmer" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, desc, action }) {
  return (
    <div style={{ textAlign: "center", padding: "40px 16px", border: `1.5px dashed ${COLORS.line}`, borderRadius: 14 }}>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 17, color: COLORS.ink, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: "#6B7A76", marginBottom: action ? 16 : 0 }}>{desc}</div>
      {action}
    </div>
  );
}

function Header({ user, onLogout, onEditProfile, subtitle }) {
  return (
    <div style={{ background: COLORS.teal, padding: "20px 24px 24px", color: COLORS.white, borderRadius: "0 0 22px 22px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: "#AFCFC9", fontWeight: 700 }}>
          {subtitle}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onEditProfile}
            style={{ background: "rgba(255,255,255,0.12)", border: "none", color: COLORS.white, fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer" }}
          >
            Edit Profile
          </button>
          <button
            onClick={onLogout}
            style={{ background: "rgba(255,255,255,0.12)", border: "none", color: COLORS.white, fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer" }}
          >
            Log out
          </button>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {user.photoUrl ? (
            <img src={user.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <IconUser size={22} color={COLORS.white} />
          )}
        </div>
        <div>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 600 }}>
            {subtitle === "Doctor" ? "Dr. " : ""}{user.name} {user.surname}
          </div>
          <div style={{ fontSize: 12, color: "#CFE3DF" }}>{user.mobile}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Patient Dashboard
// ---------------------------------------------------------------------------
function PatientDashboard({ user, onLogout, onEditProfile }) {
  const [tab, setTab] = useState("appointments"); // appointments | book
  const [appts, setAppts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmedAppt, setConfirmedAppt] = useState(null);
  const [rescheduling, setRescheduling] = useState(null); // appt being rescheduled

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await patientAppointmentsDirect(user.userId);
      setAppts(data.map(toApptView));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [user.userId]);

  useEffect(() => { load(); }, [load]);

  function handleBooked(appt) {
    setConfirmedAppt(appt);
    setRescheduling(null);
    setTab("appointments");
    load();
  }

  if (confirmedAppt) {
    return (
      <ConfirmationScreen
        appt={confirmedAppt}
        onDone={() => setConfirmedAppt(null)}
      />
    );
  }

  return (
    <div>
      <Header user={user} onLogout={onLogout} onEditProfile={onEditProfile} subtitle="Patient" />

      <div style={{ padding: "18px 24px 0" }}>
        <div style={{ display: "flex", background: COLORS.parchmentDim, borderRadius: 12, padding: 4, gap: 4 }}>
          <TabButton active={tab === "appointments"} onClick={() => { setTab("appointments"); setRescheduling(null); }}>
            My Appointments
          </TabButton>
          <TabButton active={tab === "book"} onClick={() => setTab("book")}>
            {rescheduling ? "Reschedule" : "Book Visit"}
          </TabButton>
        </div>
      </div>

      <div style={{ padding: "18px 24px 32px" }}>
        {error && <Banner text={error} tone="error" onClose={() => setError("")} />}

        {tab === "appointments" && (
          <AppointmentsList
            appts={appts}
            loading={loading}
            onReschedule={(a) => { setRescheduling(a); setTab("book"); }}
            onCancelled={load}
            setError={setError}
            currentUserId={user.userId}
          />
        )}

        {tab === "book" && (
          <BookingFlow
            user={user}
            rescheduling={rescheduling}
            onCancelReschedule={() => { setRescheduling(null); setTab("appointments"); }}
            onBooked={handleBooked}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: "9px 10px", borderRadius: 9, border: "none", cursor: "pointer",
        background: active ? COLORS.white : "transparent",
        color: active ? COLORS.teal : "#6B7A76",
        fontWeight: 700, fontSize: 13, fontFamily: FONT_UI,
        boxShadow: active ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
        transition: "all 0.15s ease",
      }}
    >
      {children}
    </button>
  );
}

function hoursUntil(appt) {
  const dt = new Date(appt.Date + "T" + appt.Time + ":00");
  return (dt - new Date()) / (1000 * 60 * 60);
}

function AppointmentsList({ appts, loading, onReschedule, onCancelled, setError, currentUserId }) {
  const [cancellingId, setCancellingId] = useState(null);

  async function cancel(appt) {
    setCancellingId(appt.AppointmentID);
    try {
      await cancelAppointmentDirect({
        appointmentId: appt.AppointmentID,
        doctorId: appt.DoctorID,
        date: appt.Date,
        time: appt.Time,
      });
      onCancelled();
    } catch (err) {
      setError(err.message);
    } finally {
      setCancellingId(null);
    }
  }

  if (loading) return <LoadingList />;

  const active = appts.filter((a) => a.Status !== "Cancelled");

  if (active.length === 0) {
    return <EmptyState title="No appointments yet" desc="Book your first visit from the tab above." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {active.map((a) => {
        const within24h = hoursUntil(a) < 24;
        return (
          <div
            key={a.AppointmentID}
            style={{
              background: COLORS.white, border: `1.5px solid ${COLORS.line}`, borderRadius: 12,
              padding: "16px 16px", display: "flex", flexDirection: "column", gap: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.ink }}>{a.DoctorName || "Doctor"}</div>
                <div style={{ fontSize: 12.5, color: "#6B7A76", marginTop: 2 }}>{a.Symptoms}</div>
              </div>
              <StatusPill status={a.Status} />
            </div>

            <div style={{ display: "flex", gap: 16 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: COLORS.tealDeep, fontWeight: 600 }}>
                <IconCalendar size={14} /> {a.Date}
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: COLORS.tealDeep, fontWeight: 600 }}>
                <IconClock size={14} /> {a.Time}
              </span>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <Button
                variant="ghost"
                style={{ flex: 1, padding: "9px 12px", fontSize: 13 }}
                disabled={within24h}
                onClick={() => onReschedule(a)}
              >
                Reschedule
              </Button>
              <Button
                variant="danger"
                style={{ flex: 1, padding: "9px 12px", fontSize: 13 }}
                disabled={cancellingId === a.AppointmentID}
                onClick={() => cancel(a)}
              >
                {cancellingId === a.AppointmentID ? <Spinner color={COLORS.bad} size={13} /> : "Cancel"}
              </Button>
            </div>
            {within24h && (
              <div style={{ fontSize: 11.5, color: COLORS.warn, fontWeight: 600 }}>
                Within 24 hours — rescheduling is locked. Please call the clinic for urgent changes.
              </div>
            )}
            <PrescriptionSection appointmentId={a.AppointmentID} currentUserId={currentUserId} />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Booking flow (also handles reschedule)
// ---------------------------------------------------------------------------
// Turns "09:00-11:30, 17:00-19:00" into 30-min slots, e.g. ["09:00", "09:30", ...]
function slotsFromOpdTimings(opdTimings) {
  if (!opdTimings) return [];
  const slots = [];
  opdTimings.split(",").forEach((range) => {
    const m = range.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return;
    let start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const end = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    while (start < end) {
      const h = String(Math.floor(start / 60)).padStart(2, "0");
      const mm = String(start % 60).padStart(2, "0");
      slots.push(`${h}:${mm}`);
      start += 30;
    }
  });
  return slots;
}

function BookingFlow({ user, rescheduling, onCancelReschedule, onBooked }) {
  const [doctors, setDoctors] = useState([]);
  const [city, setCity] = useState("");
  const [area, setArea] = useState("");
  const [doctorId, setDoctorId] = useState(rescheduling?.DoctorID || "");
  const [date, setDate] = useState(rescheduling?.Date || todayISO());
  const [time, setTime] = useState(rescheduling?.Time || "");
  const [symptoms, setSymptoms] = useState(rescheduling?.Symptoms || "");
  const [loadingDoctors, setLoadingDoctors] = useState(true);
  const [bookedTimes, setBookedTimes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoadingDoctors(true);
      try {
        const docs = await listDoctorsDirect();
        setDoctors(docs);
        if (rescheduling) {
          const current = docs.find((d) => d.userId === rescheduling.DoctorID);
          if (current) {
            setCity(current.city || "");
            setArea(current.area || "");
          }
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoadingDoctors(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived dropdown options
  const cities = useMemo(
    () => [...new Set(doctors.map((d) => d.city).filter(Boolean))].sort(),
    [doctors]
  );
  const areas = useMemo(
    () => [...new Set(doctors.filter((d) => d.city === city).map((d) => d.area).filter(Boolean))].sort(),
    [doctors, city]
  );
  const doctorsInArea = useMemo(
    () => doctors.filter((d) => d.city === city && d.area === area),
    [doctors, city, area]
  );

  // Reset downstream selections when an upstream one changes (not while rescheduling on first load)
  function selectCity(c) {
    setCity(c);
    setArea("");
    setDoctorId("");
    setTime("");
  }
  function selectArea(a) {
    setArea(a);
    setDoctorId("");
    setTime("");
    const inArea = doctors.filter((d) => d.city === city && d.area === a);
    if (inArea.length === 1) setDoctorId(inArea[0].userId);
  }
  function selectDoctor(id) {
    setDoctorId(id);
    setTime("");
  }

  const selectedDoctor = doctors.find((d) => d.userId === doctorId);
  const availableSlots = useMemo(
    () => (selectedDoctor ? slotsFromOpdTimings(selectedDoctor.opdTimings) : []),
    [selectedDoctor]
  );

  // Load this doctor's already-booked times for the chosen date, so they can be greyed out too
  useEffect(() => {
    if (!doctorId || !date) {
      setBookedTimes([]);
      return;
    }
    (async () => {
      try {
        const existing = await takenTimesDirect(doctorId, date);
        setBookedTimes(
          existing.filter((t) => !rescheduling || t !== rescheduling.Time || rescheduling.Date !== date)
        );
      } catch {
        setBookedTimes([]);
      }
    })();
  }, [doctorId, date, rescheduling]);

  const minDate = todayISO();

  async function submit() {
    setError("");
    if (!doctorId || !date || !time || !symptoms.trim()) {
      setError("Please choose a doctor, date, time, and describe your symptoms.");
      return;
    }
    setSubmitting(true);
    try {
      if (rescheduling) {
        const updated = await rescheduleAppointmentDirect({
          appointmentId: rescheduling.AppointmentID,
          doctorId: rescheduling.DoctorID,
          oldDate: rescheduling.Date,
          oldTime: rescheduling.Time,
          date, time,
        });
        onBooked({
          AppointmentID: rescheduling.AppointmentID,
          DoctorName: rescheduling.DoctorName,
          PatientName: rescheduling.PatientName,
          Symptoms: symptoms,
          Date: updated.date,
          Time: updated.time,
          Status: "Rescheduled",
        });
      } else {
        const doc = doctors.find((d) => d.userId === doctorId);
        const appt = await bookAppointmentDirect({
          patientId: user.userId,
          doctorId,
          patientName: `${user.name} ${user.surname || ""}`.trim(),
          doctorName: doc ? `Dr. ${doc.name} ${doc.surname || ""}`.trim() : "",
          symptoms: symptoms.trim(),
          date,
          time,
        });
        onBooked({
          AppointmentID: appt.appointmentId,
          DoctorName: appt.doctorName,
          PatientName: appt.patientName,
          Symptoms: appt.symptoms,
          Date: appt.date,
          Time: appt.time,
          Status: "Confirmed",
        });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {rescheduling && (
        <Banner
          tone="info"
          text={`Rescheduling your visit with ${rescheduling.DoctorName}. Pick a new date and time below.`}
          onClose={onCancelReschedule}
        />
      )}
      {error && <Banner text={error} tone="error" onClose={() => setError("")} />}

      {!rescheduling && (
        <>
          {loadingDoctors ? (
            <div style={{ fontSize: 13, color: "#6B7A76", marginBottom: 16 }}>Loading doctors…</div>
          ) : doctors.length === 0 ? (
            <div style={{ fontSize: 13, color: "#6B7A76", marginBottom: 16 }}>No doctors registered yet.</div>
          ) : (
            <>
              <Field label="City" required>
                <select
                  value={city}
                  onChange={(e) => selectCity(e.target.value)}
                  style={{ ...inputStyle, appearance: "auto" }}
                >
                  <option value="">Select a city…</option>
                  {cities.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>

              {city && (
                <Field label="Area" required>
                  <select
                    value={area}
                    onChange={(e) => selectArea(e.target.value)}
                    style={{ ...inputStyle, appearance: "auto" }}
                  >
                    <option value="">Select an area…</option>
                    {areas.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </Field>
              )}

              {city && area && (
                <Field label="Doctor" required>
                  {doctorsInArea.length === 0 ? (
                    <div style={{ fontSize: 13, color: "#6B7A76" }}>No doctors in this area.</div>
                  ) : (
                    <select
                      value={doctorId}
                      onChange={(e) => selectDoctor(e.target.value)}
                      style={{ ...inputStyle, appearance: "auto" }}
                    >
                      <option value="">Select a doctor…</option>
                      {doctorsInArea.map((d) => (
                        <option key={d.userId} value={d.userId}>
                          Dr. {d.name} {d.surname}{d.specialization ? ` — ${d.specialization}` : ""} — OPD {d.opdTimings}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
            </>
          )}
        </>
      )}

      {(rescheduling || doctorId) && (
        <>
          <Field label="Date" required>
            <TextInput type="date" min={minDate} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>

          <Field label="Time" required>
            {availableSlots.length === 0 ? (
              <div style={{ fontSize: 13, color: "#6B7A76" }}>
                {selectedDoctor ? "This doctor has no OPD slots configured." : "Choose a doctor to see available times."}
              </div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                  {availableSlots.map((slot) => {
                    const isBooked = bookedTimes.includes(slot);
                    const isSelected = time === slot;
                    return (
                      <button
                        key={slot}
                        type="button"
                        disabled={isBooked}
                        onClick={() => !isBooked && setTime(slot)}
                        style={{
                          padding: "10px 6px", borderRadius: 9, fontSize: 13, fontWeight: 600,
                          cursor: isBooked ? "not-allowed" : "pointer",
                          border: `1.5px solid ${isSelected ? COLORS.teal : COLORS.line}`,
                          background: isBooked ? COLORS.parchmentDim : isSelected ? COLORS.teal : COLORS.white,
                          color: isBooked ? "#A3AFA9" : isSelected ? COLORS.white : COLORS.ink,
                          opacity: isBooked ? 0.6 : 1,
                          transition: "all 0.12s ease",
                        }}
                      >
                        {slot}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 12, color: "#6B7A76", marginTop: 8 }}>
                  Greyed-out times are outside OPD hours or already booked.
                </div>
              </>
            )}
          </Field>
        </>
      )}

      <Field label="Symptoms" required>
        <textarea
          value={symptoms}
          onChange={(e) => setSymptoms(e.target.value)}
          placeholder="Briefly describe what's going on…"
          rows={4}
          style={{ ...inputStyle, resize: "vertical", fontFamily: FONT_UI }}
        />
      </Field>

      <Button full disabled={submitting} onClick={submit} style={{ marginTop: 6 }}>
        {submitting ? <Spinner /> : rescheduling ? "Confirm New Time" : "Confirm Appointment"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation screen — "flash in big view"
// ---------------------------------------------------------------------------
function ConfirmationScreen({ appt, onDone }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 30);
    return () => clearTimeout(t);
  }, []);

  const dateLabel = useMemo(() => {
    const d = new Date(appt.Date + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }, [appt.Date]);

  return (
    <div
      style={{
        minHeight: "100%", background: COLORS.teal, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", padding: "48px 28px", textAlign: "center",
        color: COLORS.white,
      }}
    >
      <div
        style={{
          width: 84, height: 84, borderRadius: "50%", background: COLORS.clay,
          display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 24,
          transform: visible ? "scale(1)" : "scale(0.4)", opacity: visible ? 1 : 0,
          transition: "all 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)",
        }}
      >
        <IconCheck size={40} />
      </div>

      <div style={{ fontSize: 11.5, letterSpacing: 2, textTransform: "uppercase", color: "#AFCFC9", fontWeight: 700, marginBottom: 10 }}>
        {appt.Status === "Rescheduled" ? "Appointment Rescheduled" : "Appointment Confirmed"}
      </div>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 30, fontWeight: 600, lineHeight: 1.25, marginBottom: 24 }}>
        {dateLabel}
        <br />
        at {appt.Time}
      </div>

      <div style={{ background: "rgba(255,255,255,0.1)", borderRadius: 16, padding: "20px 22px", width: "100%", maxWidth: 320, textAlign: "left" }}>
        <RowKV label="Doctor" value={appt.DoctorName} />
        <div style={{ height: 1, background: "rgba(255,255,255,0.15)", margin: "10px 0" }} />
        <RowKV label="Symptoms" value={appt.Symptoms} />
      </div>

      <Button variant="clay" full style={{ marginTop: 32, maxWidth: 320 }} onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

function RowKV({ label, value }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: "#AFCFC9", fontWeight: 700, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, color: COLORS.white, lineHeight: 1.4 }}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------
export default function App() {
  const [screen, setScreen] = useState("role"); // role | login | register
  const [role, setRole] = useState(null);
  const [user, setUser] = useState(null);
  const [editingProfile, setEditingProfile] = useState(false);

  function logout() {
    setUser(null);
    setScreen("role");
    setRole(null);
    setEditingProfile(false);
  }

  let content;
  if (user && editingProfile) {
    content = (
      <EditProfileScreen
        user={user}
        onBack={() => setEditingProfile(false)}
        onSaved={(u) => { setUser(u); setEditingProfile(false); }}
      />
    );
  } else if (user) {
    content = user.role === "Doctor" ? (
      <DoctorDashboard user={user} onLogout={logout} onEditProfile={() => setEditingProfile(true)} />
    ) : (
      <PatientDashboard user={user} onLogout={logout} onEditProfile={() => setEditingProfile(true)} />
    );
  } else if (screen === "role") {
    content = (
      <RoleSelectScreen
        onSelect={(r) => { setRole(r); setScreen("login"); }}
      />
    );
  } else if (screen === "login") {
    content = (
      <LoginScreen
        role={role}
        onBack={() => setScreen("role")}
        onLogin={(u) => setUser(u)}
        onGoRegister={() => setScreen("register")}
      />
    );
  } else if (screen === "register") {
    content = (
      <RegisterScreen
        role={role}
        onBack={() => setScreen("login")}
        onRegistered={(u) => setUser(u)}
        onGoLogin={() => setScreen("login")}
      />
    );
  }

  return (
    <div
      style={{
        fontFamily: FONT_UI, background: COLORS.parchment, minHeight: "100vh",
        maxWidth: 440, margin: "0 auto", position: "relative",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap');
        @keyframes dp-spin { to { transform: rotate(360deg); } }
        .dp-shimmer {
          position: absolute; inset: 0;
          background: linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent);
          animation: dp-shimmer-move 1.3s infinite;
        }
        @keyframes dp-shimmer-move {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        input[type="date"]::-webkit-calendar-picker-indicator { cursor: pointer; }
        * { box-sizing: border-box; }
        body { margin: 0; }
      `}</style>
      {content}
    </div>
  );
}
