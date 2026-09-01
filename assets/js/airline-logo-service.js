/*
 * v7.9.18.2 · Shared Airline Logo Registry + flicker-safe warm cache
 *
 * Airline logos are shared app assets rather than Trip media. Upload a logo to
 * Firebase Storage at app-assets/airlines/{IATA}.png (for example CX.png).
 * The client reads the image with the signed-in Firebase Storage SDK, creates a
 * short-lived local object URL, and caches it for the current app session.
 */
import { firebaseApp } from "./firebase-service.js";
import { getBlob, getStorage, ref } from "https://www.gstatic.com/firebasejs/11.8.0/firebase-storage.js";

const storage = getStorage(firebaseApp);
const promiseCache = new Map();
const resolvedCache = new Map();
const objectUrls = new Set();
const EXTENSIONS = ["png", "webp", "jpg", "jpeg", "svg"];

const AIRLINE_DIRECTORY = Object.freeze([
  { code: "CX", name: "Cathay Pacific" },
  { code: "UO", name: "HK Express" },
  { code: "HX", name: "Hong Kong Airlines" },
  { code: "JL", name: "Japan Airlines" },
  { code: "NH", name: "ANA" },
  { code: "MM", name: "Peach Aviation" },
  { code: "GK", name: "Jetstar Japan" },
  { code: "BC", name: "Skymark Airlines" },
  { code: "BR", name: "EVA Air" },
  { code: "CI", name: "China Airlines" },
  { code: "JX", name: "STARLUX Airlines" },
  { code: "SQ", name: "Singapore Airlines" },
  { code: "TR", name: "Scoot" },
  { code: "TG", name: "Thai Airways" },
  { code: "KE", name: "Korean Air" },
  { code: "OZ", name: "Asiana Airlines" },
  { code: "TW", name: "T'way Air" },
  { code: "7C", name: "Jeju Air" },
  { code: "MU", name: "China Eastern" },
  { code: "CZ", name: "China Southern" },
  { code: "CA", name: "Air China" },
  { code: "UA", name: "United Airlines" },
  { code: "AA", name: "American Airlines" },
  { code: "DL", name: "Delta Air Lines" },
  { code: "BA", name: "British Airways" },
  { code: "QF", name: "Qantas" },
  { code: "EK", name: "Emirates" },
  { code: "QR", name: "Qatar Airways" },
  { code: "AY", name: "Finnair" },
  { code: "TK", name: "Turkish Airlines" }
]);

export function airlineDirectory(query = "") {
  const needle = clean(query).toUpperCase();
  if (!needle) return AIRLINE_DIRECTORY.slice();
  return AIRLINE_DIRECTORY.filter(row => row.code.includes(needle) || row.name.toUpperCase().includes(needle));
}

function clean(value) { return String(value ?? "").trim(); }

export function airlineCodeFromFlightNumber(value = "") {
  const match = clean(value).toUpperCase().match(/^([A-Z0-9]{2})(?=\s*\d)/);
  return match ? match[1] : "";
}

export function normalizeAirlineCode(codeInput = "", flightNumber = "") {
  const direct = clean(codeInput).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (direct || airlineCodeFromFlightNumber(flightNumber)).slice(0, 3);
}

async function fetchLogoObjectUrl(code) {
  for (const ext of EXTENSIONS) {
    try {
      const blob = await getBlob(ref(storage, `app-assets/airlines/${code}.${ext}`), 2 * 1024 * 1024);
      const url = URL.createObjectURL(blob);
      objectUrls.add(url);
      return url;
    } catch (error) {
      const codeValue = String(error?.code || "");
      if (codeValue.includes("unauthorized")) throw error;
    }
  }
  return "";
}

export function immediateAirlineLogo({ airlineCode = "", flightNumber = "", fallbackUrl = "" } = {}) {
  const code = normalizeAirlineCode(airlineCode, flightNumber);
  if (code && resolvedCache.has(code)) return resolvedCache.get(code) || "";
  if (clean(fallbackUrl)) return clean(fallbackUrl);
  if (code === "CX") return "assets/icon/cx_logo.png";
  return "";
}

export async function resolveAirlineLogo({ airlineCode = "", flightNumber = "", fallbackUrl = "" } = {}) {
  const code = normalizeAirlineCode(airlineCode, flightNumber);
  if (!code) return clean(fallbackUrl);
  if (resolvedCache.has(code)) return resolvedCache.get(code) || immediateAirlineLogo({ airlineCode: code, fallbackUrl });
  if (!promiseCache.has(code)) promiseCache.set(code, fetchLogoObjectUrl(code).catch(() => ""));
  const firebaseUrl = await promiseCache.get(code);
  const resolved = firebaseUrl || clean(fallbackUrl) || (code === "CX" ? "assets/icon/cx_logo.png" : "");
  resolvedCache.set(code, resolved);
  return resolved;
}

export function clearAirlineLogoSessionCache() {
  objectUrls.forEach(url => { try { URL.revokeObjectURL(url); } catch (_) {} });
  objectUrls.clear();
  promiseCache.clear();
  resolvedCache.clear();
}
