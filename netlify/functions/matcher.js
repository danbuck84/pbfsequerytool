const { executeQuery } = require("../../src/fseApi");
const airports = require("../../src/airports-mini.json");

const baseUrl = process.env.FSE_BASE_URL || "https://server.fseconomy.net/data";

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Radius of earth in Nautical Miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.round(R * c);
}

function parseFseXml(xml, itemTag) {
  const results = [];
  const regex = new RegExp(`<${itemTag}>([\\s\\S]*?)</${itemTag}>`, 'g');
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const itemXml = match[1];
    const item = {};
    const propRegex = /<([a-zA-Z0-9]+)>([^<]*)<\/\1>/g;
    let propMatch;
    while ((propMatch = propRegex.exec(itemXml)) !== null) {
      item[propMatch[1]] = propMatch[2].trim();
    }
    results.push(item);
  }
  return results;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const userKey = process.env.FSE_USER_KEY;
  if (!userKey) return { statusCode: 500, body: JSON.stringify({ error: "FSE_USER_KEY not configured" }) };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { icaos, commodity, makemodel, rentableOnly } = body;
  
  const hasModel = makemodel && makemodel.trim().length > 0;
  const hasIcaos = icaos && icaos.trim().length > 0;

  if (!hasModel && !hasIcaos) {
    return { statusCode: 400, body: JSON.stringify({ error: "Você precisa preencher os Hubs ou o Aircraft Model (ou ambos)." }) };
  }

  try {
    let seats = 0, mtow = 0, empty = 0, maxPayload = 0, maxRange = 0;
    let origins = [];
    let totalAircraftFound = 0;
    const aircraftAvailable = {};

    if (hasModel) {
      const confUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=aircraft&search=configs`;
      const confRes = await executeQuery(confUrl);
      const confList = parseFseXml(confRes.raw, "AircraftConfig");
      const config = confList.find(c => c.MakeModel === makemodel);
      
      seats = config ? parseInt(config.Seats) || 0 : 0;
      mtow = config ? parseFloat(config.MTOW) || 0 : 0;
      empty = config ? parseFloat(config.EmptyWeight) || 0 : 0;
      maxPayload = mtow - empty;
      
      let fuelCap = 0;
      const tanks = ["Ext1", "LTip", "LAux", "LMain", "Center1", "Center2", "Center3", "RMain", "RAux", "RTip", "Ext2"];
      for (const t of tanks) {
        if (config && config[t]) fuelCap += parseFloat(config[t]) || 0;
      }
      const gph = config ? parseFloat(config.GPH) || 0 : 0;
      const speed = config ? parseFloat(config.CruiseSpeed) || 0 : 0;
      maxRange = (gph > 0) ? (fuelCap / gph) * speed : 0;

      const acUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=aircraft&search=makemodel&makemodel=${encodeURIComponent(makemodel)}`;
      const acRes = await executeQuery(acUrl);
      
      if (acRes.raw.includes("<Error>")) {
        const errorMatch = /<Error>([^<]+)<\/Error>/.exec(acRes.raw);
        throw new Error("FSEconomy API: " + (errorMatch ? errorMatch[1] : "Rate limit excedido (Max 10). Espere 1 minuto."));
      }

      const acList = parseFseXml(acRes.raw, "Aircraft");
      totalAircraftFound = acList.length;

      for (const a of acList) {
        const dry = parseFloat(a.RentalDry) || 0;
        const wet = parseFloat(a.RentalWet) || 0;
        const isRentable = dry > 0 || wet > 0;
        
        if (!rentableOnly || isRentable) {
          const icao = a.Location;
          if (icao && icao !== "In Flight") {
            if (!aircraftAvailable[icao]) aircraftAvailable[icao] = [];
            aircraftAvailable[icao].push(a.Registration);
          }
        }
      }

      origins = Object.keys(aircraftAvailable);

      if (hasIcaos) {
        const requestedOrigins = icaos.split("-").map(s => s.trim().toUpperCase()).filter(Boolean);
        origins = origins.filter(o => requestedOrigins.includes(o));
      }

      if (origins.length === 0) {
        return { 
          statusCode: 200, 
          body: JSON.stringify({ 
            matches: [], 
            debug: { message: "Nenhuma aeronave encontrada nos hubs informados.", acListTotal: acList.length }
          }) 
        };
      }
    } else {
      origins = icaos.split("-").map(s => s.trim().toUpperCase()).filter(Boolean);
    }

    const chunkSize = 100; 
    let allJobs = [];
    
    for (let i = 0; i < origins.length; i += chunkSize) {
      const chunk = origins.slice(i, i + chunkSize);
      const chunkIcaos = chunk.join("-");
      const jobsUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=icao&search=jobsfrom&icaos=${encodeURIComponent(chunkIcaos)}`;
      const jobsRes = await executeQuery(jobsUrl);
      
      if (jobsRes.raw.includes("<Error>")) {
        const errorMatch = /<Error>([^<]+)<\/Error>/.exec(jobsRes.raw);
        throw new Error("FSEconomy API: " + (errorMatch ? errorMatch[1] : "Rate limit excedido na busca de jobs."));
      }

      const chunkJobs = parseFseXml(jobsRes.raw, "Assignment");
      allJobs = allJobs.concat(chunkJobs);
    }

    const typeLower = (commodity || "").toLowerCase();
    
    const finalJobs = allJobs.filter(j => {
      if (typeLower) {
        const type = (j.Type || "").toLowerCase();
        if (!type.includes(typeLower)) {
          return false;
        }
      }
      
      const origCoords = airports[j.Location];
      const destCoords = airports[j.ToIcao];
      let dist = 0;
      if (origCoords && destCoords) {
        dist = getDistance(origCoords[0], origCoords[1], destCoords[0], destCoords[1]);
      }
      j._distance = dist;
      
      if (hasModel) {
        const amount = parseFloat(j.Amount) || 0;
        const unit = (j.UnitType || "").toLowerCase();
        
        // Em FSE, pelo menos 1 assento precisa ser o piloto
        if (unit === "passengers" && seats > 0 && amount > (seats - 1)) return false;
        if (unit === "kg" && maxPayload > 0 && amount > maxPayload) return false;
        
        // Filtro de alcance usando dados oficiais do FSE com 5% de margem
        if (maxRange > 0 && dist > 0 && dist > (maxRange * 1.05)) return false;
      }
      
      return true;
    });

    const results = finalJobs.map(j => {
      const pay = parseFloat(j.Pay) || 0;
      const dist = j._distance;
      const payNm = dist > 0 ? Math.round(pay / dist) : 0;
      
      return {
        Origin: j.Location,
        Destination: j.ToIcao,
        Type: j.Type || "-",
        Amount: `${j.Amount} ${j.UnitType}`,
        Distance: dist > 0 ? `${dist}` : "N/A",
        Pay: pay,
        "Pay/NM": payNm,
        Aeronaves: aircraftAvailable[j.Location] ? aircraftAvailable[j.Location].join(", ") : (hasModel ? "" : "N/A")
      };
    });

    results.sort((a, b) => (b["Pay/NM"] || 0) - (a["Pay/NM"] || 0));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ 
        matches: results, 
        aircraftConfig: { seats, maxPayload, maxRange }, 
        locationsCount: origins.length,
        debug: { 
          hasModel,
          totalAircraftFound,
          originsWithAircraft: origins.length,
          totalJobsFetched: allJobs.length,
          finalJobsCount: finalJobs.length
        }
      }),
    };

  } catch (error) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
