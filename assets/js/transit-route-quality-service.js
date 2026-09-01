function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function radians(value) { return Number(value) * Math.PI / 180; }
function pointDistanceMeters(a, b) {
  if (!a || !b) return null;
  const lat1 = finiteNumber(a.lat), lng1 = finiteNumber(a.lng ?? a.lon);
  const lat2 = finiteNumber(b.lat), lng2 = finiteNumber(b.lng ?? b.lon);
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const dLat = radians(lat2 - lat1), dLng = radians(lng2 - lng1);
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * s2 * s2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
function pathDistanceMeters(path = []) {
  let total = 0, usable = false;
  for (let i = 1; i < path.length; i += 1) {
    const distance = pointDistanceMeters(path[i - 1], path[i]);
    if (distance == null) continue;
    total += distance;
    usable = true;
  }
  return usable ? total : null;
}
function routeType(route = {}) {
  const rides = Math.max(0, Number(route?.rideCount || 0));
  const steps = Array.isArray(route?.steps) ? route.steps : [];
  const hasWalking = steps.some(step => String(step?.mode || "").toUpperCase() === "WALKING");
  if (!rides) return "walking";
  return hasWalking ? "mixed" : "transit";
}
function edgeWalkDistance(route = {}, edge = "egress") {
  const segments = Array.isArray(route?.segments) ? route.segments : [];
  if (!segments.length || !Number(route?.rideCount || 0)) return null;
  const ordered = edge === "access" ? segments : segments.slice().reverse();
  const target = ordered[0];
  if (!target || String(target?.kind || "").toLowerCase() !== "walk") return null;
  return pathDistanceMeters(Array.isArray(target?.path) ? target.path : []);
}
function suspiciousEdgeWalk(secondsValue, distanceValue) {
  const seconds = finiteNumber(secondsValue), distance = finiteNumber(distanceValue);
  if (seconds == null || distance == null || seconds < 12 * 60 || distance > 600) return false;
  // Intentionally conservative. A short walk can be slow because of stairs,
  // crossings or terrain; only flag a large time that is far outside a broad
  // geometry-based walking envelope. The guard never re-ranks the itinerary.
  const generousExpected = (distance / 1.2) * 4 + 180;
  return seconds > generousExpected;
}
function qualityWarning(edge) {
  return edge === "access"
    ? "起點接駁步行時間同路線距離差異較大，呢段時間只供參考。"
    : "最後接駁步行時間同路線距離差異較大，呢段時間只供參考。";
}
function patchSteps(route, { accessSuspicious = false, egressSuspicious = false } = {}) {
  if (!accessSuspicious && !egressSuspicious) return Array.isArray(route?.steps) ? route.steps : [];
  return (Array.isArray(route?.steps) ? route.steps : []).map(step => {
    const role = String(step?.role || "").toLowerCase();
    if ((role === "access" && accessSuspicious) || (role === "egress" && egressSuspicious)) {
      return { ...step, durationText: "步行時間待確認", qualityFlag: "walk-time-suspicious" };
    }
    return step;
  });
}

export function evaluateTransitRouteResult(result = {}) {
  const options = (Array.isArray(result?.options) ? result.options : []).map(route => {
    const type = routeType(route);
    const accessDistanceMeters = edgeWalkDistance(route, "access");
    const egressDistanceMeters = edgeWalkDistance(route, "egress");
    const accessSuspicious = suspiciousEdgeWalk(route?.accessWalkSecs, accessDistanceMeters);
    const egressSuspicious = suspiciousEdgeWalk(route?.egressWalkSecs, egressDistanceMeters);
    const warnings = Array.isArray(route?.warnings) ? route.warnings.slice() : [];
    if (accessSuspicious) warnings.push(qualityWarning("access"));
    if (egressSuspicious) warnings.push(qualityWarning("egress"));
    return {
      ...route,
      routeType: type,
      steps: patchSteps(route, { accessSuspicious, egressSuspicious }),
      warnings: [...new Set(warnings.filter(Boolean))],
      quality: {
        status: accessSuspicious || egressSuspicious ? "review" : "ok",
        accessWalk: {
          seconds: finiteNumber(route?.accessWalkSecs),
          geometryMeters: accessDistanceMeters,
          suspicious: accessSuspicious
        },
        egressWalk: {
          seconds: finiteNumber(route?.egressWalkSecs),
          geometryMeters: egressDistanceMeters,
          suspicious: egressSuspicious
        }
      }
    };
  });
  return { ...result, options };
}
