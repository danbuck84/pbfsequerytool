const { executeQuery } = require("../../src/fseApi");

const baseUrl = process.env.FSE_BASE_URL || "https://server.fseconomy.net/data";

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
  
  // Now makemodel is the only strictly required parameter. 
  // If icaos is empty, we do a GLOBAL SEARCH.
  if (!makemodel) {
    return { statusCode: 400, body: JSON.stringify({ error: "Aircraft Make/Model is required" }) };
  }

  try {
    // 1. Fetch aircraft config to check capacity (Seats/Weight)
    const confUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=aircraft&search=configs`;
    const confRes = await executeQuery(confUrl);
    const confList = parseFseXml(confRes.raw, "AircraftConfig");
    const config = confList.find(c => c.MakeModel === makemodel);
    
    const seats = config ? parseInt(config.Seats) || 0 : 0;
    const mtow = config ? parseFloat(config.MTOW) || 0 : 0;
    const empty = config ? parseFloat(config.EmptyWeight) || 0 : 0;
    const maxPayload = mtow - empty;

    // 2. ALWAYS fetch aircraft globally by makemodel to ensure we get Rental prices.
    const acUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=aircraft&search=makemodel&makemodel=${encodeURIComponent(makemodel)}`;
    const acRes = await executeQuery(acUrl);
    const acList = parseFseXml(acRes.raw, "Aircraft");

    const aircraftAvailable = {}; // ICAO -> Array of rentable registrations
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

    let origins = Object.keys(aircraftAvailable);

    // 3. If user provided specific ICAOs, filter our origins list to only those.
    if (icaos && icaos.trim()) {
      const requestedOrigins = icaos.split("-").map(s => s.trim().toUpperCase()).filter(Boolean);
      origins = origins.filter(o => requestedOrigins.includes(o));
    }

    if (origins.length === 0) {
      return { 
        statusCode: 200, 
        body: JSON.stringify({ 
          matches: [], 
          debug: { message: "No available aircraft found matching the criteria.", acListTotal: acList.length }
        }) 
      };
    }

    // 4. Fetch jobs from the matched origins in chunks
    const chunkSize = 100; 
    let allJobs = [];
    
    for (let i = 0; i < origins.length; i += chunkSize) {
      const chunk = origins.slice(i, i + chunkSize);
      const chunkIcaos = chunk.join("-");
      const jobsUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=icao&search=jobsfrom&icaos=${encodeURIComponent(chunkIcaos)}`;
      const jobsRes = await executeQuery(jobsUrl);
      const chunkJobs = parseFseXml(jobsRes.raw, "Job");
      allJobs = allJobs.concat(chunkJobs);
    }

    // 5. Filter jobs by commodity/type and capacity
    const commodityLower = (commodity || "").toLowerCase();
    
    const finalJobs = allJobs.filter(j => {
      // Check both Commodity and Type tags for matches (e.g. VIP is often in Type)
      if (commodityLower) {
        const comm = (j.Commodity || "").toLowerCase();
        const type = (j.Type || "").toLowerCase();
        if (!comm.includes(commodityLower) && !type.includes(commodityLower)) {
          return false;
        }
      }
      
      const amount = parseFloat(j.Amount) || 0;
      const unit = (j.UnitType || "").toLowerCase();
      
      // Capacity check
      if (unit === "passengers" && seats > 0 && amount > seats) return false;
      if (unit === "kg" && maxPayload > 0 && amount > maxPayload) return false;
      
      return true;
    });

    // 6. Format results
    const results = finalJobs.map(j => {
      const pay = parseFloat(j.Pay) || 0;
      const distance = parseFloat(j.Distance) || 0;
      const payPerNm = distance > 0 ? (pay / distance) : 0;
      
      return {
        Origin: j.Location,
        Destination: j.ToIcao,
        Commodity: j.Commodity || j.Type || "N/A", // Use Type if Commodity is empty
        Amount: `${j.Amount} ${j.UnitType}`,
        Distance: distance > 0 ? distance : "?",
        Pay: pay,
        "Pay/NM": parseFloat(payPerNm.toFixed(2)),
        Aeronaves: aircraftAvailable[j.Location] ? aircraftAvailable[j.Location].join(", ") : ""
      };
    });

    // Sort by Pay/NM descending by default
    results.sort((a, b) => (b["Pay/NM"] || 0) - (a["Pay/NM"] || 0));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ 
        matches: results, 
        aircraftConfig: { seats, maxPayload }, 
        locationsCount: origins.length,
        debug: { 
          totalAircraftFound: acList.length,
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
