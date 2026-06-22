// Netlify Function: relays requests to LTA DataMall.
// The browser calls THIS function; this function calls LTA with your secret key.
// Your key lives in Netlify env var LTA_API_KEY (never in the code, never in the repo).

const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice';

// Simple in-memory caches. These persist while the function instance stays warm,
// so the big stop/route lists aren't re-fetched on every single search.
let stopsCache = null;        // { code: { name, road } }
let routesCache = null;       // { serviceNo: [ {stopCode, seq, direction} ... ] }
let stopsCacheTime = 0;
let routesCacheTime = 0;
const CACHE_MS = 1000 * 60 * 60 * 12; // 12 hours

async function ltaGet(path, key, skip = 0) {
  const url = `${LTA_BASE}/${path}${path.includes('?') ? '&' : '?'}$skip=${skip}`;
  const res = await fetch(url, {
    headers: { AccountKey: key, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`LTA ${path} returned ${res.status}`);
  return res.json();
}

// LTA returns 500 records per call; keep paging with $skip until a short page.
async function ltaGetAll(path, key) {
  let all = [];
  let skip = 0;
  for (let i = 0; i < 200; i++) {       // hard safety cap
    const json = await ltaGet(path, key, skip);
    const rows = json.value || [];
    all = all.concat(rows);
    if (rows.length < 500) break;
    skip += 500;
  }
  return all;
}

async function getStops(key) {
  if (stopsCache && Date.now() - stopsCacheTime < CACHE_MS) return stopsCache;
  const rows = await ltaGetAll('BusStops', key);
  const map = {};
  for (const r of rows) {
    map[r.BusStopCode] = { name: r.Description, road: r.RoadName };
  }
  stopsCache = map;
  stopsCacheTime = Date.now();
  return map;
}

async function getRoutes(key) {
  if (routesCache && Date.now() - routesCacheTime < CACHE_MS) return routesCache;
  const rows = await ltaGetAll('BusRoutes', key);
  const map = {};
  for (const r of rows) {
    const svc = r.ServiceNo;
    if (!map[svc]) map[svc] = [];
    map[svc].push({
      stopCode: r.BusStopCode,
      seq: r.StopSequence,
      direction: r.Direction,
    });
  }
  routesCache = map;
  routesCacheTime = Date.now();
  return map;
}

function minutesUntil(iso) {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  const mins = Math.floor(diffMs / 60000);   // LTA: round DOWN to nearest minute
  return mins < 0 ? 0 : mins;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const key = process.env.LTA_API_KEY;
  if (!key) {
    return { statusCode: 500, headers,
      body: JSON.stringify({ error: 'Server is missing LTA_API_KEY. Set it in Netlify environment variables.' }) };
  }

  const params = event.queryStringParameters || {};
  const action = params.action;

  try {
    // 1) Arrivals at a stop: /bus?action=arrivals&stop=83139
    if (action === 'arrivals') {
      const stop = (params.stop || '').trim();
      if (!/^\d{5}$/.test(stop)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Enter a valid 5-digit bus stop code.' }) };
      }
      const [arr, stops] = await Promise.all([
        ltaGet(`v3/BusArrival?BusStopCode=${stop}`, key),
        getStops(key),
      ]);
      const services = (arr.Services || []).map((s) => ({
        service: s.ServiceNo,
        load: s.NextBus?.Load || null,
        arrivals: [s.NextBus, s.NextBus2, s.NextBus3]
          .map((b) => minutesUntil(b?.EstimatedArrival))
          .filter((m) => m !== null),
      })).sort((a, b) => a.service.localeCompare(b.service, undefined, { numeric: true }));

      const stopInfo = stops[stop] || null;
      return { statusCode: 200, headers,
        body: JSON.stringify({ type: 'arrivals', stopCode: stop, stopInfo, services }) };
    }

    // 2) Stops on a service: /bus?action=route&service=15
    if (action === 'route') {
      const service = (params.service || '').trim().toUpperCase();
      if (!service) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Enter a bus service number.' }) };
      }
      const [routes, stops] = await Promise.all([getRoutes(key), getStops(key)]);
      const legs = routes[service];
      if (!legs) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `No bus service "${service}" found.` }) };
      }
      // Group by direction, ordered by sequence, with readable stop names.
      const byDirection = {};
      for (const leg of legs.sort((a, b) => a.seq - b.seq)) {
        const d = leg.direction;
        if (!byDirection[d]) byDirection[d] = [];
        const info = stops[leg.stopCode] || {};
        byDirection[d].push({
          stopCode: leg.stopCode,
          name: info.name || leg.stopCode,
          road: info.road || '',
        });
      }
      return { statusCode: 200, headers,
        body: JSON.stringify({ type: 'route', service, directions: byDirection }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action.' }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not reach LTA. ' + err.message }) };
  }
};
