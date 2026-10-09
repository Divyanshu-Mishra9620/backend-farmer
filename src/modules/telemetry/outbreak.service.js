import Device from "./device.model.js";
import OutbreakAlert from "./outbreak.model.js";
import User from "../user/user.model.js";
import { UserPreferences } from "../chat/chat.models.js";
import { emitToUser } from "../chat/socket.js";
import { sendPushToUser } from "../../shared/utils/pushSender.js";
import config from "../../config/env.js";
import httpError from "../../shared/utils/httpError.js";
import { createLogger } from "../../shared/utils/logger.js";

const logger = createLogger("Outbreak");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const EARTH_RADIUS_KM = 6371;
const KM_PER_DEG_LAT = 111.32;
// Upper bounds on one fan-out, so a single detection in a dense district can
// never turn into an unbounded query or push storm.
const MAX_CANDIDATE_DEVICES = 5000;
const MAX_DISTRICT_USERS = 2000;
const MAX_RECIPIENTS = 500;
// The dashboard lists alerts from this far back; older ones expire anyway.
const LIST_WINDOW_DAYS = 14;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const norm = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const round1 = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 10) / 10
    : null;

// {lat, lon} from a device / analysis style location, or null when it has no
// usable GPS. (0, 0) is treated as missing: it is what a blank form or a
// failed fix produces, and no farm is at that point in the Atlantic.
export const coordsOf = (location) => {
  const lat = Number(location?.latitude);
  const lon = Number(location?.longitude);
  if (location?.latitude == null || location?.longitude == null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
};

// Great-circle distance in km (haversine).
export const distanceKm = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};

// Is `candidate` near `source`? GPS on both sides decides by distance and
// nothing else: two farms 30 km apart are not neighbours just because they
// share a district. Without GPS on one side it falls back to the same district
// (and the same state, when both name one).
//
// `sameOwner` is for the farmer's own plots: when nothing at all is known
// about where either device is, they are assumed to be on the same farm.
export const proximity = (source, candidate, radiusKm, { sameOwner = false } = {}) => {
  const a = coordsOf(source);
  const b = coordsOf(candidate);

  if (a && b) {
    const km = distanceKm(a, b);
    return km <= radiusKm ? { matchedBy: "distance", distanceKm: km } : null;
  }

  const districtA = norm(source?.district);
  const districtB = norm(candidate?.district);

  if (districtA && districtB) {
    if (districtA !== districtB) return null;
    const stateA = norm(source?.state);
    const stateB = norm(candidate?.state);
    if (stateA && stateB && stateA !== stateB) return null;
    return { matchedBy: "district", distanceKm: null };
  }

  return sameOwner ? { matchedBy: "same_farm", distanceKm: null } : null;
};

// Only a confident, knowledge-base-grounded disease warns anyone. Healthy
// leaves, unmatched predictions and low-confidence guesses stay on the
// capturing farmer's own dashboard: a false alarm sent to the neighbours costs
// them a trip to the field and costs the feature its credibility.
export const isOutbreakWorthy = (
  analysis,
  minConfidence = config.outbreakMinConfidence
) => {
  if (!analysis || analysis.status !== "completed") return false;
  const detection = analysis.detection;
  if (!detection || detection.status !== "grounded") return false;
  const disease = typeof detection.disease === "string" ? detection.disease.trim() : "";
  if (!disease || /healthy/i.test(disease)) return false;
  if (analysis.action?.category === "healthy") return false;
  return (
    typeof detection.confidence === "number" &&
    Number.isFinite(detection.confidence) &&
    detection.confidence >= minConfidence
  );
};

export const plotNameOf = (device) =>
  typeof device?.plot === "string" && device.plot.trim() ? device.plot.trim() : null;

// Whole km, never below 1, so a neighbour's distance cannot be read to the
// metre and used to find the farm that reported the disease.
export const roundedKm = (km) =>
  typeof km === "number" && Number.isFinite(km) ? Math.max(1, Math.round(km)) : null;

const prettify = (key) =>
  String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const diseaseNameOf = (alert) => alert.diseaseTitle || prettify(alert.disease);

// The location used for the source of an outbreak: the camera's own, then the
// gateway it reports through, then the owner's profile district.
export const sourceLocationOf = (sourceDevice, gateway, ownerProfile) => {
  const own = sourceDevice?.location || {};
  const via = gateway?.location || {};
  const coords = coordsOf(own) || coordsOf(via);
  return {
    latitude: coords?.lat,
    longitude: coords?.lon,
    district: own.district || via.district || ownerProfile?.district || undefined,
    state: own.state || via.state || ownerProfile?.state || undefined,
  };
};

// A device's location, with its owner's profile district standing in when the
// device was registered without one.
export const effectiveLocationOf = (device, profile) => {
  const location = device?.location || {};
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    district: location.district || profile?.district || undefined,
    state: location.state || profile?.state || undefined,
  };
};

const MATCH_RANK = { distance: 3, district: 2, same_farm: 1 };

const better = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  if (MATCH_RANK[b.matchedBy] !== MATCH_RANK[a.matchedBy]) {
    return MATCH_RANK[b.matchedBy] > MATCH_RANK[a.matchedBy] ? b : a;
  }
  if (a.distanceKm == null) return b;
  if (b.distanceKm == null) return a;
  return b.distanceKm < a.distanceKm ? b : a;
};

// What a recipient sees. A nearby_farm alert carries no id, label, image or
// capture of the farm that reported it.
export const serializeOutbreak = (alert) => {
  const own = alert.scope === "own_plot";
  const out = {
    id: alert._id,
    scope: alert.scope,
    disease: alert.disease,
    diseaseTitle: alert.diseaseTitle || null,
    crop: alert.crop || null,
    confidence:
      typeof alert.confidence === "number" ? Math.round(alert.confidence) : null,
    affectedPlots: Array.isArray(alert.affectedPlots) ? [...alert.affectedPlots] : [],
    matchedBy: alert.matchedBy,
    distanceKm: roundedKm(alert.distanceKm),
    district: alert.district || null,
    createdAt: alert.createdAt,
  };
  if (own) {
    out.deviceId = alert.sourceDevice ?? null;
    out.captureId = alert.sourceCapture ?? null;
    out.nodeLabel = alert.sourceNodeLabel || null;
    out.plot = alert.sourcePlot || null;
  }
  return out;
};

export const pushTextFor = (alert) => {
  const name = diseaseNameOf(alert);

  if (alert.scope === "own_plot") {
    const where = alert.sourcePlot
      ? `plot ${alert.sourcePlot}`
      : alert.sourceNodeLabel || "one of your cameras";
    const plots = (alert.affectedPlots || []).join(", ");
    return {
      title: "Disease found on your farm",
      body: `${name} was detected on ${where}. Check your nearby plots too: ${plots}.`,
    };
  }

  const km = roundedKm(alert.distanceKm);
  const where = km ? `about ${km} km from your farm` : "in your district";
  const crop = alert.crop ? `your ${alert.crop}` : "your crops";
  return {
    title: "Disease reported near your farm",
    body: `${name} was found on a farm ${where}. Check ${crop} for early signs over the next few days.`,
  };
};

// ---------------------------------------------------------------------------
// Database work
// ---------------------------------------------------------------------------

const DEVICE_FIELDS = "owner name nodeLabel type plot crop location";

// The farmer's other plots near the infected one. Devices are grouped by their
// plot name; a device with no plot name cannot be told apart from the camera's
// own plot, so it is not listed.
async function ownPlotsNear(sourceDevice, source, ownerProfile, radiusKm) {
  const devices = await Device.find({
    owner: sourceDevice.owner,
    isActive: true,
    _id: { $ne: sourceDevice._id },
  }).select(DEVICE_FIELDS);

  const sourcePlot = norm(sourceDevice.plot);
  const plots = new Map();

  for (const device of devices) {
    const name = plotNameOf(device);
    if (!name) continue;
    const key = norm(name);
    if (sourcePlot && key === sourcePlot) continue;

    const match = proximity(source, effectiveLocationOf(device, ownerProfile), radiusKm, {
      sameOwner: true,
    });
    if (!match) continue;

    const current = plots.get(key);
    plots.set(key, { name: current?.name || name, ...better(current, match) });
  }

  return [...plots.values()];
}

// Devices of OTHER farmers that might be near the source: inside a bounding
// box around its GPS, or in its district (on the device, or on the owner's
// profile for devices registered without a location). The exact test is
// proximity() afterwards; this only keeps the query small.
async function candidateDevices(source, sourceOwnerId, radiusKm) {
  const or = [];

  const centre = coordsOf(source);
  if (centre) {
    const dLat = radiusKm / KM_PER_DEG_LAT;
    const cosLat = Math.max(Math.cos((centre.lat * Math.PI) / 180), 0.01);
    const dLon = radiusKm / (KM_PER_DEG_LAT * cosLat);
    or.push({
      "location.latitude": { $gte: centre.lat - dLat, $lte: centre.lat + dLat },
      "location.longitude": { $gte: centre.lon - dLon, $lte: centre.lon + dLon },
    });
  }

  if (norm(source.district)) {
    const sameDistrict = new RegExp(`^${escapeRegex(source.district.trim())}$`, "i");
    or.push({ "location.district": sameDistrict });

    const districtUsers = await User.find({
      _id: { $ne: sourceOwnerId },
      district: sameDistrict,
    })
      .select("_id")
      .limit(MAX_DISTRICT_USERS);
    if (districtUsers.length) {
      or.push({ owner: { $in: districtUsers.map((user) => user._id) } });
    }
  }

  if (or.length === 0) return [];

  return Device.find({
    isActive: true,
    owner: { $ne: sourceOwnerId },
    $or: or,
  })
    .select(DEVICE_FIELDS)
    .limit(MAX_CANDIDATE_DEVICES);
}

async function nearbyFarms(source, sourceOwnerId, radiusKm) {
  const devices = await candidateDevices(source, sourceOwnerId, radiusKm);
  if (devices.length === 0) return [];

  const ownerIds = [...new Set(devices.map((device) => String(device.owner)))];
  const profiles = await User.find({ _id: { $in: ownerIds } }).select("district state");
  const profileById = new Map(profiles.map((user) => [String(user._id), user]));

  const farms = new Map();
  for (const device of devices) {
    const ownerId = String(device.owner);
    const match = proximity(
      source,
      effectiveLocationOf(device, profileById.get(ownerId)),
      radiusKm
    );
    if (!match) continue;

    const farm = farms.get(ownerId) || { owner: device.owner, plots: new Set(), match: null };
    farm.match = better(farm.match, match);
    const label = plotNameOf(device) || (device.type !== "gateway" ? device.name : null);
    if (label) farm.plots.add(label);
    farms.set(ownerId, farm);
  }

  return [...farms.values()]
    .map((farm) => ({
      owner: farm.owner,
      plots: [...farm.plots],
      matchedBy: farm.match.matchedBy,
      distanceKm: farm.match.distanceKm,
    }))
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))
    .slice(0, MAX_RECIPIENTS);
}

async function pushAll(alerts) {
  const ids = [...new Set(alerts.map((alert) => String(alert.recipient)))];
  const [users, optedOut] = await Promise.all([
    User.find({ _id: { $in: ids }, pushToken: { $ne: null } }).select("pushToken"),
    UserPreferences.find({
      userId: { $in: ids },
      "notificationPreferences.pest_alerts": false,
    }).select("userId"),
  ]);

  const tokenById = new Map(users.map((user) => [String(user._id), user.pushToken]));
  const muted = new Set(optedOut.map((prefs) => String(prefs.userId)));

  await Promise.all(
    alerts.map(async (alert) => {
      const id = String(alert.recipient);
      const token = tokenById.get(id);
      if (!token || muted.has(id)) return;
      try {
        await sendPushToUser(token, {
          ...pushTextFor(alert),
          data: {
            url: "krishiapp://field-devices",
            kind: "outbreak_alert",
            alertId: String(alert._id),
          },
        });
      } catch (err) {
        logger.error(`Outbreak push failed for user ${id}`, err.message);
      }
    })
  );
}

// Called once a field camera's photo has been diagnosed. Never throws: an
// alerting failure must not turn a successful diagnosis into a failed one.
export async function raiseOutbreakAlerts({ capture, analysis, sourceDevice, gateway }) {
  try {
    if (!sourceDevice?.owner || !isOutbreakWorthy(analysis)) {
      return { created: 0 };
    }

    const radiusKm = config.outbreakRadiusKm;
    const ownerId = sourceDevice.owner;
    const ownerProfile = await User.findById(ownerId).select("district state");
    const source = sourceLocationOf(sourceDevice, gateway, ownerProfile);

    const detection = analysis.detection;
    const disease = detection.disease.trim();
    const diseaseKey = disease.toLowerCase();

    const base = {
      sourceOwner: ownerId,
      sourceDevice: sourceDevice._id,
      sourceCapture: capture?._id ?? null,
      analysis: analysis._id ?? null,
      sourceNodeLabel: capture?.nodeLabel || sourceDevice.nodeLabel,
      sourcePlot: plotNameOf(sourceDevice) || undefined,
      disease,
      diseaseTitle: detection.diseaseTitle || undefined,
      crop: analysis.crop || sourceDevice.crop || gateway?.crop || undefined,
      confidence: round1(detection.confidence),
    };

    const drafts = [];

    const ownPlots = await ownPlotsNear(sourceDevice, source, ownerProfile, radiusKm);
    if (ownPlots.length) {
      const best = ownPlots.reduce((acc, plot) => better(acc, plot), null);
      drafts.push({
        ...base,
        recipient: ownerId,
        scope: "own_plot",
        dedupeKey: `own:${sourceDevice._id}:${diseaseKey}`,
        affectedPlots: ownPlots.map((plot) => plot.name),
        matchedBy: best.matchedBy,
        distanceKm: best.distanceKm,
        district: source.district,
      });
    }

    const farms = await nearbyFarms(source, ownerId, radiusKm);
    for (const farm of farms) {
      drafts.push({
        ...base,
        recipient: farm.owner,
        scope: "nearby_farm",
        // Keyed on the reporting farm, not the camera, so two cameras on one
        // farm seeing the same disease warn a neighbour once.
        dedupeKey: `farm:${ownerId}:${diseaseKey}`,
        affectedPlots: farm.plots,
        matchedBy: farm.matchedBy,
        distanceKm: farm.distanceKm,
        district: farm.matchedBy === "district" ? source.district : undefined,
      });
    }

    if (drafts.length === 0) return { created: 0 };

    const cutoff = new Date(Date.now() - config.outbreakCooldownH * HOUR_MS);
    const recent = await OutbreakAlert.find({
      recipient: { $in: drafts.map((draft) => draft.recipient) },
      dedupeKey: { $in: [...new Set(drafts.map((draft) => draft.dedupeKey))] },
      createdAt: { $gte: cutoff },
    }).select("recipient dedupeKey");
    const already = new Set(recent.map((row) => `${row.recipient}|${row.dedupeKey}`));
    const fresh = drafts.filter(
      (draft) => !already.has(`${draft.recipient}|${draft.dedupeKey}`)
    );

    if (fresh.length === 0) return { created: 0 };

    const created = await OutbreakAlert.insertMany(fresh);

    for (const alert of created) {
      emitToUser(String(alert.recipient), "outbreak_alert", serializeOutbreak(alert));
    }
    await pushAll(created);

    logger.info(
      `Outbreak alert for ${disease} from device ${sourceDevice._id}: ${created.length} recipient(s)`
    );
    return { created: created.length };
  } catch (err) {
    logger.error(`Outbreak alerting failed for device ${sourceDevice?._id}`, err.message);
    return { created: 0, error: err.message };
  }
}

export const listOutbreaks = async (userId, options = {}) => {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 20, 1), 50);
  const since = new Date(Date.now() - LIST_WINDOW_DAYS * DAY_MS);

  const rows = await OutbreakAlert.find({
    recipient: userId,
    dismissedAt: null,
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .limit(limit);

  return rows.map(serializeOutbreak);
};

export const dismissOutbreak = async (userId, alertId) => {
  const row = await OutbreakAlert.findOneAndUpdate(
    { _id: alertId, recipient: userId },
    { $set: { dismissedAt: new Date() } },
    { new: true }
  );
  if (!row) throw httpError(404, "Alert not found");
  return { id: row._id, dismissedAt: row.dismissedAt };
};
