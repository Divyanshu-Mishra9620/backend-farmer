const EARTH_RADIUS_KM = 6371;

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
