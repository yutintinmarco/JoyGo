export const TRIP_SCHEMA_VERSION = 2;
export const TRIP_STATUS = Object.freeze({
  DRAFT: "draft",
  UPCOMING: "upcoming",
  ACTIVE: "active",
  COMPLETED: "completed"
});

// v7.9.7.0 · Itinerary semantic foundation. A stop is a place/activity node;
// transit is movement between stop nodes. New Edit Mode writes this field
// explicitly. Legacy trips remain compatible through conservative inference.
export const ITINERARY_ITEM_KIND = Object.freeze({
  STOP: "stop",
  TRANSIT: "transit"
});

const LEGACY_TRANSIT_ICONS = new Set([
  "✈", "✈️", "🛫", "🛬", "🚆", "🚄", "🚅", "🚈", "🚇", "🚊", "🚉", "🚋",
  "🚌", "🚍", "🚎", "🚐", "🚕", "🚖", "🚗", "🚙", "🚶", "🚶‍♂️", "🚶‍♀️",
  "🚲", "🛵", "🏍", "🏍️", "⛴", "⛴️", "🚢", "🛥", "🛥️", "🚤"
]);

export function normalizeItineraryItemKind(item = {}) {
  const explicit = clean(item?.kind || item?.itemKind || item?.semanticKind || item?.type).toLowerCase();
  if (["transit", "transport", "transportation", "travel", "transfer", "flight"].includes(explicit)) return ITINERARY_ITEM_KIND.TRANSIT;
  if (["stop", "activity", "itinerary", "place", "visit"].includes(explicit)) return ITINERARY_ITEM_KIND.STOP;

  const mode = clean(item?.transportMode || item?.travelMode || item?.mode).toLowerCase();
  if (["transit", "walking", "walk", "driving", "drive", "bicycling", "bicycle", "flight", "train", "rail", "bus", "taxi", "ferry"].includes(mode)) return ITINERARY_ITEM_KIND.TRANSIT;
  if (item?.transport && typeof item.transport === "object") return ITINERARY_ITEM_KIND.TRANSIT;
  if (item?.transit && typeof item.transit === "object") return ITINERARY_ITEM_KIND.TRANSIT;

  // Compatibility only: old portable JSON did not carry a semantic kind. The
  // icon is therefore a strong legacy hint, never the long-term source of truth.
  const icon = clean(item?.icon).replace(/\uFE0F/g, "");
  if (LEGACY_TRANSIT_ICONS.has(clean(item?.icon)) || LEGACY_TRANSIT_ICONS.has(icon)) return ITINERARY_ITEM_KIND.TRANSIT;

  const title = clean(item?.title);
  const note = clean(item?.note);
  const text = `${title} ${note}`.trim();
  if (/^(travel|transfer|transit|transport|walking|walk|driving|drive|taxi|bus|train|flight)\b/i.test(text)) return ITINERARY_ITEM_KIND.TRANSIT;
  if (/^(前往|乘搭|乘坐|搭乘|轉乘|轉車|步行往|步行前往)/.test(text)) return ITINERARY_ITEM_KIND.TRANSIT;

  return ITINERARY_ITEM_KIND.STOP;
}

function clean(value) { return String(value ?? "").trim(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function safeArray(value) { return Array.isArray(value) ? value : []; }
function orderedUniqueStrings(value) {
  const out = [];
  safeArray(value).forEach(item => {
    const next = clean(item);
    if (next && !out.includes(next)) out.push(next);
  });
  return out;
}

export function normalizeTravellers(rawTravellers = {}) {
  const source = rawTravellers && typeof rawTravellers === "object" && !Array.isArray(rawTravellers) ? rawTravellers : {};
  const out = {};
  Object.entries(source).forEach(([key, value]) => {
    const traveller = value && typeof value === "object" && !Array.isArray(value) ? clone(value) : { label: clean(value) };
    // Team display order is a presentation rule derived from label, not stored
    // metadata. Remove the short-lived v7.7.1.0 sortOrder field so JSON ↔
    // Firebase round trips cannot create a second ordering source of truth.
    delete traveller.sortOrder;
    out[key] = traveller;
  });
  return out;
}

function fnv1a(input) {
  let hash = 0x811c9dc5;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}


function inferTripStatus(startDate, endDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = startDate ? new Date(`${startDate}T00:00:00`) : null;
  const end = endDate ? new Date(`${endDate}T23:59:59`) : null;
  if (start && Number.isFinite(start.getTime()) && today < start) return TRIP_STATUS.UPCOMING;
  if (end && Number.isFinite(end.getTime()) && today > end) return TRIP_STATUS.COMPLETED;
  if (start && end && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())) return TRIP_STATUS.ACTIVE;
  return TRIP_STATUS.DRAFT;
}
function stripHtml(value) {
  return clean(value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLocation(record = {}) {
  const source = record?.location && typeof record.location === "object" ? record.location : {};
  const latitude = finiteNumber(source.latitude ?? source.lat ?? record.latitude ?? record.lat);
  const longitude = finiteNumber(source.longitude ?? source.lng ?? source.lon ?? record.longitude ?? record.lng ?? record.lon);
  const mapsUrl = clean(source.mapsUrl || source.googleMapsUrl || record.maps || record.mapsUrl || record.googleMapsUrl);
  const placeId = clean(source.placeId || source.googlePlaceId || record.googlePlaceId || record.googleMapsPlaceId);
  const address = clean(source.address || record.address);
  const name = clean(source.name || record.placeName || stripHtml(record.title || record.name || ""));
  return {
    name,
    placeId,
    latitude,
    longitude,
    address,
    mapsUrl
  };
}

function deriveTripId(raw) {
  const meta = raw?.meta || {};
  const explicit = clean(raw?.tripId || meta.tripId || meta?.expenses?.tripId);
  if (explicit) return explicit;
  const datePart = clean(meta.tripStartIso).replace(/-/g, "");
  const titlePart = slugify(stripHtml(meta.titleMain || meta.titleSmall || "trip")) || "trip";
  return `${titlePart}${datePart ? `-${datePart}` : ""}`.slice(0, 64);
}

function deriveDayId(day, index) {
  const explicit = clean(day?.dayId || day?.id);
  if (explicit) return explicit;
  const iso = clean(day?.isoDate).replace(/-/g, "");
  return iso ? `day_${iso}` : `day_${String(index + 1).padStart(2, "0")}_${fnv1a(day?.label || index)}`;
}

function deriveItemId(item, dayId, index) {
  const explicit = clean(item?.itemId || item?.id);
  if (explicit) return explicit;
  return `itm_${fnv1a([dayId, item?.time, item?.title, index].join("|"))}`;
}

function normalizeImages(item) {
  const existing = safeArray(item?.images);
  if (existing.length) {
    return existing.map((image, index) => {
      if (typeof image === "string") {
        return {
          imageId: `img_${fnv1a(image)}`,
          source: image.startsWith("assets/") ? "static" : "remote",
          src: image,
          sortOrder: index
        };
      }
      const src = clean(image?.src || image?.url || image?.path);
      const storagePath = clean(image?.storagePath);
      const thumbnailStoragePath = clean(image?.thumbnailStoragePath);
      const normalized = {
        imageId: clean(image?.imageId || image?.mediaId || image?.id) || `img_${fnv1a(storagePath || src || index)}`,
        source: clean(image?.source) || (storagePath ? "storage" : (src.startsWith("assets/") ? "static" : "remote")),
        src,
        storagePath,
        caption: clean(image?.caption),
        sortOrder: Number.isFinite(Number(image?.sortOrder)) ? Number(image.sortOrder) : index
      };
      const mediaId = clean(image?.mediaId);
      const mediaSchemaVersion = Number(image?.mediaSchemaVersion);
      const contentType = clean(image?.contentType);
      const generation = clean(image?.generation);
      const thumbnailContentType = clean(image?.thumbnailContentType);
      const thumbnailGeneration = clean(image?.thumbnailGeneration);
      const ownerType = clean(image?.ownerType);
      const ownerId = clean(image?.ownerId);
      const slot = clean(image?.slot);
      if (mediaId) normalized.mediaId = mediaId;
      if (ownerType) normalized.ownerType = ownerType;
      if (ownerId) normalized.ownerId = ownerId;
      if (slot) normalized.slot = slot;
      if (thumbnailStoragePath) normalized.thumbnailStoragePath = thumbnailStoragePath;
      if (Number.isFinite(mediaSchemaVersion)) normalized.mediaSchemaVersion = mediaSchemaVersion;
      if (contentType) normalized.contentType = contentType;
      if (Number.isFinite(Number(image?.byteSize))) normalized.byteSize = Number(image.byteSize);
      if (Number.isFinite(Number(image?.width))) normalized.width = Number(image.width);
      if (Number.isFinite(Number(image?.height))) normalized.height = Number(image.height);
      if (generation) normalized.generation = generation;
      if (thumbnailContentType) normalized.thumbnailContentType = thumbnailContentType;
      if (Number.isFinite(Number(image?.thumbnailByteSize))) normalized.thumbnailByteSize = Number(image.thumbnailByteSize);
      if (Number.isFinite(Number(image?.thumbnailWidth))) normalized.thumbnailWidth = Number(image.thumbnailWidth);
      if (Number.isFinite(Number(image?.thumbnailHeight))) normalized.thumbnailHeight = Number(image.thumbnailHeight);
      if (thumbnailGeneration) normalized.thumbnailGeneration = thumbnailGeneration;
      // v7.9.4.4 · Crop positioning is canonical itinerary media metadata.
      // Preserve it through every schema-normalization path so the Local First
      // pending descriptor and the Firestore-ready descriptor render identically.
      if (image?.crop && typeof image.crop === "object") {
        const focusX = Number(image.crop.focusX);
        const focusY = Number(image.crop.focusY);
        const zoom = Number(image.crop.zoom);
        const aspect = Number(image.crop.aspect);
        normalized.crop = {
          focusX: Number.isFinite(focusX) ? Math.max(0, Math.min(1, focusX)) : 0.5,
          focusY: Number.isFinite(focusY) ? Math.max(0, Math.min(1, focusY)) : 0.5,
          zoom: Number.isFinite(zoom) ? Math.max(1, Math.min(4, zoom)) : 1,
          aspect: Number.isFinite(aspect) ? Math.max(0.5, Math.min(3, aspect)) : (16 / 9)
        };
      }
      return normalized;
    }).filter(image => image.src || image.storagePath);
  }

  return safeArray(item?.gallery).map((src, index) => ({
    imageId: `img_${fnv1a(src)}`,
    source: String(src || "").startsWith("assets/") ? "static" : "remote",
    src: String(src || ""),
    sortOrder: index
  }));
}

function normalizeMediaDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized = normalizeImages({ images: [value] });
  return normalized[0] || null;
}

function normalizeSavedPlace(place, index) {
  const title = clean(place?.title || place?.name || `Saved place ${index + 1}`);
  const placeId = clean(place?.placeId || place?.id) || `place_${fnv1a([title, place?.maps, index].join("|"))}`;
  return {
    ...clone(place),
    placeId,
    location: normalizeLocation(place),
    sortOrder: Number.isFinite(Number(place?.sortOrder)) ? Number(place.sortOrder) : index,
    images: normalizeImages(place)
  };
}

export function normalizePortableTrip(rawInput = {}) {
  const raw = clone(rawInput) || {};
  const meta = raw.meta || {};
  const tripId = deriveTripId(raw);
  const days = safeArray(raw.days).map((day, dayIndex) => {
    const dayId = deriveDayId(day, dayIndex);
    const items = safeArray(day?.items).map((item, itemIndex) => ({
      ...clone(item),
      itemId: deriveItemId(item, dayId, itemIndex),
      kind: normalizeItineraryItemKind(item),
      location: normalizeLocation(item),
      sortOrder: Number.isFinite(Number(item?.sortOrder)) ? Number(item.sortOrder) : itemIndex,
      images: normalizeImages(item)
    }));
    const orderedCities = orderedUniqueStrings(day?.cities);
    const normalizedDay = {
      ...clone(day),
      dayId,
      sortOrder: Number.isFinite(Number(day?.sortOrder)) ? Number(day.sortOrder) : dayIndex,
      items
    };
    if (orderedCities.length) normalizedDay.cities = orderedCities;
    else if (Array.isArray(normalizedDay.cities)) normalizedDay.cities = [];
    return normalizedDay;
  });

  const rawSnacks = raw.snacks;
  const normalizedSnackItems = (Array.isArray(rawSnacks) ? rawSnacks : safeArray(rawSnacks?.items)).map(normalizeSavedPlace);
  const snacks = Array.isArray(rawSnacks)
    ? normalizedSnackItems
    : {
        ...(clone(rawSnacks) || {}),
        items: normalizedSnackItems
      };

  return {
    ...raw,
    schemaVersion: Math.max(TRIP_SCHEMA_VERSION, Number(raw.schemaVersion) || 0),
    tripId,
    revision: Math.max(1, Number(raw.revision) || 1),
    meta: {
      ...clone(meta),
      tripId,
      travellers: normalizeTravellers(meta.travellers || {}),
      tripIcon: clean(meta.tripIcon || meta.icon || raw.tripIcon || raw.icon),
      backgroundImage: clean(meta.backgroundImage || meta.bgImage || meta.background || meta.coverImage || raw.backgroundImage || raw.bgImage || raw.background),
      tripIconMedia: normalizeMediaDescriptor(meta.tripIconMedia || raw.tripIconMedia),
      backgroundImageMedia: normalizeMediaDescriptor(meta.backgroundImageMedia || raw.backgroundImageMedia),
      coverImageMedia: normalizeMediaDescriptor(meta.coverImageMedia || raw.coverImageMedia),
      featureColors: clone(meta.featureColors || {})
    },
    days,
    snacks
  };
}

export function validatePortableTrip(rawInput = {}) {
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) && String(rawInput.backupFormat || "").trim() === "travel-full-backup") {
    return {
      valid: false,
      errors: ["Full Backup JSON cannot be imported as Portable trip.json. Use Full Backup Restore instead."],
      warnings: [],
      trip: normalizePortableTrip({})
    };
  }
  const trip = normalizePortableTrip(rawInput);
  const errors = [];
  const warnings = [];
  if (!trip.tripId) errors.push("Missing tripId");
  if (!trip.meta?.titleMain && !trip.meta?.titleSmall) warnings.push("Trip title is empty");
  if (!trip.meta?.tripStartIso) warnings.push("Trip start date is empty");
  if (!trip.meta?.tripEndIso) warnings.push("Trip end date is empty");
  if (!trip.days.length) warnings.push("Trip has no days");

  const seenDays = new Set();
  const seenItems = new Set();
  const knownCities = new Set(Object.keys(trip.meta?.cities || {}));
  trip.days.forEach(day => {
    if (seenDays.has(day.dayId)) errors.push(`Duplicate dayId: ${day.dayId}`);
    seenDays.add(day.dayId);
    orderedUniqueStrings(day.cities).forEach(cityKey => {
      if (knownCities.size && !knownCities.has(cityKey)) warnings.push(`Unknown destination key on ${day.dayId}: ${cityKey}`);
    });
    day.items.forEach(item => {
      if (seenItems.has(item.itemId)) errors.push(`Duplicate itemId: ${item.itemId}`);
      seenItems.add(item.itemId);
    });
  });
  const inlineImageCount = trip.days.reduce((sum, day) => sum + day.items.reduce((itemSum, item) => itemSum + safeArray(item.images).filter(image => clean(image?.src).startsWith("data:")).length, 0), 0);
  if (inlineImageCount) warnings.push(`${inlineImageCount} inline/base64 images detected; Phase 3 Storage should be used instead`);

  const seenPlaces = new Set();
  const savedPlaces = Array.isArray(trip.snacks) ? trip.snacks : safeArray(trip.snacks?.items);
  savedPlaces.forEach(place => {
    if (seenPlaces.has(place.placeId)) errors.push(`Duplicate placeId: ${place.placeId}`);
    seenPlaces.add(place.placeId);
  });

  return { valid: errors.length === 0, errors, warnings, trip };
}

export function buildFirestoreTripPlan(rawInput = {}, ownerUser = null) {
  const { valid, errors, warnings, trip } = validatePortableTrip(rawInput);
  if (!valid) return { valid, errors, warnings, trip, plan: null };

  const meta = trip.meta || {};
  const title = stripHtml(meta.titleMain || meta.titleSmall || trip.tripId);
  const requestedStatus = clean(meta.status);
  const nowStatus = Object.values(TRIP_STATUS).includes(requestedStatus)
    ? requestedStatus
    : inferTripStatus(clean(meta.tripStartIso), clean(meta.tripEndIso));
  const ownerUid = clean(ownerUser?.uid);
  const memberUids = ownerUid ? [ownerUid] : [];

  const tripDoc = {
    schemaVersion: TRIP_SCHEMA_VERSION,
    revision: trip.revision,
    title,
    titleSmall: clean(meta.titleSmall),
    titleHtml: clean(meta.titleMain),
    dateRange: clean(meta.dateRange),
    route: clean(meta.route),
    accentColor: clean(meta.accentColor),
    startDate: clean(meta.tripStartIso),
    endDate: clean(meta.tripEndIso),
    status: nowStatus,
    archived: false,
    archivedAt: null,
    archivedBy: "",
    coverImage: clean(meta.coverImage),
    tripIcon: clean(meta.tripIcon),
    backgroundImage: clean(meta.backgroundImage),
    ...(meta.coverImageMedia ? { coverImageMedia: clone(meta.coverImageMedia) } : {}),
    ...(meta.tripIconMedia ? { tripIconMedia: clone(meta.tripIconMedia) } : {}),
    ...(meta.backgroundImageMedia ? { backgroundImageMedia: clone(meta.backgroundImageMedia) } : {}),
    memberUids,
    memberCount: memberUids.length,
    createdBy: ownerUid,
    source: "portable-json"
  };

  const memberDoc = ownerUid ? {
    uid: ownerUid,
    role: "owner",
    status: "active",
    displayName: clean(ownerUser?.displayName),
    email: clean(ownerUser?.email).toLowerCase(),
    photoURL: clean(ownerUser?.photoURL)
  } : null;

  const days = trip.days.map(day => ({
    id: day.dayId,
    data: {
      dayId: day.dayId,
      label: clean(day.label),
      date: clean(day.date),
      isoDate: clean(day.isoDate),
      title: clean(day.title),
      subtitle: clean(day.subtitle),
      city: clean(day.city),
      ...(orderedUniqueStrings(day.cities).length ? { cities: orderedUniqueStrings(day.cities) } : {}),
      sortOrder: Number(day.sortOrder) || 0
    },
    items: day.items.map(item => ({
      id: item.itemId,
      data: {
        ...clone(item),
        itemId: item.itemId,
        sortOrder: Number(item.sortOrder) || 0
      }
    }))
  }));

  const savedPlaceItems = Array.isArray(trip.snacks) ? trip.snacks : safeArray(trip.snacks?.items);
  const savedPlaces = savedPlaceItems.map(place => ({
    id: place.placeId,
    data: { ...clone(place), placeId: place.placeId }
  }));

  const settings = {
    general: {
      travellers: clone(meta.travellers || {}),
      cities: clone(meta.cities || {}),
      flights: clone(meta.flights || []),
      outbound: clone(meta.outbound || null),
      inbound: clone(meta.inbound || null),
      airlineLogo: clean(meta.airlineLogo),
      weather: clone(meta.weather || {}),
      tripIcon: clean(meta.tripIcon),
      backgroundImage: clean(meta.backgroundImage),
      ...(meta.tripIconMedia ? { tripIconMedia: clone(meta.tripIconMedia) } : {}),
      ...(meta.backgroundImageMedia ? { backgroundImageMedia: clone(meta.backgroundImageMedia) } : {}),
      ...(meta.coverImageMedia ? { coverImageMedia: clone(meta.coverImageMedia) } : {}),
      hotels: clone(meta.hotels || {}),
      accommodations: clone(meta.accommodations || []),
      bookingDocuments: clone(meta.bookingDocuments || []),
      infoCard: clone(meta.infoCard || {}),
      galleryDefaults: clone(meta.galleryDefaults || {}),
      savedPlacesMeta: Array.isArray(trip.snacks) ? {} : {
        title: clean(trip.snacks?.title),
        subtitle: clean(trip.snacks?.subtitle),
        areaFilters: safeArray(trip.snacks?.areaFilters).map(clean).filter(Boolean),
        ...(Array.isArray(trip.snacks?.mealTypeOptions) ? { mealTypeOptions: clone(trip.snacks.mealTypeOptions) } : {}),
        ...(Array.isArray(trip.snacks?.categoryOptions) ? { categoryOptions: clone(trip.snacks.categoryOptions) } : {}),
        ...(Array.isArray(trip.snacks?.priorityOptions) ? { priorityOptions: clone(trip.snacks.priorityOptions) } : {})
      },
      featureColors: clone(meta.featureColors || {}),
      footerNote: clean(meta.footerNote)
    },
    expenses: clone(meta.expenses || {})
  };

  return {
    valid,
    errors,
    warnings,
    trip,
    plan: {
      tripId: trip.tripId,
      tripDoc,
      memberDoc,
      days,
      savedPlaces,
      settings
    }
  };
}

export function buildTripArchivePatch({ archived = true, user = null, timestamp = null } = {}) {
  const shouldArchive = archived === true;
  return {
    archived: shouldArchive,
    // Phase 2C writer supplies Firestore serverTimestamp() here. Keeping the
    // schema helper Firebase-agnostic avoids mixing browser SDK concerns into
    // portable trip validation.
    archivedAt: shouldArchive ? timestamp : null,
    archivedBy: shouldArchive ? clean(user?.uid) : ""
  };
}

export function getTripSummary(rawInput = {}) {
  const trip = normalizePortableTrip(rawInput);
  const meta = trip.meta || {};
  return {
    tripId: trip.tripId,
    schemaVersion: trip.schemaVersion,
    revision: trip.revision,
    title: stripHtml(meta.titleMain || meta.titleSmall || trip.tripId),
    titleSmall: clean(meta.titleSmall),
    startDate: clean(meta.tripStartIso),
    endDate: clean(meta.tripEndIso),
    dateRange: clean(meta.dateRange),
    tripIcon: clean(meta.tripIcon),
    backgroundImage: clean(meta.backgroundImage),
    coverImage: clean(meta.coverImage),
    tripIconMedia: clone(meta.tripIconMedia || null),
    backgroundImageMedia: clone(meta.backgroundImageMedia || null),
    coverImageMedia: clone(meta.coverImageMedia || null),
    dayCount: trip.days.length,
    itemCount: trip.days.reduce((sum, day) => sum + safeArray(day.items).length, 0),
    savedPlaceCount: Array.isArray(trip.snacks) ? trip.snacks.length : safeArray(trip.snacks?.items).length,
    mapReferenceCount: trip.days.reduce((sum, day) => sum + day.items.filter(item => clean(item?.location?.mapsUrl) || clean(item?.location?.placeId) || (item?.location?.latitude != null && item?.location?.longitude != null)).length, 0),
    placeIdCount: trip.days.reduce((sum, day) => sum + day.items.filter(item => clean(item?.location?.placeId)).length, 0),
    coordinateCount: trip.days.reduce((sum, day) => sum + day.items.filter(item => item?.location?.latitude != null && item?.location?.longitude != null).length, 0)
  };
}
