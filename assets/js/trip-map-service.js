import { GOOGLE_MAPS_CONFIG } from "./maps-config.js";
import { ITINERARY_ITEM_KIND, normalizeItineraryItemKind } from "./trip-schema-service.js";

const MAPS_SCRIPT_ID = "travel-google-maps-js";
const COORD_CACHE_KEY = "travel-map-coordinate-cache-v1";
const COORD_CACHE_MAX = 240;
const COORD_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
let mapsLoadPromise = null;
let mapsLibrariesPromise = null;
let routesLibraryPromise = null;
let placesLibraryPromise = null;
let mapsShortLinkCallablePromise = null;
const transitRouteMemoryCache = new Map();

function clean(value) { return String(value ?? "").trim(); }
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function configuredKey() {
  const key = clean(GOOGLE_MAPS_CONFIG?.apiKey);
  if (!key || key.includes("REPLACE_WITH_")) return "";
  return key;
}
function storageAvailable() {
  try {
    const probe = "__travel_map_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch (_) { return false; }
}
function readCoordCache() {
  if (!storageAvailable()) return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(COORD_CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}
function writeCoordCache(cache) {
  if (!storageAvailable()) return;
  try {
    const rows = Object.entries(cache || {})
      .filter(([, value]) => value && finiteNumber(value.lat) != null && finiteNumber(value.lng) != null)
      .sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0))
      .slice(0, COORD_CACHE_MAX);
    localStorage.setItem(COORD_CACHE_KEY, JSON.stringify(Object.fromEntries(rows)));
  } catch (_) {}
}
function cacheLookup(key) {
  if (!key) return null;
  const cache = readCoordCache();
  const row = cache[key];
  if (!row) return null;
  const updatedAt = Number(row.updatedAt || 0);
  if (!updatedAt || Date.now() - updatedAt > COORD_CACHE_TTL_MS) return null;
  const lat = finiteNumber(row.lat), lng = finiteNumber(row.lng);
  if (lat == null || lng == null) return null;
  return {
    lat,
    lng,
    formattedAddress: clean(row.formattedAddress),
    placeId: clean(row.placeId),
    source: "local-cache"
  };
}
function cacheStore(key, value) {
  if (!key || !value) return;
  const lat = finiteNumber(value.lat), lng = finiteNumber(value.lng);
  if (lat == null || lng == null) return;
  const cache = readCoordCache();
  cache[key] = {
    lat,
    lng,
    formattedAddress: clean(value.formattedAddress),
    placeId: clean(value.placeId),
    updatedAt: Date.now()
  };
  writeCoordCache(cache);
}

export function googleMapsConfigured() { return !!configuredKey(); }
export function googleMapsConfigStatus() {
  return {
    configured: googleMapsConfigured(),
    mapId: clean(GOOGLE_MAPS_CONFIG?.mapId) || "DEMO_MAP_ID",
    apiKeyPresent: !!configuredKey()
  };
}

function scriptUrl(callbackName) {
  const params = new URLSearchParams({
    key: configuredKey(),
    v: clean(GOOGLE_MAPS_CONFIG?.version) || "weekly",
    loading: "async",
    callback: callbackName
  });
  const language = clean(GOOGLE_MAPS_CONFIG?.language);
  const region = clean(GOOGLE_MAPS_CONFIG?.region);
  if (language) params.set("language", language);
  if (region) params.set("region", region);
  return `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
}

export async function loadGoogleMapsLibraries() {
  if (!googleMapsConfigured()) {
    const error = new Error("Google Maps browser key is not configured");
    error.code = "maps-not-configured";
    throw error;
  }
  if (!mapsLoadPromise) {
    mapsLoadPromise = new Promise((resolve, reject) => {
      if (window.google?.maps?.importLibrary) { resolve(window.google.maps); return; }
      const existing = document.getElementById(MAPS_SCRIPT_ID);
      const callbackName = `__travelGoogleMapsReady_${Date.now().toString(36)}`;
      const cleanup = () => { try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; } };
      window[callbackName] = () => { cleanup(); resolve(window.google?.maps); };
      if (existing) {
        const waitStart = Date.now();
        const poll = () => {
          if (window.google?.maps?.importLibrary) { cleanup(); resolve(window.google.maps); return; }
          if (Date.now() - waitStart > 12000) { cleanup(); reject(new Error("Google Maps script did not become ready")); return; }
          setTimeout(poll, 80);
        };
        poll();
        return;
      }
      const script = document.createElement("script");
      script.id = MAPS_SCRIPT_ID;
      script.async = true;
      script.defer = true;
      script.src = scriptUrl(callbackName);
      script.onerror = () => { cleanup(); mapsLoadPromise = null; reject(new Error("Google Maps JavaScript API failed to load")); };
      document.head.appendChild(script);
    });
  }
  await mapsLoadPromise;
  if (!mapsLibrariesPromise) {
    mapsLibrariesPromise = Promise.all([
      window.google.maps.importLibrary("maps"),
      window.google.maps.importLibrary("marker"),
      window.google.maps.importLibrary("geocoding"),
      window.google.maps.importLibrary("core")
    ]).then(([maps, marker, geocoding, core]) => ({ maps, marker, geocoding, core }));
  }
  return mapsLibrariesPromise;
}
async function loadGoogleRoutesLibrary() {
  await loadGoogleMapsLibraries();
  if (!routesLibraryPromise) {
    routesLibraryPromise = window.google.maps.importLibrary("routes").catch(error => {
      routesLibraryPromise = null;
      throw error;
    });
  }
  return routesLibraryPromise;
}
async function loadGooglePlacesLibrary() {
  await loadGoogleMapsLibraries();
  if (!placesLibraryPromise) {
    placesLibraryPromise = window.google.maps.importLibrary("places").catch(error => {
      placesLibraryPromise = null;
      throw error;
    });
  }
  return placesLibraryPromise;
}

async function mapsShortLinkCallable() {
  if (!mapsShortLinkCallablePromise) {
    mapsShortLinkCallablePromise = Promise.all([
      import("./firebase-service.js"),
      import("https://www.gstatic.com/firebasejs/11.8.0/firebase-functions.js")
    ]).then(([firebaseService, functionsSdk]) => {
      const functions = functionsSdk.getFunctions(firebaseService.firebaseApp, "asia-east2");
      return functionsSdk.httpsCallable(functions, "resolveGoogleMapsShortLink", { timeout: 15000 });
    }).catch(error => {
      mapsShortLinkCallablePromise = null;
      throw error;
    });
  }
  return mapsShortLinkCallablePromise;
}
async function expandGoogleMapsShortLink(input) {
  try {
    const callable = await mapsShortLinkCallable();
    const result = await callable({ url: clean(input) });
    const url = clean(result?.data?.url);
    if (!url) { const error = new Error("Short-link resolver returned no URL"); error.code = "maps-short-link-unresolved"; throw error; }
    return url;
  } catch (error) {
    if (String(error?.code || "").startsWith("maps-short-link-")) throw error;
    const details = error?.details || error?.customData?.details || {};
    const detailCode = clean(details?.code);
    const wrapped = new Error(error?.message || "Google Maps short-link resolver unavailable");
    if (detailCode) wrapped.code = detailCode;
    else if (clean(error?.code) === "functions/unauthenticated") wrapped.code = "maps-short-link-auth-required";
    else wrapped.code = "maps-short-link-resolver-unavailable";
    wrapped.cause = error;
    throw wrapped;
  }
}

function coordsFromLocation(location = {}) {
  const lat = finiteNumber(location?.latitude ?? location?.lat);
  const lng = finiteNumber(location?.longitude ?? location?.lng ?? location?.lon);
  return lat == null || lng == null ? null : { lat, lng };
}
function googleMapsUrlInfo(input) {
  const raw = clean(input);
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    const host = clean(url.hostname).toLowerCase();
    const isShort = host === "maps.app.goo.gl" || host === "goo.gl";
    const isGoogle = isShort || host === "google.com" || host.endsWith(".google.com") || host === "google.co.jp" || host.endsWith(".google.co.jp");
    if (!isGoogle) return null;
    const query = clean(url.searchParams.get("query") || url.searchParams.get("q") || url.searchParams.get("destination"));
    const embeddedPlaceId = clean(raw.match(/!1s(ChI[^!/?&#]+)/)?.[1]);
    const placeId = clean(url.searchParams.get("query_place_id") || url.searchParams.get("destination_place_id") || url.searchParams.get("place_id") || embeddedPlaceId);
    const path = decodeURIComponent(url.pathname || "");
    const placeMatch = path.match(/\/place\/([^/]+)/i);
    const pathName = clean(placeMatch?.[1]?.replace(/\+/g, " "));
    const directCoords = [query, clean(url.searchParams.get("center")), clean(url.searchParams.get("ll"))]
      .map(value => String(value || "").match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/))
      .find(Boolean);
    const dataCoords = raw.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/i);
    const atCoords = raw.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/);
    const match = dataCoords || directCoords || atCoords;
    const latitude = match ? finiteNumber(match[1]) : null;
    const longitude = match ? finiteNumber(match[2]) : null;
    return {raw,isShort,query:(query && !directCoords ? query.replace(/\+/g, " ") : "") || pathName,placeId,coords:latitude == null || longitude == null ? null : { lat: latitude, lng: longitude }};
  } catch (_) { return null; }
}
function mapsQueryFromUrl(input) { return clean(googleMapsUrlInfo(input)?.query); }
function mapsPlaceIdFromUrl(input) { return clean(googleMapsUrlInfo(input)?.placeId); }
function editableMapsUrl({ placeId = "", address = "", latitude = null, longitude = null, name = "" } = {}) {
  const lat = finiteNumber(latitude), lng = finiteNumber(longitude);
  const query = clean(address || name) || (lat != null && lng != null ? `${lat},${lng}` : "");
  if (!query && !clean(placeId)) return "";
  const params = new URLSearchParams({ api: "1", query: query || clean(placeId) });
  if (clean(placeId)) params.set("query_place_id", clean(placeId));
  return `https://www.google.com/maps/search/?${params.toString()}`;
}
function pointResolveSpec(record = {}) {
  const location = record?.location && typeof record.location === "object" ? record.location : {};
  const coords = coordsFromLocation(location) || coordsFromLocation(record);
  const placeId = clean(location.placeId || record.googlePlaceId || record.googleMapsPlaceId);
  const address = clean(location.address || record.address);
  const mapsUrl = clean(location.mapsUrl || record.maps || record.mapsUrl || record.googleMapsUrl);
  const query = mapsQueryFromUrl(mapsUrl) || address;
  if (coords) return { type: "coords", coords, key: `c:${coords.lat.toFixed(6)},${coords.lng.toFixed(6)}` };
  if (placeId) return { type: "placeId", value: placeId, key: `p:${placeId}` };
  if (query) return { type: "query", value: query, key: `q:${query.toLowerCase()}` };
  return { type: "none", key: "" };
}

function orderedPreviewImages(record = {}) {
  const images = Array.isArray(record?.images) ? record.images.filter(Boolean) : [];
  if (images.length) {
    return images.slice().sort((a, b) => Number(a?.sortOrder ?? 0) - Number(b?.sortOrder ?? 0));
  }
  const gallery = Array.isArray(record?.gallery) ? record.gallery.filter(Boolean) : (record?.gallery ? [record.gallery] : []);
  if (gallery.length) return gallery;
  const bookingGallery = Array.isArray(record?.booking?.gallery) ? record.booking.gallery.filter(Boolean) : (record?.booking?.gallery ? [record.booking.gallery] : []);
  return bookingGallery;
}
function previewImagesFromRecord(record = {}) { return orderedPreviewImages(record); }
function previewImageFromRecord(record = {}) { return previewImagesFromRecord(record)[0] || null; }
function regionLabelFromSavedPlace(place = {}) {
  const explicit = clean(place?.region || place?.district || place?.city);
  if (explicit) return explicit;
  const area = clean(place?.area);
  if (area) {
    const first = clean(area.split(/[\s/／·・|]+/)[0]);
    if (first) return first;
  }
  const tags = Array.isArray(place?.tags) ? place.tags.map(clean).filter(Boolean) : [];
  return tags[0] || "其他";
}

export const MAP_ROUTE_MODE = Object.freeze({
  WALKING: "WALKING",
  DRIVING: "DRIVING",
  BICYCLING: "BICYCLING",
  TRANSIT: "TRANSIT",
  FLIGHT: "FLIGHT",
  UNKNOWN: "UNKNOWN"
});
function normalizeRouteModeValue(value) {
  const raw = clean(value).toLowerCase();
  if (!raw) return "";
  if (["walk", "walking", "foot", "pedestrian"].includes(raw)) return MAP_ROUTE_MODE.WALKING;
  if (["drive", "driving", "car", "taxi", "uber"].includes(raw)) return MAP_ROUTE_MODE.DRIVING;
  if (["bike", "bicycle", "bicycling", "cycling"].includes(raw)) return MAP_ROUTE_MODE.BICYCLING;
  if (["transit", "train", "rail", "subway", "metro", "bus", "tram", "ferry"].includes(raw)) return MAP_ROUTE_MODE.TRANSIT;
  if (["flight", "air", "plane", "airplane"].includes(raw)) return MAP_ROUTE_MODE.FLIGHT;
  return "";
}
function routeModeFromItineraryItem(item = {}) {
  const explicit = [item?.routeMode, item?.travelMode, item?.mode, item?.transport?.mode, item?.transit?.mode]
    .map(normalizeRouteModeValue).find(Boolean);
  if (explicit) return explicit;
  const icon = clean(item?.icon);
  if (/🚶|🥾/.test(icon)) return MAP_ROUTE_MODE.WALKING;
  if (/🚲|🚴/.test(icon)) return MAP_ROUTE_MODE.BICYCLING;
  if (/🚗|🚕|🚙|🚐/.test(icon)) return MAP_ROUTE_MODE.DRIVING;
  if (/✈️|🛫|🛬/.test(icon)) return MAP_ROUTE_MODE.FLIGHT;
  if (/🚆|🚄|🚅|🚇|🚈|🚊|🚋|🚌|🚎|⛴️|🚢/.test(icon)) return MAP_ROUTE_MODE.TRANSIT;
  const text = `${clean(item?.title)} ${clean(item?.note)} ${clean(item?.detail)}`.toLowerCase();
  if (/\b(walk|walking)\b|步行|徒歩/.test(text)) return MAP_ROUTE_MODE.WALKING;
  if (/\b(taxi|drive|driving|car|uber)\b|的士|計程車|駕車|自駕/.test(text)) return MAP_ROUTE_MODE.DRIVING;
  if (/\b(bicycle|bike|cycling)\b|單車|自行車/.test(text)) return MAP_ROUTE_MODE.BICYCLING;
  if (/\b(flight|plane|airline)\b|航班|飛機/.test(text)) return MAP_ROUTE_MODE.FLIGHT;
  if (/\b(train|rail|metro|subway|bus|transit|tram|ferry)\b|火車|鐵路|地鐵|巴士|公車|電車|渡輪|特急|新幹線/.test(text)) return MAP_ROUTE_MODE.TRANSIT;
  return normalizeItineraryItemKind(item) === ITINERARY_ITEM_KIND.TRANSIT ? MAP_ROUTE_MODE.TRANSIT : MAP_ROUTE_MODE.UNKNOWN;
}

function normalizedAnchorType(value) {
  const raw = clean(value).toLowerCase();
  if (["hotel", "lodging", "accommodation"].includes(raw)) return "hotel";
  if (["flight", "airport", "plane", "air"].includes(raw)) return "flight";
  if (["rail", "train", "station"].includes(raw)) return "rail";
  if (["ferry", "port", "harbour", "harbor"].includes(raw)) return "ferry";
  return "";
}
function routeAnchorTypeFromItem(item = {}, itemKind = normalizeItineraryItemKind(item)) {
  const explicit = normalizedAnchorType(item?.routeAnchorType || item?.mapAnchorType || item?.anchorType || item?.routeAnchor);
  if (explicit) return explicit;
  const mode = routeModeFromItineraryItem(item);
  // A normal stop note may mention a later flight (e.g. "視乎航班時間").
  // Only transit-class rows can be promoted by inferred FLIGHT mode; explicit
  // anchor metadata above can still deliberately promote a stop.
  if (itemKind === ITINERARY_ITEM_KIND.TRANSIT && mode === MAP_ROUTE_MODE.FLIGHT) return "flight";
  const icon = clean(item?.icon);
  const text = `${clean(item?.title)} ${clean(item?.note)} ${clean(item?.detail)}`;
  // Hotel check-in can remain a real numbered itinerary activity. Only a hotel
  // row that clearly means returning/resting/departing is promoted to route
  // context. Days without such a row get a synthetic lodging anchor below.
  if (/🏨|🛏️?/.test(icon) && /(返回|回到|返抵|返酒店|回酒店|休息|住宿休息|酒店出發|住宿出發|離開酒店|離開住宿)/.test(text)) return "hotel";
  if (itemKind === ITINERARY_ITEM_KIND.TRANSIT && /⛴️|🚢/.test(icon) && /^(港口|碼頭|渡輪|ferry|port)/i.test(clean(item?.title))) return "ferry";
  return "";
}
function anchorIcon(type, fallback = "") {
  if (type === "hotel") return "🏨";
  if (type === "flight") return "✈️";
  if (type === "rail") return "🚆";
  if (type === "ferry") return "⛴️";
  return clean(fallback) || "•";
}
function isoDayValue(day = {}) {
  const direct = clean(day?.dateIso || day?.isoDate || day?.iso || day?.dateISO);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const idMatch = clean(day?.dayId).match(/(20\d{2})(\d{2})(\d{2})/);
  return idMatch ? `${idMatch[1]}-${idMatch[2]}-${idMatch[3]}` : "";
}
function hotelPlain(value) {
  if (!value) return { name: "", address: "", mapsUrl: "" };
  if (typeof value === "string") return { name: clean(value), address: "", mapsUrl: "" };
  return { name: clean(value?.name || value?.label), address: clean(value?.address), mapsUrl: clean(value?.mapsUrl || value?.maps) };
}
function airportMapQuery(value = "") {
  const raw = clean(value);
  if (!raw) return "";
  const compact = raw.toUpperCase();
  return /^[A-Z]{3}$/.test(compact) ? `${compact} Airport` : raw;
}
function airportIataCode(value = "") {
  const raw = clean(value);
  if (!raw) return "";
  const upper = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  const parenthesized = upper.match(/\(([A-Z]{3})\)/);
  if (parenthesized?.[1]) return parenthesized[1];
  const leading = upper.match(/^([A-Z]{3})(?:\s|[-–—·/]|$)/);
  return leading?.[1] || "";
}
function airportResolveSpec(value = "") {
  const raw = clean(value);
  if (!raw) return { type: "none", key: "" };
  const iata = airportIataCode(raw);
  const query = iata ? `${iata} airport` : raw;
  // Airport anchors use a dedicated cache namespace. This intentionally bypasses
  // any older generic geocoder result (for example q:kix airport) that may have
  // been cached before strict airport resolution was introduced.
  return { type: "airport", value: query, raw, iata, key: `a:${(iata || raw).toLowerCase()}` };
}
function flightRowsForMap(meta = {}) {
  const source = Array.isArray(meta?.flights) ? meta.flights : [], out = [];
  source.forEach((row, index) => {
    if (row?.outbound || row?.inbound) {
      [[row.outbound, "entry", 0], [row.inbound, "exit", 1]].forEach(([legacy, role, part]) => {
        if (!legacy) return;
        const route = clean(legacy.route).split(/\s*(?:→|至|->| to )\s*/i).map(clean).filter(Boolean);
        const times = clean(legacy.time).match(/(\d{1,2}:\d{2})\s*(?:-|–|—|→|至)\s*(\d{1,2}:\d{2})/);
        const dateRaw = clean(legacy.date), year = clean(meta?.tripStartIso).slice(0,4), dm = dateRaw.match(/^(\d{1,2})[\/-](\d{1,2})$/);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : (dm && year ? `${year}-${String(Number(dm[2])).padStart(2,"0")}-${String(Number(dm[1])).padStart(2,"0")}` : "");
        out.push({ flightId: `legacy_${index}_${part}`, teamKey: clean(row.teamKey) || "all", journeyRole: role, flightNumber: clean(legacy.flight), departureDate: date, arrivalDate: date, departureTime: times?.[1] || "", arrivalTime: times?.[2] || "", departureAirport: route[0] || "", arrivalAirport: route[1] || "" });
      });
      return;
    }
    out.push({ ...row, flightId: clean(row?.flightId) || `flight_${index}`, teamKey: clean(row?.teamKey) || "all", journeyRole: clean(row?.journeyRole) || "internal", flightNumber: clean(row?.flightNumber || row?.flight), departureDate: clean(row?.departureDate || row?.date), arrivalDate: clean(row?.arrivalDate || row?.departureDate || row?.date), departureTime: clean(row?.departureTime), arrivalTime: clean(row?.arrivalTime), departureAirport: clean(row?.departureAirport || row?.from), arrivalAirport: clean(row?.arrivalAirport || row?.to) });
  });
  return out;
}
function lodgingAnchorsForDay(trip = {}, day = {}) {
  const meta = trip?.meta && typeof trip.meta === "object" ? trip.meta : {};
  const dateIso = isoDayValue(day), cities = meta?.cities && typeof meta.cities === "object" ? meta.cities : {};
  const accommodations = Array.isArray(meta?.accommodations) ? meta.accommodations : [];
  let rows = [];
  if (accommodations.length) {
    rows = accommodations.map((raw, index) => ({
      accommodationId: clean(raw?.accommodationId) || `stay_${index}`,
      name: clean(raw?.name || raw?.title), address: clean(raw?.address || raw?.location?.address), mapsUrl: clean(raw?.mapsUrl || raw?.maps || raw?.location?.mapsUrl),
      cityKey: clean(raw?.cityKey), teamKey: clean(raw?.teamKey) || "all", checkInDate: clean(raw?.checkInDate), checkOutDate: clean(raw?.checkOutDate)
    })).filter(row => row.name || row.address);
    if (dateIso) {
      let dated = rows.filter(row => (!row.checkInDate || row.checkInDate <= dateIso) && (!row.checkOutDate || dateIso < row.checkOutDate));
      if (!dated.length) dated = rows.filter(row => row.checkOutDate === dateIso);
      if (dated.length) rows = dated; else rows = [];
    }
  } else {
    const hotels = meta?.hotels && typeof meta.hotels === "object" ? meta.hotels : {};
    rows = Object.entries(hotels).map(([cityKey, raw], index) => {
      const hotel = hotelPlain(raw), city = cities?.[cityKey] || {};
      return { accommodationId: `legacy_${cityKey}_${index}`, name: hotel.name, address: hotel.address, mapsUrl: hotel.mapsUrl, cityKey, teamKey: "all", checkInDate: clean(city?.startIso), checkOutDate: clean(city?.endIso) };
    }).filter(row => row.name || row.address);
    if (dateIso) {
      const dated = rows.filter(row => (!row.checkInDate || row.checkInDate <= dateIso) && (!row.checkOutDate || row.checkOutDate >= dateIso));
      if (dated.length) rows = dated.sort((a,b)=>clean(b.checkInDate).localeCompare(clean(a.checkInDate))).slice(0,1);
    }
  }
  return rows.map((selected, index) => {
    const title = selected.name || `${clean(cities?.[selected.cityKey]?.label) || selected.cityKey || ""}住宿` || "住宿";
    const mapsUrl = selected.mapsUrl || editableMapsUrl({ address: selected.address, name: title });
    const record = { location: { name: title, address: selected.address, mapsUrl } }, resolve = pointResolveSpec(record);
    if (resolve.type === "none") return null;
    const isCheckInDay = Boolean(dateIso && selected.checkInDate && selected.checkInDate === dateIso);
    const isCheckOutDay = Boolean(dateIso && selected.checkOutDate && selected.checkOutDate === dateIso);
    return { kind: "itinerary", itemKind: ITINERARY_ITEM_KIND.STOP, mapRole: "anchor", anchorType: "hotel", routeEligible: true, routeMode: MAP_ROUTE_MODE.UNKNOWN,
      identity: `anchor:hotel:${clean(day?.dayId)}:${selected.accommodationId}`, dayId: clean(day?.dayId), itemId: "", order: 0, displayOrder: null, who: selected.teamKey || "all", icon: "🏨", title,
      subtitle: [clean(cities?.[selected.cityKey]?.label), selected.address].filter(Boolean).join(" · "), meta: "住宿 · 行程起終點", detail: selected.address, previewImages: [], previewImage: null, mapsUrl, resolve, syntheticAnchor: true,
      routeHotelStartEligible: !isCheckInDay, routeHotelEndEligible: !isCheckOutDay, accommodationCheckInDate: clean(selected.checkInDate), accommodationCheckOutDate: clean(selected.checkOutDate) };
  }).filter(Boolean);
}
function flightAnchorsForDay(trip = {}, day = {}) {
  const meta = trip?.meta && typeof trip.meta === "object" ? trip.meta : {}, dateIso = isoDayValue(day);
  if (!dateIso) return [];
  const anchors = [];
  flightRowsForMap(meta).forEach((flight) => {
    const role = clean(flight.journeyRole).toLowerCase();
    let airport = "", time = "", order = 0, label = "";
    if (role === "entry" && clean(flight.arrivalDate || flight.departureDate) === dateIso) { airport = clean(flight.arrivalAirport); time = clean(flight.arrivalTime); order = -100; label = "抵達"; }
    else if (role === "exit" && clean(flight.departureDate) === dateIso) { airport = clean(flight.departureAirport); time = clean(flight.departureTime); order = 100000; label = "出發"; }
    else return;
    if (!airport) return;
    const airportQuery = airportMapQuery(airport);
    const mapsUrl = editableMapsUrl({ address: airportQuery, name: airport });
    const resolve = airportResolveSpec(airport);
    if (resolve.type === "none") return;
    anchors.push({ kind: "itinerary", itemKind: ITINERARY_ITEM_KIND.TRANSIT, mapRole: "anchor", anchorType: "flight", routeEligible: true, routeMode: MAP_ROUTE_MODE.FLIGHT,
      identity: `anchor:flight:${clean(day?.dayId)}:${clean(flight.flightId)}:${role}`, dayId: clean(day?.dayId), itemId: "", order, displayOrder: null, who: clean(flight.teamKey) || "all", icon: "✈️", journeyRole: role,
      title: clean(flight.flightNumber) || "航班", subtitle: [label, airport, time].filter(Boolean).join(" · "), meta: "航班 · 行程起終點", detail: [clean(flight.departureAirport), clean(flight.arrivalAirport)].filter(Boolean).join(" → "), previewImages: [], previewImage: null, mapsUrl, resolve, syntheticAnchor: true });
  });
  return anchors;
}

export function itineraryMapPoints(trip, activeDayId = "") {
  const days = Array.isArray(trip?.days) ? trip.days : [];
  const wanted = clean(activeDayId);
  const day = days.find(row => clean(row?.dayId) === wanted) || days[0] || null;
  if (!day) return [];

  let candidates = (Array.isArray(day.items) ? day.items : []).map((item, index) => {
    const spec = pointResolveSpec(item);
    const time = clean(item?.time);
    const note = clean(item?.note);
    const detail = clean(item?.detail);
    const itemKind = normalizeItineraryItemKind(item);
    const anchorType = routeAnchorTypeFromItem(item, itemKind);
    const mapRole = anchorType ? "anchor" : (itemKind === ITINERARY_ITEM_KIND.TRANSIT ? "transit" : "stop");
    const routeMode = itemKind === ITINERARY_ITEM_KIND.TRANSIT || anchorType ? routeModeFromItineraryItem(item) : MAP_ROUTE_MODE.UNKNOWN;
    const mapMarkerVisible = item?.mapMarkerVisible !== false;
    return {
      kind: "itinerary",
      itemKind,
      mapRole,
      anchorType,
      mapMarkerVisible,
      // Map presentation is intentionally separate from Transit endpoint semantics.
      // A hidden Stop remains in itinerary data for Transit routing, but does not
      // become an invisible bend / endpoint in the Trip Overview sequence line.
      routeEligible: mapRole === "anchor" || (itemKind === ITINERARY_ITEM_KIND.STOP && mapMarkerVisible),
      routeMode,
      identity: `item:${clean(day.dayId)}:${clean(item?.itemId) || index}`,
      dayId: clean(day.dayId),
      itemId: clean(item?.itemId),
      // `order` remains the raw itinerary order for sorting / Team sequence.
      // `displayOrder` is a separate contiguous Map stop number.
      order: index + 1,
      displayOrder: null,
      who: clean(item?.who) || "all",
      icon: anchorType ? anchorIcon(anchorType, item?.icon) : (clean(item?.icon) || (itemKind === ITINERARY_ITEM_KIND.TRANSIT ? "↗︎" : "•")),
      title: clean(item?.title) || (itemKind === ITINERARY_ITEM_KIND.TRANSIT ? "交通" : `行程 ${index + 1}`),
      subtitle: [time, note].filter(Boolean).join(" · "),
      meta: time || (mapRole === "anchor" ? "行程起終點" : (itemKind === ITINERARY_ITEM_KIND.TRANSIT ? "交通" : "行程地點")),
      detail: note || detail,
      previewImages: previewImagesFromRecord(item),
      previewImage: previewImageFromRecord(item),
      mapsUrl: clean(item?.location?.mapsUrl || item?.maps || item?.mapsUrl),
      resolve: spec
    };
  }).filter(point => point.resolve.type !== "none");

  // Once Travel Details have been promoted to the new master structures, they
  // become the canonical source for hotel / entry-exit flight anchors. This
  // prevents legacy itinerary rows such as “返回酒店” or old flight markers
  // from masking an edited master record. Legacy trips keep the previous
  // explicit-anchor precedence until they are promoted by Edit + Global Save.
  const meta = trip?.meta && typeof trip.meta === "object" ? trip.meta : {};
  const hasAccommodationMaster = Array.isArray(meta?.accommodations) && meta.accommodations.length > 0;
  const hasFlightMaster = Array.isArray(meta?.flights) && meta.flights.some(row => row && typeof row === "object" && !(row.outbound || row.inbound) && (row.flightId || row.flightNumber || row.journeyRole));
  if (hasAccommodationMaster) {
    // Keep explicit itinerary hotel visits such as “返回酒店”. They carry
    // chronological route meaning and must not be replaced by the synthetic
    // accommodation endpoint. The synthetic anchor is added separately and
    // is used only for automatic start / end connection semantics.
    candidates.unshift(...lodgingAnchorsForDay(trip, day));
  } else if (!candidates.some(point => point.anchorType === "hotel" && point.syntheticAnchor === true)) {
    candidates.unshift(...lodgingAnchorsForDay(trip, day));
  }
  if (hasFlightMaster) {
    candidates = candidates.filter(point => point.anchorType !== "flight");
    candidates.push(...flightAnchorsForDay(trip, day));
  } else if (!candidates.some(point => point.anchorType === "flight")) {
    candidates.push(...flightAnchorsForDay(trip, day));
  }

  let stopOrder = 0;
  return candidates.map(point => ({
    ...point,
    displayOrder: point.mapRole === "stop" ? ++stopOrder : null
  }));
}

function mapPointDistanceMeters(a = {}, b = {}) {
  const lat1 = finiteNumber(a?.position?.lat), lng1 = finiteNumber(a?.position?.lng);
  const lat2 = finiteNumber(b?.position?.lat), lng2 = finiteNumber(b?.position?.lng);
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Number.POSITIVE_INFINITY;
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
function mapPointCanUseSystemAnchor(point = {}, anchor = {}) {
  const pointTeam = clean(point?.who) || "all", anchorTeam = clean(anchor?.who) || "all";
  // A Team-specific point may use its own or a shared system anchor. A shared
  // itinerary point is allowed to match Team-specific anchors too, but marker
  // suppression is decided later against the currently visible Team so a
  // Team filter can never make the shared hotel disappear.
  return pointTeam === "all" || anchorTeam === "all" || pointTeam === anchorTeam;
}
export function mergeSystemAnchorMarkers(points = [], { proximityMeters = 70 } = {}) {
  const list = Array.isArray(points) ? points : [];
  const anchors = list.filter(point => point?.position && point?.mapRole === "anchor" && point?.syntheticAnchor === true && ["flight", "hotel"].includes(clean(point?.anchorType)));
  if (!anchors.length) return list.slice();
  return list.map(point => {
    if (!point?.position || point?.syntheticAnchor === true) return point;
    if (point?.mapRole !== "stop" && point?.mapRole !== "anchor") return point;
    const pointPlaceId = clean(point?.placeId), pointResolveKey = clean(point?.resolve?.key), matches = [];
    anchors.forEach(anchor => {
      if (!mapPointCanUseSystemAnchor(point, anchor)) return;
      const pointType = clean(point?.anchorType), anchorType = clean(anchor?.anchorType);
      if (point?.mapRole === "anchor" && pointType && pointType !== anchorType) return;
      const anchorPlaceId = clean(anchor?.placeId), anchorResolveKey = clean(anchor?.resolve?.key);
      const exactPlace = Boolean(pointPlaceId && anchorPlaceId && pointPlaceId === anchorPlaceId);
      const exactResolve = Boolean(pointResolveKey && anchorResolveKey && pointResolveKey === anchorResolveKey);
      const distance = mapPointDistanceMeters(point, anchor);
      if (!exactPlace && !exactResolve && distance > Math.max(20, Number(proximityMeters) || 70)) return;
      const score = exactPlace ? -2000 : (exactResolve ? -1000 : distance);
      matches.push({ anchor, score });
    });
    if (!matches.length) return point;
    matches.sort((a,b)=>a.score-b.score);
    const best = matches[0].anchor;
    return {
      ...point,
      mergedSystemAnchorType: clean(best.anchorType),
      mergedSystemAnchorIdentity: clean(best.identity),
      matchingSystemAnchorIdentities: [...new Set(matches.map(row=>clean(row.anchor?.identity)).filter(Boolean))]
    };
  });
}

export function savedPlaceMapPoints(trip) {
  const raw = trip?.snacks;
  const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
  return rows.map((place, index) => {
    const spec = pointResolveSpec(place);
    const area = clean(place?.area);
    const category = clean(place?.category);
    const note = clean(place?.note || place?.must);
    return {
      kind: "saved",
      identity: `saved:${clean(place?.placeId) || index}`,
      placeId: clean(place?.placeId),
      order: index + 1,
      icon: "★",
      title: clean(place?.title || place?.name) || `收藏 ${index + 1}`,
      subtitle: [area, category].filter(Boolean).join(" · ") || note,
      meta: [area, category].filter(Boolean).join(" · ") || "收藏地點",
      detail: note,
      region: regionLabelFromSavedPlace(place),
      previewImages: previewImagesFromRecord(place),
      previewImage: previewImageFromRecord(place),
      mapsUrl: clean(place?.location?.mapsUrl || place?.maps || place?.mapsUrl),
      resolve: spec
    };
  }).filter(point => point.resolve.type !== "none");
}

async function geocodeOne(geocoder, point) {
  const spec = point.resolve || {};
  if (spec.type === "coords") return { ...point, position: spec.coords, resolveSource: "canonical", placeId: "" };
  const cached = cacheLookup(spec.key);
  if (cached) return {
    ...point,
    position: { lat: cached.lat, lng: cached.lng },
    formattedAddress: cached.formattedAddress,
    placeId: cached.placeId,
    resolveSource: cached.source
  };
  let resolved = null;
  if (spec.type === "airport") {
    try {
      const { Place } = await loadGooglePlacesLibrary();
      const response = await Place.searchByText({
        textQuery: clean(spec.value),
        fields: ["id", "displayName", "formattedAddress", "location"],
        includedType: "airport",
        useStrictTypeFiltering: true,
        maxResultCount: 5
      });
      const place = Array.isArray(response?.places) ? response.places[0] : null;
      const lat = finiteNumber(place?.location?.lat?.() ?? place?.location?.lat);
      const lng = finiteNumber(place?.location?.lng?.() ?? place?.location?.lng);
      if (lat != null && lng != null) {
        resolved = {
          lat,
          lng,
          formattedAddress: clean(place?.formattedAddress || place?.displayName),
          placeId: clean(place?.id)
        };
      }
    } catch (error) {
      console.warn("Airport Places resolution unavailable; falling back to Geocoder", error);
    }
  }
  if (!resolved) {
    let response;
    if (spec.type === "placeId") response = await geocoder.geocode({ placeId: spec.value });
    else if (spec.type === "query" || spec.type === "airport") response = await geocoder.geocode({ address: spec.value });
    else return null;
    const result = response?.results?.[0];
    const lat = finiteNumber(result?.geometry?.location?.lat?.());
    const lng = finiteNumber(result?.geometry?.location?.lng?.());
    if (lat == null || lng == null) return null;
    resolved = {
      lat,
      lng,
      formattedAddress: clean(result?.formatted_address),
      placeId: clean(result?.place_id)
    };
  }
  cacheStore(spec.key, resolved);
  return {
    ...point,
    position: { lat: resolved.lat, lng: resolved.lng },
    formattedAddress: resolved.formattedAddress,
    placeId: resolved.placeId,
    resolveSource: spec.type === "airport" ? "airport-resolver" : "geocoder"
  };
}

async function geocoderEditableLocations(query, { placeId = "", limit = 5 } = {}) {
  const { geocoding } = await loadGoogleMapsLibraries();
  const geocoder = new geocoding.Geocoder();
  const response = clean(placeId)
    ? await geocoder.geocode({ placeId: clean(placeId) })
    : await geocoder.geocode({ address: clean(query) });
  const max = Math.max(1, Math.min(8, Number(limit) || 5));
  return (Array.isArray(response?.results) ? response.results : []).slice(0, max).map((result, index) => {
    const latitude = finiteNumber(result?.geometry?.location?.lat?.());
    const longitude = finiteNumber(result?.geometry?.location?.lng?.());
    if (latitude == null || longitude == null) return null;
    const nextPlaceId = clean(result?.place_id);
    const address = clean(result?.formatted_address);
    const name = clean(query) || address;
    return {
      resultIndex: index,
      source: "geocoder",
      resolved: true,
      name,
      addressHint: address,
      placeId: nextPlaceId,
      latitude,
      longitude,
      address,
      mapsUrl: editableMapsUrl({ placeId: nextPlaceId, address, latitude, longitude, name })
    };
  }).filter(Boolean);
}

function formattableText(value) {
  try { return clean(value?.toString?.() ?? value); } catch (_) { return clean(value); }
}

export async function searchEditableLocations(input, { limit = 5 } = {}) {
  const raw = clean(input);
  if (!raw) return [];
  let effectiveRaw = raw;
  let linkInfo = googleMapsUrlInfo(effectiveRaw);
  if (linkInfo?.isShort) {
    effectiveRaw = await expandGoogleMapsShortLink(effectiveRaw);
    linkInfo = googleMapsUrlInfo(effectiveRaw);
    if (!linkInfo || linkInfo.isShort) { const error = new Error("Google Maps short link did not resolve"); error.code = "maps-short-link-unresolved"; throw error; }
  }
  const urlPlaceId = clean(linkInfo?.placeId || mapsPlaceIdFromUrl(effectiveRaw));
  const query = clean(linkInfo?.query || mapsQueryFromUrl(effectiveRaw) || (linkInfo ? "" : effectiveRaw));
  const max = Math.max(1, Math.min(8, Number(limit) || 5));
  if (urlPlaceId) return geocoderEditableLocations(query, { placeId: urlPlaceId, limit: max });
  if (linkInfo && !query && linkInfo.coords) {
    const manual = await reverseGeocodeEditableLocation({ latitude: linkInfo.coords.lat, longitude: linkInfo.coords.lng, name: "Google Maps 定位" });
    return [{ ...manual, source: "google-maps-link", resolved: true, addressHint: manual.address }];
  }
  if (linkInfo && !query) { const error = new Error("Google Maps link does not expose a resolvable place"); error.code = "maps-link-unresolved"; throw error; }
  try {
    const { AutocompleteSessionToken, AutocompleteSuggestion } = await loadGooglePlacesLibrary();
    const sessionToken = new AutocompleteSessionToken();
    const request = { input: query, sessionToken };
    if (linkInfo?.coords) { request.locationBias = { center: linkInfo.coords, radius: 1800 }; request.origin = linkInfo.coords; }
    const language = clean(GOOGLE_MAPS_CONFIG?.language);
    if (language) request.language = language;
    const response = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
    const suggestions = Array.isArray(response?.suggestions) ? response.suggestions : [];
    const rows = suggestions.slice(0, max).map((suggestion, index) => {
      const prediction = suggestion?.placePrediction;
      if (!prediction) return null;
      const name = formattableText(prediction.mainText) || formattableText(prediction.text) || query;
      const addressHint = formattableText(prediction.secondaryText) || formattableText(prediction.text);
      return {
        resultIndex: index,
        source: "places",
        resolved: false,
        name,
        addressHint,
        placeId: clean(prediction.placeId),
        prediction
      };
    }).filter(Boolean);
    if (rows.length) return rows;
  } catch (error) {
    console.warn("Places autocomplete unavailable; falling back to Geocoder", error);
  }
  return geocoderEditableLocations(query, { limit: max });
}

export async function resolveEditableLocationCandidate(candidate = {}) {
  if (candidate?.resolved && finiteNumber(candidate?.latitude) != null && finiteNumber(candidate?.longitude) != null) {
    return {
      name: clean(candidate?.name),
      placeId: clean(candidate?.placeId),
      latitude: finiteNumber(candidate?.latitude),
      longitude: finiteNumber(candidate?.longitude),
      address: clean(candidate?.address || candidate?.addressHint),
      mapsUrl: clean(candidate?.mapsUrl) || editableMapsUrl(candidate)
    };
  }
  const prediction = candidate?.prediction;
  if (!prediction?.toPlace) throw new Error("Place prediction is unavailable");
  const place = prediction.toPlace();
  await place.fetchFields({ fields: ["displayName", "formattedAddress", "location", "googleMapsURI"] });
  const latitude = finiteNumber(place?.location?.lat?.() ?? place?.location?.lat);
  const longitude = finiteNumber(place?.location?.lng?.() ?? place?.location?.lng);
  if (latitude == null || longitude == null) throw new Error("Selected place has no location");
  const name = clean(place?.displayName) || clean(candidate?.name);
  const placeId = clean(place?.id || candidate?.placeId);
  const address = clean(place?.formattedAddress || candidate?.addressHint);
  return {
    name,
    placeId,
    latitude,
    longitude,
    address,
    mapsUrl: clean(place?.googleMapsURI) || editableMapsUrl({ placeId, address, latitude, longitude, name })
  };
}

export async function reverseGeocodeEditableLocation({ latitude = null, longitude = null, name = "" } = {}) {
  const lat = finiteNumber(latitude), lng = finiteNumber(longitude);
  if (lat == null || lng == null) throw new Error("Coordinates are required");
  const { geocoding } = await loadGoogleMapsLibraries();
  const geocoder = new geocoding.Geocoder();
  let address = "";
  try {
    const response = await geocoder.geocode({ location: { lat, lng } });
    address = clean(response?.results?.[0]?.formatted_address);
  } catch (_) {}
  const label = clean(name) || address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  return {
    name: label,
    placeId: "",
    latitude: lat,
    longitude: lng,
    address,
    mapsUrl: editableMapsUrl({ latitude: lat, longitude: lng, name: label })
  };
}

export async function createEditableLocationPreview(container, { location = null, onPick = null } = {}) {
  if (!container) throw new Error("Location preview container is required");
  const { maps, marker } = await loadGoogleMapsLibraries();
  const initial = coordsFromLocation(location || {});
  const map = new maps.Map(container, {
    center: initial || { lat: 35.681236, lng: 139.767125 },
    zoom: initial ? 17 : 13,
    mapId: clean(GOOGLE_MAPS_CONFIG?.mapId) || "DEMO_MAP_ID",
    disableDefaultUI: true,
    clickableIcons: false,
    gestureHandling: "greedy",
    keyboardShortcuts: false
  });
  let pin = null;
  const setLocation = (next = {}, { focus = true } = {}) => {
    const position = coordsFromLocation(next);
    if (!position) return false;
    if (!pin) {
      pin = new marker.AdvancedMarkerElement({ map, position, title: clean(next?.name) || "已選定位", zIndex: 50 });
    } else {
      pin.position = position;
      pin.title = clean(next?.name) || "已選定位";
      pin.map = map;
    }
    if (focus) {
      map.panTo(position);
      if (map.getZoom() < 16) map.setZoom(17);
    }
    return true;
  };
  if (initial) setLocation(location, { focus: false });
  const clickListener = map.addListener("click", event => {
    const lat = finiteNumber(event?.latLng?.lat?.());
    const lng = finiteNumber(event?.latLng?.lng?.());
    if (lat == null || lng == null) return;
    const next = { latitude: lat, longitude: lng, name: clean(location?.name) };
    setLocation(next, { focus: false });
    try { onPick?.({ latitude: lat, longitude: lng }); } catch (_) {}
  });
  return {
    map,
    setLocation(next = {}, options = {}) { return setLocation(next, options); },
    destroy() {
      try { clickListener?.remove?.(); } catch (_) {}
      try { if (pin) pin.map = null; } catch (_) {}
      pin = null;
      container.replaceChildren();
    }
  };
}

export async function resolveMapPoints(points, { concurrency = 3, onProgress = null } = {}) {
  const list = Array.isArray(points) ? points : [];
  if (!list.length) return { resolved: [], unresolved: [] };
  const { geocoding } = await loadGoogleMapsLibraries();
  const geocoder = new geocoding.Geocoder();
  const resolved = [], unresolved = [];
  let cursor = 0, completed = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      const point = list[index];
      try {
        const row = await geocodeOne(geocoder, point);
        if (row?.position) resolved.push(row); else unresolved.push(point);
      } catch (_) { unresolved.push(point); }
      completed += 1;
      try { onProgress?.({ completed, total: list.length, resolved: resolved.length, unresolved: unresolved.length }); } catch (_) {}
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  resolved.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  return { resolved, unresolved };
}

function transitVehicleIcon(vehicleType = "", fallbackMode = "TRANSIT") {
  const raw = clean(vehicleType).toUpperCase();
  if (/SUBWAY|METRO/.test(raw)) return "🚇";
  if (/BUS|TROLLEYBUS/.test(raw)) return "🚌";
  if (/TRAM|LIGHT_RAIL/.test(raw)) return "🚊";
  if (/RAIL|TRAIN|COMMUTER|HIGH_SPEED|HEAVY_RAIL|MONORAIL/.test(raw)) return "🚆";
  if (/FERRY|BOAT/.test(raw)) return "⛴️";
  if (clean(fallbackMode).toUpperCase() === "WALKING") return "🚶";
  return "🚆";
}
function durationTextFromMillis(value) {
  const minutes = Math.max(0, Math.round(Number(value || 0) / 60000));
  if (!minutes) return "";
  if (minutes < 60) return `約 ${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `約 ${hours} 小時 ${rest} 分鐘` : `約 ${hours} 小時`;
}
function isoTime(value) {
  try { return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : ""; } catch (_) { return ""; }
}
function transitStepPlain(step = {}) {
  const mode = clean(step?.travelMode).toUpperCase() || "UNKNOWN";
  const details = step?.transitDetails || null;
  const line = details?.transitLine || null;
  const vehicleType = clean(line?.vehicle?.vehicleType || line?.vehicle?.name);
  const lineName = clean(line?.shortName || line?.name || line?.vehicle?.name);
  const departureStop = clean(details?.departureStop?.name);
  const arrivalStop = clean(details?.arrivalStop?.name);
  return {
    mode,
    icon: transitVehicleIcon(vehicleType, mode),
    instruction: clean(step?.instructions),
    durationText: clean(step?.localizedValues?.staticDuration) || durationTextFromMillis(step?.staticDurationMillis),
    distanceText: clean(step?.localizedValues?.distance),
    transit: details ? {
      lineName,
      lineColor: clean(line?.color),
      textColor: clean(line?.textColor),
      vehicleType,
      headsign: clean(details?.headsign),
      departureStop,
      arrivalStop,
      departureTime: isoTime(details?.departureTime),
      arrivalTime: isoTime(details?.arrivalTime),
      stopCount: Number(details?.stopCount || 0),
      tripShortText: clean(details?.tripShortText),
      agency: clean(line?.agencies?.[0]?.name)
    } : null
  };
}
function routePathPlain(route = {}) {
  return (Array.isArray(route?.path) ? route.path : []).map(point => {
    const latSource = typeof point?.lat === "function" ? point.lat() : (point?.lat ?? point?.latitude);
    const lngSource = typeof point?.lng === "function" ? point.lng() : (point?.lng ?? point?.longitude);
    const lat = finiteNumber(latSource), lng = finiteNumber(lngSource);
    return lat == null || lng == null ? null : { lat, lng };
  }).filter(Boolean);
}
function transitRoutePlain(route = {}, index = 0) {
  const steps = (Array.isArray(route?.legs) ? route.legs : []).flatMap(leg => Array.isArray(leg?.steps) ? leg.steps : []).map(transitStepPlain);
  const transitSteps = steps.filter(step => step.transit);
  const modeChain = [];
  steps.forEach(step => {
    const token = step.transit?.lineName ? `${step.icon} ${step.transit.lineName}` : step.icon;
    if (token && modeChain[modeChain.length - 1] !== token) modeChain.push(token);
  });
  const firstTransit = transitSteps[0]?.transit || null;
  const lastTransit = transitSteps[transitSteps.length - 1]?.transit || null;
  return {
    id: `route-${index + 1}`,
    index,
    durationText: clean(route?.localizedValues?.duration) || durationTextFromMillis(route?.durationMillis),
    distanceText: clean(route?.localizedValues?.distance),
    departureTime: firstTransit?.departureTime || "",
    arrivalTime: lastTransit?.arrivalTime || "",
    rideCount: transitSteps.length,
    transferCount: Math.max(0, transitSteps.length - 1),
    modeChain,
    path: routePathPlain(route),
    segments: [],
    steps,
    fare: null,
    provider: "google-routes-transit",
    attribution: ["Google Maps"],
    warnings: Array.isArray(route?.warnings) ? route.warnings.map(clean).filter(Boolean) : []
  };
}
function transitDepartureSupport(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return { supported: false, reason: "missing" };
  const now = Date.now(), delta = date.getTime() - now;
  const min = -7 * 24 * 60 * 60 * 1000, max = 100 * 24 * 60 * 60 * 1000;
  return delta >= min && delta <= max ? { supported: true, reason: "scheduled" } : { supported: false, reason: "outside-window" };
}
function routeLocationFromResolved(row = {}) {
  const placeId = clean(row?.placeId);
  if (placeId) return `places/${placeId}`;
  const address = clean(row?.formattedAddress);
  if (address) return address;
  return row?.position || null;
}
async function resolveRecordPosition(record = {}) {
  const spec = pointResolveSpec(record);
  if (spec.type === "none") return null;
  const { geocoding } = await loadGoogleMapsLibraries();
  const geocoder = new geocoding.Geocoder();
  const row = await geocodeOne(geocoder, { resolve: spec });
  if (!row?.position) return null;
  const resolved = {
    position: row.position,
    formattedAddress: clean(row.formattedAddress),
    placeId: clean(row.placeId),
    resolveSource: clean(row.resolveSource)
  };
  resolved.routeLocation = routeLocationFromResolved(resolved);
  return resolved;
}
export async function resolveTransitEndpoint(record = {}) {
  return resolveRecordPosition(record);
}
function transitRequestCacheKey(origin, destination, effectiveDepartureTime) {
  const a = origin?.position, b = destination?.position;
  if (!a || !b) return "";
  const stamp = effectiveDepartureTime instanceof Date && Number.isFinite(effectiveDepartureTime.getTime())
    ? Math.floor(effectiveDepartureTime.getTime() / 300000)
    : "now";
  return `${Number(a.lat).toFixed(5)},${Number(a.lng).toFixed(5)}>${Number(b.lat).toFixed(5)},${Number(b.lng).toFixed(5)}@${stamp}`;
}
async function computeTransitRoutesOnce(Route, { origin, destination, departureTime, alternatives = true } = {}) {
  const request = {
    origin,
    destination,
    travelMode: "TRANSIT",
    departureTime,
    computeAlternativeRoutes: alternatives,
    fields: ["durationMillis", "localizedValues", "legs", "path", "warnings"]
  };
  const response = await Route.computeRoutes(request);
  return Array.isArray(response?.routes) ? response.routes : [];
}
export async function computeTransitRouteOptions({ origin = null, destination = null, departureTime = null } = {}) {
  if (!origin || !destination) {
    const error = new Error("Transit origin and destination are required");
    error.code = "transit-context-missing";
    throw error;
  }
  const [resolvedOrigin, resolvedDestination] = await Promise.all([resolveRecordPosition(origin), resolveRecordPosition(destination)]);
  if (!resolvedOrigin?.position || !resolvedDestination?.position) {
    const error = new Error("Transit origin or destination could not be located");
    error.code = "transit-location-unresolved";
    throw error;
  }
  const support = transitDepartureSupport(departureTime);
  const basis = support.supported ? "scheduled" : "now-fallback";
  // v7.9.8.1 relied on an omitted departureTime to mean "now". Google documents
  // that behaviour, but an explicit Date is more deterministic and makes the
  // fallback request identical to the official Transit example.
  const effectiveDepartureTime = support.supported ? departureTime : new Date();
  const cacheKey = transitRequestCacheKey(resolvedOrigin, resolvedDestination, effectiveDepartureTime);
  if (cacheKey && transitRouteMemoryCache.has(cacheKey)) return transitRouteMemoryCache.get(cacheKey);
  const promise = (async () => {
    const routes = await loadGoogleRoutesLibrary();
    const Route = routes?.Route;
    if (!Route?.computeRoutes) {
      const error = new Error("Google Routes library is unavailable");
      error.code = "routes-unavailable";
      throw error;
    }

    // Prefer the geocoder's Place resource name when available. Google recommends
    // Place-based route endpoints because raw coordinates can snap to a nearby
    // road rather than a useful entrance / transit access point.
    const preferredOrigin = resolvedOrigin.routeLocation || resolvedOrigin.position;
    const preferredDestination = resolvedDestination.routeLocation || resolvedDestination.position;
    let routeRows = await computeTransitRoutesOnce(Route, {
      origin: preferredOrigin,
      destination: preferredDestination,
      departureTime: effectiveDepartureTime,
      alternatives: true
    });

    // A zero-route response is a valid API response rather than an exception.
    // Retry once with the already resolved coordinates only when the preferred
    // Place/address endpoints produced no route. This keeps normal cost at one
    // Routes call while giving legacy location data a conservative recovery path.
    const preferredUsesCoordinates = preferredOrigin === resolvedOrigin.position && preferredDestination === resolvedDestination.position;
    if (!routeRows.length && !preferredUsesCoordinates) {
      routeRows = await computeTransitRoutesOnce(Route, {
        origin: resolvedOrigin.position,
        destination: resolvedDestination.position,
        departureTime: effectiveDepartureTime,
        alternatives: false
      });
    }

    const options = routeRows.slice(0, 4).map(transitRoutePlain);
    return {
      options,
      basis,
      requestedDepartureTime: support.supported ? departureTime.toISOString() : "",
      effectiveDepartureTime: effectiveDepartureTime.toISOString(),
      origin: resolvedOrigin,
      destination: resolvedDestination
    };
  })();
  if (cacheKey) transitRouteMemoryCache.set(cacheKey, promise);
  try { return await promise; } catch (error) { if (cacheKey) transitRouteMemoryCache.delete(cacheKey); throw error; }
}

function markerElement(point) {
  const el = document.createElement("div");
  const isSaved = point.kind === "saved";
  const isAnchor = point.kind === "itinerary" && point.mapRole === "anchor";
  const isTransit = point.kind === "itinerary" && point.itemKind === ITINERARY_ITEM_KIND.TRANSIT && !isAnchor;
  const anchorClass = isAnchor && point.anchorType ? ` is-anchor-${clean(point.anchorType)}` : "";
  el.className = `trip-map-marker ${isSaved ? "is-saved" : "is-itinerary"}${isTransit ? " is-transit" : ""}${isAnchor ? ` is-anchor${anchorClass}` : ""}`;
  el.textContent = isSaved ? "★" : (isAnchor ? anchorIcon(point.anchorType, point.icon) : (isTransit ? (point.icon || "↗︎") : String(point.displayOrder || "•")));
  el.setAttribute("aria-hidden", "true");
  return el;
}

export async function createTransitRoutePreview(container, { route = null, origin = null, destination = null } = {}) {
  if (!container) throw new Error("Transit route map container is required");
  const { maps, marker, core } = await loadGoogleMapsLibraries();
  const map = new maps.Map(container, {
    center: origin?.position || destination?.position || { lat: 22.3027, lng: 114.1772 },
    zoom: 13,
    mapId: clean(GOOGLE_MAPS_CONFIG?.mapId) || "DEMO_MAP_ID",
    disableDefaultUI: true,
    clickableIcons: false,
    gestureHandling: "cooperative",
    keyboardShortcuts: false
  });
  let overlays = [];
  const removeOverlays = () => {
    overlays.forEach(row => {
      try { if (row?.setMap) row.setMap(null); else if ("map" in row) row.map = null; } catch (_) {}
    });
    overlays = [];
  };
  const markerContent = label => {
    const el = document.createElement("div");
    el.textContent = label;
    Object.assign(el.style, {
      width: "28px", height: "28px", borderRadius: "999px", display: "grid", placeItems: "center",
      background: "#111114", color: "#fff", border: "2px solid #fff", boxShadow: "0 2px 8px rgba(0,0,0,.24)",
      fontSize: "12px", fontWeight: "800", lineHeight: "1"
    });
    return el;
  };
  const setRoute = ({ route: nextRoute = null, origin: nextOrigin = null, destination: nextDestination = null } = {}) => {
    removeOverlays();
    const path = Array.isArray(nextRoute?.path) ? nextRoute.path.filter(point => finiteNumber(point?.lat) != null && finiteNumber(point?.lng) != null) : [];
    const segments = (Array.isArray(nextRoute?.segments) ? nextRoute.segments : []).map(segment => ({
      ...segment,
      path: (Array.isArray(segment?.path) ? segment.path : []).filter(point => finiteNumber(point?.lat) != null && finiteNumber(point?.lng) != null)
    })).filter(segment => segment.path.length > 1);
    if (maps.Polyline && segments.length) {
      segments.forEach((segment, index) => {
        const isWalk = clean(segment?.kind).toLowerCase() === "walk";
        const color = /^#[0-9a-f]{6}$/i.test(clean(segment?.color)) ? clean(segment.color) : (isWalk ? "#8e8e93" : "#0a84ff");
        const halo = new maps.Polyline({ map, path: segment.path, clickable: false, geodesic: false, strokeColor: "#ffffff", strokeOpacity: .90, strokeWeight: isWalk ? 6 : 8, zIndex: 1 + index * 2 });
        const line = new maps.Polyline({ map, path: segment.path, clickable: false, geodesic: false, strokeColor: color, strokeOpacity: isWalk ? .74 : .96, strokeWeight: isWalk ? 3 : 5, zIndex: 2 + index * 2 });
        overlays.push(halo, line);
      });
    } else if (path.length > 1 && maps.Polyline) {
      const halo = new maps.Polyline({ map, path, clickable: false, geodesic: false, strokeColor: "#ffffff", strokeOpacity: .94, strokeWeight: 8, zIndex: 1 });
      const line = new maps.Polyline({ map, path, clickable: false, geodesic: false, strokeColor: "#0a84ff", strokeOpacity: .96, strokeWeight: 5, zIndex: 2 });
      overlays.push(halo, line);
    }
    const start = nextOrigin?.position || path[0] || segments[0]?.path?.[0] || null;
    const lastSegmentPath = segments[segments.length - 1]?.path || [];
    const end = nextDestination?.position || path[path.length - 1] || lastSegmentPath[lastSegmentPath.length - 1] || null;
    if (start) {
      const pin = new marker.AdvancedMarkerElement({ map, position: start, content: markerContent("A"), zIndex: 20 });
      overlays.push(pin);
    }
    if (end) {
      const pin = new marker.AdvancedMarkerElement({ map, position: end, content: markerContent("B"), zIndex: 20 });
      overlays.push(pin);
    }
    const bounds = new core.LatLngBounds();
    path.forEach(point => bounds.extend(point));
    if (start) bounds.extend(start);
    if (end) bounds.extend(end);
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { top: 30, right: 28, bottom: 36, left: 28 });
      core.event.addListenerOnce(map, "idle", () => { if (map.getZoom() > 16) map.setZoom(16); });
    }
  };
  setRoute({ route, origin, destination });
  return {
    map,
    setRoute(next = {}) { setRoute(next); },
    destroy() { removeOverlays(); container.replaceChildren(); }
  };
}

export async function createTripMap(container, { points = [], onSelect = null, onMapTap = null, connectSequence = false, routeGroups = [], initialFocusPoints = null, focusPaddingTop = 122, showSequenceLine = true } = {}) {
  if (!container) throw new Error("Map container is required");
  const { maps, marker, core } = await loadGoogleMapsLibraries();
  const map = new maps.Map(container, {
    center: points[0]?.position || { lat: 35.0116, lng: 135.7681 },
    zoom: points.length === 1 ? 14 : 11,
    mapId: clean(GOOGLE_MAPS_CONFIG?.mapId) || "DEMO_MAP_ID",
    disableDefaultUI: true,
    clickableIcons: false,
    gestureHandling: "greedy",
    keyboardShortcuts: false
  });

  const markerRows = [];
  const routeOverlays = [];
  const pointByIdentity = new Map();
  points.forEach(point => { if (point?.identity && point?.position) pointByIdentity.set(point.identity, point); });

  const focusPoints = (focusRows, { maxZoom = 15, padding = null } = {}) => {
    const rows = (Array.isArray(focusRows) ? focusRows : []).filter(row => row?.position);
    if (!rows.length) return;
    if (rows.length === 1) {
      map.panTo(rows[0].position);
      if (map.getZoom() !== 14) map.setZoom(14);
      return;
    }
    const bounds = new core.LatLngBounds();
    rows.forEach(row => bounds.extend(row.position));
    map.fitBounds(bounds, padding || { top: Math.max(122, Number(focusPaddingTop) || 122), right: 34, bottom: 188, left: 34 });
    core.event.addListenerOnce(map, "idle", () => { if (map.getZoom() > maxZoom) map.setZoom(maxZoom); });
  };

  const clearRouteOverlays = () => {
    routeOverlays.splice(0).forEach(line => { try { line.setMap(null); } catch (_) {} });
  };
  const renderRouteGroups = (groupsInput = [], visible = true) => {
    clearRouteOverlays();
    const effectiveRouteGroups = Array.isArray(groupsInput) && groupsInput.length
      ? groupsInput
      : (connectSequence ? [{ points, color: "#007aff" }] : []);
    effectiveRouteGroups.forEach((group, groupIndex) => {
      const rows = (Array.isArray(group?.points) ? group.points : []).slice().sort((a, b) => Number(a.routeOrder ?? a.order ?? 0) - Number(b.routeOrder ?? b.order ?? 0));
      const paths = [];
      let current = [];
      rows.forEach(point => {
        if (point?.routeEligible === false) return;
        if (point?.itemKind === ITINERARY_ITEM_KIND.TRANSIT && point?.mapRole !== "anchor") return;
        if (!point?.position) {
          if (current.length > 1) paths.push(current);
          current = [];
          return;
        }
        current.push(point.position);
      });
      if (current.length > 1) paths.push(current);
      const color = clean(group?.color) || "#007aff";
      paths.forEach((path, pathIndex) => {
        if (!maps.Polyline) return;
        const zBase = 1 + groupIndex * 20 + pathIndex * 2;
        const halo = new maps.Polyline({
          map: visible ? map : null, path, clickable: false, geodesic: false,
          strokeColor: "#ffffff", strokeOpacity: effectiveRouteGroups.length > 1 ? 0.72 : 0.88, strokeWeight: 8, zIndex: zBase
        });
        const arrowPath = window.google?.maps?.SymbolPath?.FORWARD_CLOSED_ARROW;
        const icons = arrowPath ? [{
          icon: {
            path: arrowPath,
            scale: 4.15,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeOpacity: 0.92,
            strokeWeight: 1.15
          },
          offset: "58px",
          repeat: "132px"
        }] : undefined;
        const route = new maps.Polyline({
          map: visible ? map : null, path, clickable: false, geodesic: false,
          strokeColor: color, strokeOpacity: effectiveRouteGroups.length > 1 ? 0.84 : 0.92, strokeWeight: 4,
          icons, zIndex: zBase + 1
        });
        routeOverlays.push(halo, route);
      });
    });
  };
  renderRouteGroups(routeGroups, showSequenceLine);

  points.forEach(point => {
    if (!point?.position) return;
    const advanced = new marker.AdvancedMarkerElement({
      map,
      position: point.position,
      title: point.title,
      content: markerElement(point),
      // AdvancedMarker defaults to bottom-centre anchoring. Trip Overview
      // routes use the same geographic point, so centre-anchor the circular
      // marker to make the polyline pass through its visual centre.
      anchorLeft: "-50%",
      anchorTop: "-50%",
      gmpClickable: true,
      zIndex: 100 + Number(point.order || 0)
    });
    advanced.addEventListener("gmp-click", () => { try { onSelect?.(point, advanced, map); } catch (_) {} });
    markerRows.push({ point, marker: advanced, content: advanced.content, baseZIndex: 100 + Number(point.order || 0) });
  });

  const initialRows = Array.isArray(initialFocusPoints) && initialFocusPoints.length ? initialFocusPoints : points;
  focusPoints(initialRows, { maxZoom: 15, padding: { top: Math.max(122, Number(focusPaddingTop) || 122), right: 34, bottom: 188, left: 34 } });
  map.addListener("click", () => { try { onMapTap?.(); } catch (_) {} });

  return {
    map,
    markers: markerRows.map(row => row.marker),
    points: points.slice(),
    focusPoints,
    setVisibleIdentities(identities, { focus = true } = {}) {
      const wanted = identities == null ? null : new Set(Array.isArray(identities) ? identities : []);
      const visible = [];
      markerRows.forEach(row => {
        const show = !wanted || wanted.has(row.point.identity);
        row.marker.map = show ? map : null;
        if (!show) { try { row.content?.classList?.remove("is-selected"); row.marker.zIndex = row.baseZIndex; } catch (_) {} }
        if (show) visible.push(row.point);
      });
      if (focus && visible.length) focusPoints(visible, { maxZoom: 15, padding: { top: 168, right: 34, bottom: 188, left: 34 } });
      return visible;
    },
    setSelectedIdentity(identity = "") {
      const selected = String(identity || "");
      markerRows.forEach(row => {
        const active = Boolean(selected && row.point.identity === selected);
        try { row.content?.classList?.toggle("is-selected", active); } catch (_) {}
        try { row.marker.zIndex = active ? 10000 : row.baseZIndex; } catch (_) {}
      });
    },
    setRouteVisible(visible = true) {
      const show = Boolean(visible);
      routeOverlays.forEach(line => { try { line.setMap(show ? map : null); } catch (_) {} });
    },
    setRouteGroups(nextGroups = [], { visible = true } = {}) {
      renderRouteGroups(nextGroups, Boolean(visible));
    },
    point(identity) { return pointByIdentity.get(identity) || null; },
    destroy() {
      markerRows.forEach(row => { try { row.marker.map = null; } catch (_) {} });
      routeOverlays.forEach(line => { try { line.setMap(null); } catch (_) {} });
      container.replaceChildren();
    }
  };
}
