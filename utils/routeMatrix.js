/**
 * Live intercity route matrix, matching Kufi v148.
 *
 * Google Distance Matrix supplies driving distance/duration for the planning run.
 * Those Google values are not stored. If the key is missing or a cell fails, the
 * existing haversine travel model is used instead.
 */
const { getCoordinates, haversineKm, SAME_AREA_RADIUS_KM, travelMinutesForKm, roundUpToStep } = require('./geo');

const MAX_POINTS = 10;

function pointKey(name) {
    return String(name || '').trim().replace(/\s+/g, ' ');
}

function pairKey(a, b) {
    return `${pointKey(a)}|||${pointKey(b)}`;
}

function validPoint(p) {
    return p && pointKey(p.name) && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
}

function uniquePoints(points) {
    const clean = [];
    const seen = new Set();
    for (const p of points || []) {
        if (!validPoint(p)) continue;
        const name = pointKey(p.name);
        if (seen.has(name)) continue;
        seen.add(name);
        clean.push({ name, lat: Number(p.lat), lng: Number(p.lng) });
        if (clean.length >= MAX_POINTS) break;
    }
    return clean;
}

function fallbackRoute(from, to) {
    const km = haversineKm(from, to);
    const minutes = travelMinutesForKm(km);
    return {
        from: from.name,
        to: to.name,
        distanceMeters: Math.round((km || 0) * 1000),
        durationSeconds: Math.round((minutes || 0) * 60),
        source: 'fallback',
        status: 'FALLBACK',
    };
}

async function fetchGoogleMatrix(points, travelMode, apiKey) {
    const coord = (p) => `${p.lat},${p.lng}`;
    const origins = points.map(coord).join('|');
    const params = new URLSearchParams({
        origins,
        destinations: origins,
        mode: travelMode || 'driving',
        key: apiKey,
    });
    const upstream = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?${params}`, {
        signal: AbortSignal.timeout(Number(process.env.GOOGLE_MATRIX_TIMEOUT_MS) || 20000),
    });
    const data = await upstream.json();
    if (!upstream.ok || data.status !== 'OK') {
        throw new Error(data.error_message || data.status || `HTTP_${upstream.status}`);
    }
    return data;
}

/**
 * Resolve a named point matrix. Returns { points, byPair, googleConfigured }.
 */
async function resolveRouteMatrix(points, { travelMode = 'driving' } = {}) {
    const unique = uniquePoints(points);
    const byPair = new Map();
    const googleConfigured = Boolean(process.env.GOOGLE_MAPS_API_KEY);

    if (unique.length < 2) {
        return { points: unique, byPair, googleConfigured, source: 'none' };
    }

    let googleData = null;
    if (googleConfigured) {
        try {
            googleData = await fetchGoogleMatrix(unique, travelMode, process.env.GOOGLE_MAPS_API_KEY);
        } catch (err) {
            console.warn('Distance Matrix failed, using haversine fallback:', err.message);
        }
    }

    for (let i = 0; i < unique.length; i++) {
        for (let j = 0; j < unique.length; j++) {
            if (i === j) continue;
            const from = unique[i];
            const to = unique[j];
            const element = googleData?.rows?.[i]?.elements?.[j];
            if (element?.status === 'OK' && element.duration && element.distance) {
                byPair.set(pairKey(from.name, to.name), {
                    from: from.name,
                    to: to.name,
                    distanceMeters: Number(element.distance.value) || 0,
                    durationSeconds: Number(element.duration.value) || 0,
                    source: 'google-live',
                    status: 'OK',
                });
            } else {
                byPair.set(pairKey(from.name, to.name), fallbackRoute(from, to));
            }
        }
    }

    return {
        points: unique,
        byPair,
        googleConfigured,
        source: googleData ? 'google-live' : 'fallback',
    };
}

function nearestNamedPoint(matrix, coords) {
    if (!matrix?.points?.length || !coords) return null;
    let best = null;
    let bestKm = Infinity;
    matrix.points.forEach((p) => {
        const km = haversineKm(coords, p);
        if (km !== null && km < bestKm) {
            bestKm = km;
            best = p;
        }
    });
    if (!best || bestKm > SAME_AREA_RADIUS_KM) return null;
    return best;
}

/**
 * Driving minutes from the live matrix when the two places sit in different
 * named bases. Same-base hops return null so the local haversine model still applies.
 */
function matrixTravelMinutes(from, to, routeMatrix) {
    const a = getCoordinates(from);
    const b = getCoordinates(to);
    if (!a || !b || !routeMatrix?.byPair) return null;
    const pa = nearestNamedPoint(routeMatrix, a);
    const pb = nearestNamedPoint(routeMatrix, b);
    if (!pa || !pb || pa.name === pb.name) return null;
    const route = routeMatrix.byPair.get(pairKey(pa.name, pb.name));
    const sec = Number(route?.durationSeconds);
    if (!Number.isFinite(sec) || sec < 0) return null;
    return roundUpToStep(sec / 60);
}

module.exports = {
    MAX_POINTS,
    resolveRouteMatrix,
    matrixTravelMinutes,
    uniquePoints,
};
