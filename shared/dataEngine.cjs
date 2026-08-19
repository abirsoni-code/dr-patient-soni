/**
 * Shared "database engine" — implements every action the frontend calls.
 * Storage is injected via a `store` object with async get()/set(), so the
 * exact same logic runs against a local JSON file (dev) or Netlify Blobs
 * (production), without duplicating business rules in two places.
 *
 * store.get() => { users: [...], appointments: [...] }  (or defaults)
 * store.set(data) => persists the whole object
 */

const DEFAULT_DATA = { users: [], appointments: [] };

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function nowIso() {
  return new Date().toISOString();
}

async function loadData(store) {
  const data = await store.get();
  if (!data) return { ...DEFAULT_DATA };
  return {
    users: Array.isArray(data.users) ? data.users : [],
    appointments: Array.isArray(data.appointments) ? data.appointments : [],
  };
}

async function handleAction(store, action, params) {
  const data = await loadData(store);

  switch (action) {
    case "ping": {
      return { ok: true, time: nowIso() };
    }

    case "register": {
      const { role, name, surname, address, mobile, photoUrl, username, password, city, area, opdTimings, specialization } = params;
      if (!role || !name || !mobile || !username || !password) {
        throw new Error("Missing required fields");
      }
      if (role === "Doctor" && (!city || !area || !opdTimings || !specialization)) {
        throw new Error("City, area, specialization and OPD timings are required for doctors");
      }
      if (data.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        throw new Error("Username already taken");
      }
      const userId = uuid();
      const user = {
        userId, role, name, surname: surname || "", address: address || "",
        mobile, photoUrl: photoUrl || "", username, password, createdAt: nowIso(),
        ...(role === "Doctor" ? { city, area, opdTimings, specialization } : {}),
      };
      data.users.push(user);
      await store.set(data);
      const { password: _pw, ...safe } = user;
      return safe;
    }

    case "login": {
      const { username, password, role } = params;
      const user = data.users.find(
        (u) =>
          u.username.toLowerCase() === (username || "").toLowerCase() &&
          u.password === password &&
          u.role === role
      );
      if (!user) throw new Error("Invalid username or password");
      const { password: _pw, ...safe } = user;
      return safe;
    }

    case "listDoctors": {
      return data.users
        .filter((u) => u.role === "Doctor")
        .map((u) => ({
          userId: u.userId, name: u.name, surname: u.surname, photoUrl: u.photoUrl,
          city: u.city || "", area: u.area || "", opdTimings: u.opdTimings || "",
          specialization: u.specialization || "",
        }));
    }

    case "updateProfile": {
      const { userId, ...fields } = params;
      const user = data.users.find((u) => u.userId === userId);
      if (!user) throw new Error("User not found");
      Object.assign(user, fields);
      await store.set(data);
      const { password: _pw, ...safe } = user;
      return safe;
    }

    case "bookAppointment": {
      const { patientId, doctorId, patientName, doctorName, symptoms, date, time } = params;
      if (!patientId || !doctorId || !date || !time) throw new Error("Missing required fields");
      const appt = {
        appointmentId: uuid(), patientId, doctorId,
        patientName: patientName || "", doctorName: doctorName || "",
        symptoms: symptoms || "", date, time, status: "Confirmed",
        createdAt: nowIso(), updatedAt: nowIso(),
      };
      data.appointments.push(appt);
      await store.set(data);
      return appt;
    }

    case "rescheduleAppointment": {
      const { appointmentId, date, time } = params;
      const appt = data.appointments.find((a) => a.appointmentId === appointmentId);
      if (!appt) throw new Error("Appointment not found");
      const apptDateTime = new Date(appt.date + "T" + appt.time + ":00");
      const hoursUntil = (apptDateTime - new Date()) / (1000 * 60 * 60);
      if (hoursUntil < 24) {
        throw new Error("Cannot reschedule within 24 hours of the appointment");
      }
      appt.date = date;
      appt.time = time;
      appt.status = "Rescheduled";
      appt.updatedAt = nowIso();
      await store.set(data);
      return appt;
    }

    case "cancelAppointment": {
      const { appointmentId } = params;
      const appt = data.appointments.find((a) => a.appointmentId === appointmentId);
      if (!appt) throw new Error("Appointment not found");
      appt.status = "Cancelled";
      appt.updatedAt = nowIso();
      await store.set(data);
      return appt;
    }

    case "doctorAppointments": {
      const { doctorId, date } = params;
      return data.appointments
        .filter((a) => a.doctorId === doctorId && (!date || a.date === date) && a.status !== "Cancelled")
        .sort((a, b) => (a.time > b.time ? 1 : -1));
    }

    case "patientAppointments": {
      const { patientId } = params;
      return data.appointments
        .filter((a) => a.patientId === patientId)
        .sort((a, b) => new Date(a.date + "T" + a.time) - new Date(b.date + "T" + b.time));
    }

    case "uploadPrescription": {
      const { appointmentId, uploaderId, photoBase64, contentType, fileName } = params;
      if (!appointmentId || !uploaderId || !photoBase64) throw new Error("Missing required fields");
      const appt = data.appointments.find((a) => a.appointmentId === appointmentId);
      if (!appt) throw new Error("Appointment not found");
      if (uploaderId !== appt.patientId && uploaderId !== appt.doctorId) {
        throw new Error("Not authorized to upload to this appointment");
      }
      const prescriptionId = uuid();
      const meta = {
        prescriptionId, uploaderId,
        fileName: fileName || "prescription.jpg",
        contentType: contentType || "image/jpeg",
        uploadedAt: nowIso(),
      };
      appt.prescriptions = Array.isArray(appt.prescriptions) ? appt.prescriptions : [];
      appt.prescriptions.push(meta);
      await store.putBlob(prescriptionId, { photoBase64, contentType: meta.contentType });
      await store.set(data);
      return meta;
    }

    case "listPrescriptions": {
      const { appointmentId } = params;
      const appt = data.appointments.find((a) => a.appointmentId === appointmentId);
      if (!appt) throw new Error("Appointment not found");
      return Array.isArray(appt.prescriptions) ? appt.prescriptions : [];
    }

    case "getPrescriptionPhoto": {
      const { prescriptionId } = params;
      const blob = await store.getBlob(prescriptionId);
      if (!blob) throw new Error("Photo not found");
      return blob;
    }

    case "deletePrescription": {
      const { prescriptionId, requesterId } = params;
      const appt = data.appointments.find(
        (a) => Array.isArray(a.prescriptions) && a.prescriptions.some((p) => p.prescriptionId === prescriptionId)
      );
      if (!appt) throw new Error("Prescription not found");
      if (requesterId !== appt.patientId && requesterId !== appt.doctorId) {
        throw new Error("Not authorized to delete this prescription");
      }
      appt.prescriptions = appt.prescriptions.filter((p) => p.prescriptionId !== prescriptionId);
      await store.deleteBlob(prescriptionId);
      await store.set(data);
      return { ok: true };
    }

    default:
      throw new Error("Unknown action: " + action);
  }
}

class ConflictError extends Error {
  constructor(message = "Concurrent update detected, please retry") {
    super(message);
    this.code = "CONFLICT";
  }
}

module.exports = { handleAction, loadData, DEFAULT_DATA, ConflictError };
