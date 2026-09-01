import { computeTransitRouteOptions as computeGoogleRoutesTransit } from "../trip-map-service.js";

export const GOOGLE_TRANSIT_PROVIDER_ID = "google-routes-transit";

export async function computeGoogleTransitRouteOptions(request = {}) {
  const result = await computeGoogleRoutesTransit(request);
  const options = (Array.isArray(result?.options) ? result.options : []).map(route => ({
    ...route,
    provider: GOOGLE_TRANSIT_PROVIDER_ID,
    fare: route?.fare ?? null,
    segments: Array.isArray(route?.segments) ? route.segments : [],
    attribution: Array.isArray(route?.attribution) && route.attribution.length ? route.attribution : ["Google Maps"]
  }));
  return {
    ...result,
    provider: GOOGLE_TRANSIT_PROVIDER_ID,
    options
  };
}
