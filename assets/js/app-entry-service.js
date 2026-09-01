export const APP_ENTRY_STATES = Object.freeze({
  PENDING: "pending",
  LOGIN: "login",
  RESOLVING: "resolving",
  LOBBY: "lobby",
  WORKSPACE: "workspace",
  ERROR: "error"
});

function clean(value) { return String(value ?? "").trim(); }
const INVITE_RETURN_KEY = "travel_entry_invite_return_v1";

export function inviteIdFromLocation(locationLike = window.location) {
  try {
    const direct = clean(new URL(locationLike.href).searchParams.get("invite"));
    if (direct) {
      try { sessionStorage.setItem(INVITE_RETURN_KEY, direct); } catch (error) {}
      return direct;
    }
  } catch (error) {}
  try { return clean(sessionStorage.getItem(INVITE_RETURN_KEY)); } catch (error) { return ""; }
}

export function rememberInviteReturn(inviteIdInput) {
  const inviteId = clean(inviteIdInput);
  if (!inviteId) return "";
  try { sessionStorage.setItem(INVITE_RETURN_KEY, inviteId); } catch (error) {}
  return inviteId;
}

export function clearInviteFromLocation({ keepTrip = true } = {}) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    if (!keepTrip) url.searchParams.delete("trip");
    history.replaceState(history.state, "", url);
  } catch (error) {}
  try { sessionStorage.removeItem(INVITE_RETURN_KEY); } catch (error) {}
}

export function accessIsVerified(access, { online = navigator.onLine !== false } = {}) {
  if (!access?.role) return false;
  if (access.serverConfirmed === true) return true;
  return online === false && (access.fromCache === true || access.source === "last-known-access");
}

export function catalogIsAuthoritative(catalog, { online = navigator.onLine !== false } = {}) {
  if (catalog?.status !== "ready") return false;
  if (catalog.serverConfirmed === true || catalog.fromCache === false) return true;
  return online === false && catalog.fromCache === true;
}

export function deriveAppEntryState({
  authResolved = false,
  user = null,
  access = null,
  catalog = null,
  online = navigator.onLine !== false
} = {}) {
  if (!authResolved) return APP_ENTRY_STATES.PENDING;
  if (!user?.uid) return APP_ENTRY_STATES.LOGIN;

  if (catalogIsAuthoritative(catalog, { online })) {
    const activeTrips = Array.isArray(catalog?.trips)
      ? catalog.trips.filter(trip => trip?.archived !== true)
      : [];
    return activeTrips.length ? APP_ENTRY_STATES.WORKSPACE : APP_ENTRY_STATES.LOBBY;
  }

  if (accessIsVerified(access, { online })) return APP_ENTRY_STATES.WORKSPACE;

  if (["rules-pending", "index-required", "error"].includes(clean(catalog?.status))) {
    return APP_ENTRY_STATES.ERROR;
  }

  return APP_ENTRY_STATES.RESOLVING;
}
