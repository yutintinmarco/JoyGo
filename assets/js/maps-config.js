// Travel WebApp · Google Maps browser configuration
// Browser API keys are visible to clients by design. Use a dedicated Google Maps
// browser key restricted to the deployed HTTPS website and to Maps JavaScript API,
// Geocoding API and Routes API (Routes is used only by the lazy Transit suggestion gallery).
export const GOOGLE_MAPS_CONFIG = Object.freeze({
  apiKey: "AIzaSyCtSIr2w-LmEWJN4eFKKonoS71zMvR_z0Y",
  mapId: "DEMO_MAP_ID",
  version: "weekly",
  language: "zh-HK",
  region: "HK"
});
