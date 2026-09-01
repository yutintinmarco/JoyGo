const STORAGE_KEY = "travel_active_trip_id";
let activeTripId = "";
const subscribers = new Set();

function clean(value) { return String(value || "").trim(); }

function fromQuery() {
  const params = new URLSearchParams(window.location.search);
  return clean(params.get("trip") || params.get("expensesTrip"));
}

function fromLocalStorage() {
  try { return clean(localStorage.getItem(STORAGE_KEY)); } catch (error) { return ""; }
}

function fromTripData(tripData) {
  return clean(tripData?.meta?.tripId || tripData?.meta?.expenses?.tripId);
}

function publish() {
  window.__activeTripId = activeTripId;
  window.dispatchEvent(new CustomEvent("app-active-trip", { detail: { tripId: activeTripId } }));
  subscribers.forEach(callback => {
    try { callback(activeTripId); } catch (error) { console.error("Trip session subscriber", error); }
  });
}

export function resolveTripId(tripData) {
  if (activeTripId) return activeTripId;
  // Explicit deep links win, then remember the user's last selected Trip.
  // The bundled trip.json is a neutral compatibility bootstrap and must never
  // invent or override a production Trip session.
  activeTripId = fromQuery() || fromLocalStorage() || fromTripData(tripData) || "";
  try {
    if (activeTripId) localStorage.setItem(STORAGE_KEY, activeTripId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch (error) {}
  publish();
  return activeTripId;
}

export function setActiveTripId(tripId) {
  const next = clean(tripId);
  if (!next || next === activeTripId) return activeTripId;
  activeTripId = next;
  try { localStorage.setItem(STORAGE_KEY, activeTripId); } catch (error) {}
  publish();
  return activeTripId;
}

export function clearActiveTripId() {
  activeTripId = "";
  try { localStorage.removeItem(STORAGE_KEY); } catch (error) {}
  publish();
  return "";
}

export function getActiveTripId() { return activeTripId || fromQuery() || fromLocalStorage(); }

export function subscribeActiveTrip(callback, { immediate = true } = {}) {
  if (typeof callback !== "function") return () => {};
  subscribers.add(callback);
  if (immediate && getActiveTripId()) callback(getActiveTripId());
  return () => subscribers.delete(callback);
}
