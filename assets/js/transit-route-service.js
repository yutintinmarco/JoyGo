import { computeGoogleTransitRouteOptions, GOOGLE_TRANSIT_PROVIDER_ID } from "./transit-providers/google-transit-provider.js";
import { computeJapanTransitRouteOptions, JAPAN_TRANSIT_PROVIDER_ID } from "./transit-providers/japan-transit-provider.js";
import { evaluateTransitRouteResult } from "./transit-route-quality-service.js";
import { buildTransitRouteCacheKey, getTransitRouteCache, putTransitRouteCache } from "./transit-route-cache-service.js";

function clean(value) { return String(value ?? "").trim(); }
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function coordsFromRecord(record = {}) {
  const location = record?.location && typeof record.location === "object" ? record.location : record;
  const lat = finiteNumber(location?.latitude ?? location?.lat);
  const lng = finiteNumber(location?.longitude ?? location?.lng ?? location?.lon);
  return lat == null || lng == null ? null : { lat, lng };
}
function coordsWithinJapan(point) {
  if (!point) return false;
  // Conservative island-group envelopes used only as a pre-request provider
  // hint when explicit country/timezone metadata is absent. They deliberately
  // avoid the Korean peninsula rather than treating one giant bbox as Japan.
  const boxes = [
    [41.0, 46.5, 139.0, 146.5],
    [34.0, 41.6, 130.5, 142.5],
    [30.0, 35.5, 129.5, 135.2],
    [24.0, 30.5, 122.5, 131.5]
  ];
  return boxes.some(([minLat, maxLat, minLng, maxLng]) => point.lat >= minLat && point.lat <= maxLat && point.lng >= minLng && point.lng <= maxLng);
}
export function selectTransitProvider({ origin = null, destination = null, locationContext = null } = {}) {
  const countryCode = clean(locationContext?.countryCode || locationContext?.country).toUpperCase();
  if (["JP", "JPN", "JAPAN", "日本"].includes(countryCode)) return JAPAN_TRANSIT_PROVIDER_ID;
  const providerTimeZone = clean(locationContext?.providerTimeZone);
  if (providerTimeZone === "Asia/Tokyo") return JAPAN_TRANSIT_PROVIDER_ID;
  const cityLat = finiteNumber(locationContext?.latitude), cityLng = finiteNumber(locationContext?.longitude);
  if (cityLat != null && cityLng != null && coordsWithinJapan({ lat: cityLat, lng: cityLng })) return JAPAN_TRANSIT_PROVIDER_ID;
  const a = coordsFromRecord(origin), b = coordsFromRecord(destination);
  if (coordsWithinJapan(a) && coordsWithinJapan(b)) return JAPAN_TRANSIT_PROVIDER_ID;
  return GOOGLE_TRANSIT_PROVIDER_ID;
}


function plainCopy(value) {
  if (Array.isArray(value)) return value.map(plainCopy);
  if (!value || typeof value !== "object") return value;
  const out = {};
  Object.entries(value).forEach(([key, next]) => {
    if (typeof next === "undefined") return;
    out[key] = plainCopy(next);
  });
  return out;
}
function normalizePoint(point = {}) {
  const lat = finiteNumber(point?.lat ?? point?.latitude);
  const lng = finiteNumber(point?.lng ?? point?.longitude ?? point?.lon);
  return lat == null || lng == null ? null : { lat, lng };
}
function thinPath(points = [], maxPoints = 220) {
  const cleanPoints = (Array.isArray(points) ? points : []).map(normalizePoint).filter(Boolean);
  if (cleanPoints.length <= maxPoints) return cleanPoints;
  const out = [], last = cleanPoints.length - 1;
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round((i * last) / Math.max(1, maxPoints - 1));
    const point = cleanPoints[index];
    const previous = out[out.length - 1];
    if (!previous || previous.lat !== point.lat || previous.lng !== point.lng) out.push(point);
  }
  return out;
}
function canonicalEndpoint(record = {}, fallback = {}) {
  const source = record && typeof record === "object" ? record : {};
  const fallbackLoc = fallback?.location && typeof fallback.location === "object" ? fallback.location : {};
  const position = normalizePoint(source?.position || source) || normalizePoint(fallbackLoc);
  return {
    name: clean(source?.name || fallback?.title || fallbackLoc?.name),
    placeId: clean(source?.placeId || fallbackLoc?.placeId),
    formattedAddress: clean(source?.formattedAddress || fallbackLoc?.address || fallback?.address),
    position: position || null
  };
}
function canonicalTransitStep(step = {}) {
  const transit = step?.transit && typeof step.transit === "object" ? step.transit : null;
  return {
    mode: clean(step?.mode),
    icon: clean(step?.icon),
    instruction: clean(step?.instruction),
    durationText: clean(step?.durationText),
    distanceText: clean(step?.distanceText),
    role: clean(step?.role),
    ...(transit ? { transit: {
      lineName: clean(transit?.lineName),
      lineColor: clean(transit?.lineColor),
      textColor: clean(transit?.textColor),
      vehicleType: clean(transit?.vehicleType),
      headsign: clean(transit?.headsign),
      departureStop: clean(transit?.departureStop),
      arrivalStop: clean(transit?.arrivalStop),
      departureTime: clean(transit?.departureTime),
      arrivalTime: clean(transit?.arrivalTime),
      stopCount: Math.max(0, Number(transit?.stopCount || 0)),
      tripShortText: clean(transit?.tripShortText),
      agency: clean(transit?.agency),
      departurePlatform: clean(transit?.departurePlatform),
      arrivalPlatform: clean(transit?.arrivalPlatform)
    } } : {})
  };
}
export function transitRouteIdentity(providerInput = "", route = {}) {
  const provider = clean(providerInput || route?.provider);
  const stepKey = (Array.isArray(route?.steps) ? route.steps : []).map(step => [
    clean(step?.mode), clean(step?.transit?.lineName), clean(step?.transit?.departureStop), clean(step?.transit?.arrivalStop)
  ].join("~")).join(">");
  return [provider, clean(route?.id), clean(route?.departureTime), clean(route?.arrivalTime), clean(route?.durationText), (route?.modeChain || []).join("~"), stepKey].join("|");
}
export function buildPlannedTransitSnapshot({ result = {}, route = {}, context = {} } = {}) {
  const provider = clean(result?.provider || route?.provider);
  const segments = (Array.isArray(route?.segments) ? route.segments : []).slice(0, 12).map((segment, index) => ({
    id: clean(segment?.id) || `segment-${index + 1}`,
    kind: clean(segment?.kind),
    routeName: clean(segment?.routeName),
    color: clean(segment?.color),
    geometrySource: clean(segment?.geometrySource),
    path: thinPath(segment?.path, 72)
  })).filter(segment => segment.path.length > 1);
  const fare = route?.fare && typeof route.fare === "object" ? plainCopy(route.fare) : null;
  return {
    schemaVersion: 1,
    routeKey: transitRouteIdentity(provider, route),
    sourceProvider: provider,
    sourceRouteId: clean(route?.id),
    sourceBasis: clean(result?.basis),
    adoptedAt: new Date().toISOString(),
    queryDate: clean(result?.queryDate),
    timeZone: clean(result?.timeZone || context?.timeZone),
    origin: canonicalEndpoint(result?.origin, context?.origin),
    destination: canonicalEndpoint(result?.destination, context?.destination),
    durationText: clean(route?.durationText),
    distanceText: clean(route?.distanceText),
    departureTime: clean(route?.departureTime),
    arrivalTime: clean(route?.arrivalTime),
    rideCount: Math.max(0, Number(route?.rideCount || 0)),
    transferCount: Math.max(0, Number(route?.transferCount || 0)),
    routeType: clean(route?.routeType),
    modeChain: (Array.isArray(route?.modeChain) ? route.modeChain : []).map(clean).filter(Boolean),
    steps: (Array.isArray(route?.steps) ? route.steps : []).slice(0, 28).map(canonicalTransitStep),
    fare: fare || null,
    warnings: (Array.isArray(route?.warnings) ? route.warnings : []).map(clean).filter(Boolean).slice(0, 8),
    recommended: Boolean(route?.recommended),
    rank: finiteNumber(route?.rank),
    confidence: clean(route?.confidence),
    path: thinPath(route?.path, 240),
    segments
  };
}
export function plannedTransitMatchesRoute(planned = null, result = {}, route = {}) {
  if (!planned || typeof planned !== "object") return false;
  return clean(planned?.routeKey) === transitRouteIdentity(result?.provider || route?.provider, route);
}

export async function computeTransitRouteOptions(request = {}) {
  const provider = selectTransitProvider(request);
  const cacheKey = buildTransitRouteCacheKey(provider, request);
  const cached = await getTransitRouteCache(cacheKey);
  if (cached?.fresh && cached?.result) {
    return { ...cached.result, cache: { source: "indexeddb", hit: true, stale: false, cachedAt: cached.cachedAt } };
  }
  try {
    const providerResult = provider === JAPAN_TRANSIT_PROVIDER_ID
      ? await computeJapanTransitRouteOptions(request)
      : await computeGoogleTransitRouteOptions(request);
    const result = evaluateTransitRouteResult(providerResult);
    void putTransitRouteCache(cacheKey, result, { tripId: request?.tripId || "" });
    return { ...result, cache: { source: "provider", hit: false, stale: false, cachedAt: Date.now() } };
  } catch (error) {
    if (cached?.result) {
      console.warn("Transit provider unavailable; using stale local route cache", error);
      return { ...cached.result, cache: { source: "indexeddb", hit: true, stale: true, cachedAt: cached.cachedAt } };
    }
    throw error;
  }
}
