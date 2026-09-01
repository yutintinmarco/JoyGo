import { resolveTransitEndpoint } from "../trip-map-service.js";

export const JAPAN_TRANSIT_PROVIDER_ID = "ls8h";
const LS8H_BASE_URL = "https://api.transit.ls8h.com";

function clean(value) { return String(value ?? "").trim(); }
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function hasBrokenText(value) {
  return typeof value === "string" && value.includes("\uFFFD");
}
function safeText(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text && !hasBrokenText(text)) return text;
  }
  return "";
}
function endpointLabel(record = {}, fallback = "地點") {
  return safeText(record?.title, record?.location?.name, record?.name, record?.location?.address, record?.address, fallback) || fallback;
}
function routeEndpoint(resolved = {}) {
  const lat = finiteNumber(resolved?.position?.lat), lng = finiteNumber(resolved?.position?.lng);
  return lat == null || lng == null ? "" : `geo:${lat.toFixed(6)},${lng.toFixed(6)}`;
}
function pad2(value) { return String(value).padStart(2, "0"); }
function zonedParts(date, timeZone) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "Asia/Tokyo",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
    return {
      year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
      hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second || 0)
    };
  } catch (_) { return null; }
}
function requestDateTime(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  if (!parts) return null;
  return {
    date: `${parts.year}${pad2(parts.month)}${pad2(parts.day)}`,
    time: `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`
  };
}
function zonedLocalToDate(year, month, day, hour, minute, second, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second), target = guess;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "Asia/Tokyo",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    });
    for (let pass = 0; pass < 3; pass += 1) {
      const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
      const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second || 0));
      guess -= represented - target;
    }
  } catch (_) {}
  return new Date(guess);
}
function serviceSecondsIso(serviceDate, seconds, timeZone) {
  const match = clean(serviceDate).replace(/-/g, "").match(/^(\d{4})(\d{2})(\d{2})$/);
  const secs = finiteNumber(seconds);
  if (!match || secs == null) return "";
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0) + Math.round(secs * 1000);
  const local = new Date(base);
  const date = zonedLocalToDate(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), timeZone);
  try { return Number.isFinite(date.getTime()) ? date.toISOString() : ""; } catch (_) { return ""; }
}
function durationTextFromSeconds(value) {
  const minutes = Math.max(0, Math.round(Number(value || 0) / 60));
  if (!minutes) return "";
  if (minutes < 60) return `約 ${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `約 ${hours} 小時 ${rest} 分鐘` : `約 ${hours} 小時`;
}
function vehicleIcon(mode = "") {
  const raw = clean(mode).toLowerCase();
  if (raw === "subway") return "🚇";
  if (raw === "bus" || raw === "trolleybus") return "🚌";
  if (raw === "tram") return "🚊";
  if (["rail", "monorail", "funicular", "cabletram", "aeriallift"].includes(raw.replace(/[^a-z]/g, ""))) return "🚆";
  if (raw === "ferry") return "⛴️";
  if (raw === "air") return "✈️";
  return "🚆";
}
function validColor(value) {
  const raw = clean(value);
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : "";
}
function normalizePoint(point = {}) {
  const lat = finiteNumber(point?.lat), lng = finiteNumber(point?.lon ?? point?.lng);
  return lat == null || lng == null ? null : { lat, lng };
}
function normalizeMapSegments(map = {}) {
  return (Array.isArray(map?.segments) ? map.segments : []).map((segment, index) => {
    const path = (Array.isArray(segment?.polyline) ? segment.polyline : []).map(normalizePoint).filter(Boolean);
    return {
      id: `segment-${index + 1}`,
      kind: clean(segment?.kind).toLowerCase() === "walk" ? "walk" : "transit",
      routeName: safeText(segment?.routeName),
      color: validColor(segment?.color),
      geometrySource: safeText(segment?.geometrySource),
      path
    };
  }).filter(segment => segment.path.length > 1);
}
function flattenSegmentPath(segments = []) {
  const output = [];
  segments.forEach(segment => {
    (segment?.path || []).forEach(point => {
      const previous = output[output.length - 1];
      if (!previous || Math.abs(previous.lat - point.lat) > 1e-7 || Math.abs(previous.lng - point.lng) > 1e-7) output.push(point);
    });
  });
  return output;
}
function journeyLegStep(leg = {}, serviceDate, timeZone) {
  const kind = clean(leg?.kind).toLowerCase();
  const departureTime = serviceSecondsIso(serviceDate, leg?.departureSecs, timeZone);
  const arrivalTime = serviceSecondsIso(serviceDate, leg?.arrivalSecs, timeZone);
  const durationSecs = finiteNumber(leg?.arrivalSecs) != null && finiteNumber(leg?.departureSecs) != null ? Number(leg.arrivalSecs) - Number(leg.departureSecs) : 0;
  const fromName = safeText(leg?.from?.name, leg?.from?.id, kind === "walk" ? "步行起點" : "車站");
  const toName = safeText(leg?.to?.name, leg?.to?.id, kind === "walk" ? "步行終點" : "車站");
  if (kind === "walk") {
    return {
      mode: "WALKING",
      icon: "🚶",
      instruction: fromName && toName ? `步行 ${fromName} → ${toName}` : "步行",
      durationText: durationTextFromSeconds(durationSecs),
      distanceText: "",
      transit: null,
      role: "walk"
    };
  }
  const mode = safeText(leg?.mode, "rail");
  const lineName = safeText(leg?.routeName, leg?.trainType, mode, "公共交通");
  return {
    mode: "TRANSIT",
    icon: vehicleIcon(mode),
    instruction: "",
    durationText: durationTextFromSeconds(durationSecs),
    distanceText: "",
    transit: {
      lineName,
      lineColor: validColor(leg?.color),
      textColor: "",
      vehicleType: mode,
      headsign: safeText(leg?.headsign),
      departureStop: fromName,
      arrivalStop: toName,
      departureTime,
      arrivalTime,
      stopCount: 0,
      tripShortText: safeText(leg?.trainType),
      agency: "",
      departurePlatform: safeText(leg?.from?.platformCode),
      arrivalPlatform: safeText(leg?.to?.platformCode)
    }
  };
}
function accessWalkStep(seconds, fromLabel, toLabel, role = "walk") {
  const secs = finiteNumber(seconds);
  if (secs == null || secs <= 0) return null;
  return {
    mode: "WALKING",
    icon: "🚶",
    instruction: `步行 ${safeText(fromLabel, "出發點")} → ${safeText(toLabel, "車站")}`,
    durationText: durationTextFromSeconds(secs),
    distanceText: "",
    transit: null,
    role
  };
}
function farePlain(fare = null) {
  if (!fare || typeof fare !== "object") return null;
  const currency = safeText(fare?.currency);
  const ticket = finiteNumber(fare?.ticket), ic = finiteNumber(fare?.ic);
  if (!currency && ticket == null && ic == null) return null;
  return { currency, ticket, ic };
}
async function readJsonResponse(response) {
  const backup = response.clone();
  try { return await response.json(); }
  catch (firstError) {
    try {
      const buffer = await backup.arrayBuffer();
      const text = new TextDecoder("utf-8").decode(buffer);
      return JSON.parse(text);
    } catch (_) { throw firstError; }
  }
}

export async function normalizeLs8hGuidanceResponse(data = {}, { originRecord = null, destinationRecord = null, resolvedOrigin = null, resolvedDestination = null } = {}) {
  const serviceDate = safeText(data?.date);
  const timeZone = safeText(data?.timezone, "Asia/Tokyo") || "Asia/Tokyo";
  const commonAttribution = [];
  const osmAttribution = safeText(data?.osm?.attribution);
  if (osmAttribution) commonAttribution.push(osmAttribution);
  commonAttribution.push("Transit API (api.transit.ls8h.com)");

  const options = (Array.isArray(data?.options) ? data.options : []).map((option, index) => {
    const journey = option?.journey || {};
    const rawLegs = Array.isArray(journey?.legs) ? journey.legs : [];
    const steps = rawLegs.map(leg => journeyLegStep(leg, serviceDate, timeZone)).filter(Boolean);
    const firstTransitIndex = rawLegs.findIndex(leg => clean(leg?.kind).toLowerCase() === "transit");
    const lastTransitIndex = (() => { for (let i = rawLegs.length - 1; i >= 0; i -= 1) if (clean(rawLegs[i]?.kind).toLowerCase() === "transit") return i; return -1; })();
    const firstTransit = firstTransitIndex >= 0 ? rawLegs[firstTransitIndex] : null;
    const lastTransit = lastTransitIndex >= 0 ? rawLegs[lastTransitIndex] : null;
    const access = accessWalkStep(journey?.accessWalkSecs, endpointLabel(originRecord, safeText(data?.from?.name, "出發點")), safeText(firstTransit?.from?.name, firstTransit?.from?.id, "車站"), "access");
    const egress = accessWalkStep(journey?.egressWalkSecs, safeText(lastTransit?.to?.name, lastTransit?.to?.id, "車站"), endpointLabel(destinationRecord, safeText(data?.to?.name, "目的地")), "egress");
    if (access) steps.unshift(access);
    if (egress) steps.push(egress);
    const transitSteps = steps.filter(step => step?.transit);
    const modeChain = [];
    steps.forEach(step => {
      const token = step?.transit?.lineName ? `${step.icon} ${step.transit.lineName}` : step?.icon;
      if (token && modeChain[modeChain.length - 1] !== token) modeChain.push(token);
    });
    const segments = normalizeMapSegments(option?.map);
    const path = flattenSegmentPath(segments);
    const metrics = option?.metrics || {};
    const departureSecs = finiteNumber(journey?.departureSecs), arrivalSecs = finiteNumber(journey?.arrivalSecs);
    return {
      id: safeText(option?.id, `route-${index + 1}`),
      index,
      provider: JAPAN_TRANSIT_PROVIDER_ID,
      durationText: durationTextFromSeconds(metrics?.durationSecs ?? journey?.durationSecs),
      distanceText: "",
      departureTime: serviceSecondsIso(serviceDate, departureSecs, timeZone),
      arrivalTime: serviceSecondsIso(serviceDate, arrivalSecs, timeZone),
      rideCount: transitSteps.length,
      accessWalkSecs: finiteNumber(journey?.accessWalkSecs),
      egressWalkSecs: finiteNumber(journey?.egressWalkSecs),
      transferCount: Math.max(0, Number(metrics?.transferCount ?? journey?.transferCount ?? Math.max(0, transitSteps.length - 1))),
      modeChain,
      path,
      segments,
      steps,
      fare: farePlain(metrics?.fare || journey?.fare),
      warnings: (Array.isArray(data?.coverage?.notices) ? data.coverage.notices : []).filter(notice => clean(notice?.severity).toLowerCase() === "warning").map(notice => safeText(notice?.message)).filter(Boolean),
      attribution: commonAttribution.slice(),
      recommended: Boolean(option?.recommended),
      rank: finiteNumber(option?.rank),
      confidence: safeText(option?.confidence)
    };
  });

  return {
    provider: JAPAN_TRANSIT_PROVIDER_ID,
    basis: "scheduled",
    queryDate: serviceDate,
    timeZone,
    origin: {
      position: resolvedOrigin?.position || null,
      formattedAddress: safeText(resolvedOrigin?.formattedAddress),
      placeId: safeText(resolvedOrigin?.placeId),
      name: safeText(data?.from?.name, endpointLabel(originRecord, "出發點"))
    },
    destination: {
      position: resolvedDestination?.position || null,
      formattedAddress: safeText(resolvedDestination?.formattedAddress),
      placeId: safeText(resolvedDestination?.placeId),
      name: safeText(data?.to?.name, endpointLabel(destinationRecord, "目的地"))
    },
    options,
    attribution: commonAttribution,
    coverage: data?.coverage || null
  };
}

export async function computeJapanTransitRouteOptions({ origin = null, destination = null, departureTime = null, locationContext = null } = {}) {
  if (!origin || !destination) {
    const error = new Error("Transit origin and destination are required");
    error.code = "transit-context-missing";
    throw error;
  }
  const [resolvedOrigin, resolvedDestination] = await Promise.all([resolveTransitEndpoint(origin), resolveTransitEndpoint(destination)]);
  const from = routeEndpoint(resolvedOrigin), to = routeEndpoint(resolvedDestination);
  if (!from || !to) {
    const error = new Error("Transit origin or destination could not be located");
    error.code = "transit-location-unresolved";
    throw error;
  }
  const timeZone = safeText(locationContext?.timeZone, "Asia/Tokyo") || "Asia/Tokyo";
  const dateTime = requestDateTime(departureTime, timeZone);
  const params = new URLSearchParams({
    from,
    to,
    fromLabel: endpointLabel(origin, "出発地"),
    toLabel: endpointLabel(destination, "目的地"),
    type: "departure",
    numItineraries: "4",
    maxTransfers: "3",
    strategy: "balanced",
    live: "false",
    tracking: "none"
  });
  if (dateTime?.date) params.set("date", dateTime.date);
  if (dateTime?.time) params.set("time", dateTime.time);
  const url = `${LS8H_BASE_URL}/api/v1/guidance/plan?${params.toString()}`;
  let response;
  try { response = await fetch(url, { method: "GET", headers: { accept: "application/json" } }); }
  catch (cause) {
    const error = new Error("Japan transit provider network request failed", { cause });
    error.code = "japan-transit-network";
    throw error;
  }
  if (!response.ok) {
    let detail = "";
    try { const body = await readJsonResponse(response); detail = safeText(body?.error?.message, body?.error); } catch (_) {}
    const error = new Error(detail || `Japan transit provider returned HTTP ${response.status}`);
    error.code = response.status === 404 ? "japan-transit-no-route" : "japan-transit-http";
    error.status = response.status;
    throw error;
  }
  const data = await readJsonResponse(response);
  const normalized = await normalizeLs8hGuidanceResponse(data, { originRecord: origin, destinationRecord: destination, resolvedOrigin, resolvedDestination });
  normalized.basis = dateTime ? "scheduled" : "now-fallback";
  return normalized;
}
