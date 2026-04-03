const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SPORT_SLUG = {
  football: 'football',
  basketball: 'basketball',
  hockey: 'ice-hockey',
  baseball: 'baseball',
  tennis: 'tennis',
  mma: 'mma',
  rugby: 'rugby',
  american_football: 'american-football',
  cricket: 'cricket',
};

async function sbFetch(path, options = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      ...options.headers
    },
    ...options
  });
  if (options.method === 'PATCH') return resp.ok;
  return resp.json();
}

async function sofaFetch(endpoint) {
  try {
    const resp = await fetch(`https://api.sofascore.com/api/v1/${endpoint}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.sofascore.com/',
        'Origin': 'https://www.sofascore.com',
      }
    });
    if (!resp.ok) {
      console.log(`Sofascore ${resp.status} for ${endpoint}`);
      return null;
    }
    return resp.json();
  } catch(e) {
    console.error('Sofascore fetch error:', e.message);
    return null;
  }
}

async function getTeamId(teamName, sportSlug) {
  const data = await sofaFetch(`search/all?q=${encodeURIComponent(teamName)}&page=0`);
  if (!data?.results) return null;
  const teams = data.results.filter(r => r.type === 'team' && r.entity?.sport?.slug === sportSlug);
  if (teams.length === 0) return null;
  const normalized = teamName.toLowerCase();
  const exact = teams.find(t =>
    t.entity?.name?.toLowerCase() === normalized ||
    t.entity?.shortName?.toLowerCase() === normalized
  );
  return exact?.entity?.id || teams[0]?.entity?.id || null;
}

function calcForm(events, teamId) {
  const finished = (events || []).filter(e => e.status?.type === 'finished').slice(0, 5);
  let form = '', scored = 0, conceded = 0;
  for (const e of finished) {
    const isHome = e.homeTeam?.id === teamId;
    const hg = e.homeScore?.current ?? 0;
    const ag = e.awayScore?.current ?? 0;
    scored += isHome ? hg : ag;
    conceded += isHome ? ag : hg;
    if (isHome) form += hg > ag ? 'W' : hg === ag ? 'D' : 'L';
    else form += ag > hg ? 'W' : ag === hg ? 'D' : 'L';
  }
  return { form, scored, conceded };
}

async function scrapeTeam(teamName, sport) {
  const sportSlug = SPORT_SLUG[sport] || 'football';
  await new Promise(r => setTimeout(r, 500));
  const teamId = await getTeamId(teamName, sportSlug);
  if (!teamId) return { id: null, events: null, injuries: null };

  await new Promise(r => setTimeout(r, 300));
  const [eventsData, injData] = await Promise.all([
    sofaFetch(`team/${teamId}/events/last/0`),
    sofaFetch(`team/${teamId}/players/missing`).catch(() => null),
  ]);

  return {
    id: teamId,
    events: eventsData?.events || [],
    injuries: injData?.missingPlayers || [],
  };
}

async function scrapeMatch(homeTeam, awayTeam, sport) {
  console.log(`Scraping ${homeTeam} vs ${awayTeam} (${sport})`);

  const [home, away] = await Promise.all([
    scrapeTeam(homeTeam, sport),
    scrapeTeam(awayTeam, sport),
  ]);

  if (!home.id || !away.id) {
    console.log(`  IDs not found: ${homeTeam}=${home.id}, ${awayTeam}=${away.id}`);
    return null;
  }

  const homeForm = calcForm(home.events, home.id);
  const awayForm = calcForm(away.events, away.id);

  // H2H from home team events
  const h2hMatches = (home.events || []).filter(e =>
    (e.homeTeam?.id === home.id && e.awayTeam?.id === away.id) ||
    (e.homeTeam?.id === away.id && e.awayTeam?.id === home.id)
  ).slice(0, 5);

  const h2hStr = h2hMatches.length > 0
    ? h2hMatches.map(e =>
        `${e.homeTeam?.shortName || e.homeTeam?.name} ${e.homeScore?.current}-${e.awayScore?.current} ${e.awayTeam?.shortName || e.awayTeam?.name}`
      ).join(' | ')
    : null;

  const homeInjStr = home.injuries.slice(0, 5).map(p => p.player?.name).filter(Boolean).join(', ') || null;
  const awayInjStr = away.injuries.slice(0, 5).map(p => p.player?.name).filter(Boolean).join(', ') || null;

  return {
    home_form: homeForm.form ? `${homeForm.form} (${homeForm.scored} scored, ${homeForm.conceded} conceded)` : null,
    away_form: awayForm.form ? `${awayForm.form} (${awayForm.scored} scored, ${awayForm.conceded} conceded)` : null,
    h2h: h2hStr,
    home_injuries: homeInjStr,
    away_injuries: awayInjStr,
    context_source: 'sofascore',
    context_updated_at: new Date().toISOString(),
  };
}

// Main scrape endpoint
app.post('/scrape', async (req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const events = await sbFetch(
      `events?statut=eq.NS&context_source=is.null&date_evenement=gte.${from}&date_evenement=lte.${to}&select=id,equipe_domicile,equipe_exterieur,sport,competition&order=date_evenement.asc&limit=60`
    );

    if (!Array.isArray(events)) {
      return res.status(500).json({ error: 'Failed to fetch events', detail: events });
    }

    console.log(`Found ${events.length} events to enrich`);
    let enriched = 0, errors = 0, skipped = 0;

    for (const e of events) {
      try {
        const context = await scrapeMatch(e.equipe_domicile, e.equipe_exterieur, e.sport);

        if (context) {
          await sbFetch(`events?id=eq.${e.id}`, {
            method: 'PATCH',
            body: JSON.stringify(context)
          });
          enriched++;
          console.log(`  ✓ ${e.equipe_domicile} vs ${e.equipe_exterieur}`);
        } else {
          // Mark as attempted so we don't retry forever
          await sbFetch(`events?id=eq.${e.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              context_source: 'not_found',
              context_updated_at: new Date().toISOString()
            })
          });
          skipped++;
          console.log(`  ✗ ${e.equipe_domicile} vs ${e.equipe_exterieur} (not found)`);
        }

        await new Promise(r => setTimeout(r, 800));
      } catch(err) {
        console.error(`Error for ${e.equipe_domicile}:`, err.message);
        errors++;
      }
    }

    res.json({ total: events.length, enriched, skipped, errors });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Test FlashScore internal API
app.get('/test-flash-api', async (req, res) => {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://www.flashscore.com/',
      'Origin': 'https://www.flashscore.com',
      'x-fsign': 'SW9D1eZo',
    };

    const results = {};

    // Test different internal endpoints
    const endpoints = [
      'https://www.flashscore.com/x/feed/proxy-local-tournaments-1-/en/',
      'https://flashscore.com/x/req/m_0', 
      'https://d.flashscore.com/x/feed/proxy-local-tournaments-1-/en/',
    ];

    for (const url of endpoints) {
      try {
        const r = await fetch(url, { headers });
        const text = await r.text();
        results[url] = { status: r.status, sample: text.slice(0, 200) };
      } catch(e) {
        results[url] = { error: e.message };
      }
    }

    res.json(results);
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Test FlashScore injuries
app.get('/test-flash-injuries', async (req, res) => {
  try {
    // Test avec Manchester City sur FlashScore
    const resp = await fetch('https://www.flashscore.com/team/manchester-city/qjb7TUb5/squad/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://www.flashscore.com/',
      }
    });
    const text = await resp.text();
    // Look for injury-related keywords
    const hasInjury = text.includes('injury') || text.includes('injured') || text.includes('Injured');
    res.json({ status: resp.status, ok: resp.ok, hasInjury, sample: text.slice(0, 300) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Test ESPN search team by name
app.get('/test-espn-search', async (req, res) => {
  try {
    const resp = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams?limit=100', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await resp.json();
    const teams = data?.sports?.[0]?.leagues?.[0]?.teams || [];
    res.json({ status: resp.status, count: teams.length, sample: teams.slice(0,3).map(t => ({ id: t.team.id, name: t.team.displayName })) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Test ESPN injuries
app.get('/test-espn-injuries', async (req, res) => {
  try {
    const resp = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/382/injuries', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await resp.json();
    res.json({ status: resp.status, keys: Object.keys(data), sample: JSON.stringify(data).slice(0, 500) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Test ESPN team schedule/results
app.get('/test-espn-results', async (req, res) => {
  try {
    const resp = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/382/schedule', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await resp.json();
    res.json({ status: resp.status, keys: Object.keys(data), sample: JSON.stringify(data).slice(0, 800) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Test ESPN team detail
app.get('/test-espn-team', async (req, res) => {
  try {
    const resp = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/382', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await resp.json();
    res.json({ status: resp.status, keys: Object.keys(data), sample: JSON.stringify(data).slice(0, 500) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Test ESPN all sports
app.get('/test-espn-all', async (req, res) => {
  const endpoints = {
    football_epl: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/364/record',
    football_ucl: 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/teams',
    basketball_nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/record',
    hockey_nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/1/record',
    baseball_mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/1/record',
    tennis: 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/athletes',
    mma_ufc: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/athletes',
    cricket: 'https://site.api.espn.com/apis/site/v2/sports/cricket/teams',
    american_football: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/1/record',
  };

  const results = {};
  for (const [sport, url] of Object.entries(endpoints)) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      const data = await resp.json();
      results[sport] = { status: resp.status, sample: JSON.stringify(data).slice(0, 150) };
    } catch(e) {
      results[sport] = { error: e.message };
    }
  }
  res.json(results);
});

// Test ESPN access
app.get('/test-espn', async (req, res) => {
  try {
    const resp = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const data = await resp.json();
    res.json({ status: resp.status, ok: resp.ok, sample: JSON.stringify(data).slice(0, 200) });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Test FlashScore access
app.get('/test-flash', async (req, res) => {
  try {
    const resp = await fetch('https://www.flashscore.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });
    res.json({ status: resp.status, ok: resp.ok });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));
