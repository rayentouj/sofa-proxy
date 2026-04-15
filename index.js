const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
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

// ── HELPERS ──────────────────────────────────────────────────────────────────

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

async function safeFetch(url, headers = {}) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        ...headers
      }
    });
    return resp;
  } catch(e) {
    console.error(`Fetch error for ${url}:`, e.message);
    return null;
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── TRANSFERMARKT (Football injuries) ────────────────────────────────────────

const TM_LEAGUE_CODES = {
  'Premier League': 'GB1', 'La Liga': 'ES1', 'Bundesliga': 'L1',
  'Serie A': 'IT1', 'Ligue 1': 'FR1', 'Eredivisie': 'NL1',
  'Primeira Liga': 'PO1', 'Super Lig': 'TR1', 'Championship': 'GB2',
  'League One': 'GB3', 'League Two': 'GB4', 'Scottish Premiership': 'SC1',
  'Saudi Pro League': 'SA1', 'MLS': 'MLS1', 'Brasileirao': 'BRA1',
  'Liga MX': 'MEX1', 'Argentine Primera División': 'AR1N',
  'FA Cup': 'GBFAC', 'EFL Cup': 'GBLC',
  'UEFA Champions League': 'CL', 'UEFA Europa League': 'EL',
  'UEFA Conference League': 'UECL',
};

const injuryCache = {};

async function fetchTransfermarktInjuries(leagueCode) {
  if (injuryCache[leagueCode]) return injuryCache[leagueCode];

  const url = `https://www.transfermarkt.com/a/verletztespieler/wettbewerb/${leagueCode}`;
  const resp = await safeFetch(url, {
    'Accept': 'text/html,application/xhtml+xml',
    'Referer': 'https://www.transfermarkt.com/',
    'Accept-Language': 'en-US,en;q=0.9',
  });
  if (!resp || !resp.ok) return {};

  const html = await resp.text();
  const $ = cheerio.load(html);
  const injuries = {};

  $('table.items > tbody > tr, .items > tbody > tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;

    const playerName = $(cells[1]).find('a').first().text().trim();
    const position = $(cells[2]).text().trim();
    const teamName = $(cells[3]).find('a').first().text().trim();
    const injuryType = $(cells[4]).text().trim();
    const returnDate = $(cells[5]).text().trim();
    const valueText = $(cells[6]).text().trim();

    if (!playerName || !teamName) return;

    let value = 0;
    const vm = valueText.replace(/[€$£]/g, '').trim();
    if (vm.includes('m')) value = parseFloat(vm) || 0;
    else if (vm.includes('k')) value = (parseFloat(vm) || 0) / 1000;

    if (!injuries[teamName]) injuries[teamName] = [];
    injuries[teamName].push({ name: playerName, position, injury: injuryType, returnDate, value });
  });

  injuryCache[leagueCode] = injuries;
  return injuries;
}

function getInjuryImpact(player, allPlayers) {
  const sorted = [...allPlayers].sort((a, b) => b.value - a.value);
  const top5 = sorted.slice(0, 5).map(p => p.name);
  const avgValue = allPlayers.reduce((s, p) => s + p.value, 0) / (allPlayers.length || 1);
  if (top5.includes(player.name)) return 'high';
  if (player.value > avgValue * 0.5) return 'medium';
  return 'low';
}

async function getFootballInjuries(teamName, competition) {
  const leagueCode = TM_LEAGUE_CODES[competition];
  if (!leagueCode) return null;

  const injuries = await fetchTransfermarktInjuries(leagueCode);

  const teamKey = Object.keys(injuries).find(t =>
    t.toLowerCase().includes(teamName.toLowerCase().split(' ')[0]) ||
    teamName.toLowerCase().includes(t.toLowerCase().split(' ')[0])
  );
  if (!teamKey) return null;

  const teamInjuries = injuries[teamKey];
  if (!teamInjuries?.length) return null;

  const result = teamInjuries
    .map(p => ({ ...p, impact: getInjuryImpact(p, teamInjuries) }))
    .filter(p => p.impact !== 'low')
    .slice(0, 6);

  if (!result.length) return null;

  return result.map(p =>
    `${p.name} (${p.impact}${p.returnDate ? ', retour: ' + p.returnDate : ''}${p.injury ? ', ' + p.injury : ''})`
  ).join('; ');
}

// ── ESPN (Sports US injuries + form) ─────────────────────────────────────────

const ESPN_SPORT_CONFIG = {
  basketball: { sport: 'basketball', league: 'nba' },
  hockey:     { sport: 'hockey',     league: 'nhl' },
  baseball:   { sport: 'baseball',   league: 'mlb' },
  american_football: { sport: 'football', league: 'nfl' },
};

async function findESPNTeam(teamName, sport, league) {
  const resp = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams?limit=100`);
  if (!resp?.ok) return null;
  const data = await resp.json();
  const teams = data?.sports?.[0]?.leagues?.[0]?.teams || [];
  const normalized = teamName.toLowerCase();
  const found = teams.find(t =>
    t.team?.displayName?.toLowerCase() === normalized ||
    t.team?.shortDisplayName?.toLowerCase() === normalized ||
    t.team?.name?.toLowerCase() === normalized ||
    t.team?.displayName?.toLowerCase().includes(normalized) ||
    normalized.includes(t.team?.name?.toLowerCase())
  );
  return found?.team?.id || null;
}

async function getESPNInjuries(teamId, sport, league) {
  const resp = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/roster`);
  if (!resp?.ok) return null;
  const data = await resp.json();
  const athletes = data?.athletes || [];

  const injured = athletes.filter(a => a.injuries?.length > 0);
  if (!injured.length) return null;

  const starters = athletes.slice(0, 10).map(a => a.displayName || a.fullName);

  return injured.map(p => {
    const impact = starters.includes(p.displayName || p.fullName) ? 'high' : 'medium';
    const status = p.injuries?.[0]?.status || 'Out';
    return `${p.displayName || p.fullName} (${impact}, ${status})`;
  }).join('; ');
}

async function getESPNForm(teamId, sport, league) {
  // Try current season first, then previous
  const years = [2026, 2025, 2024];
  let completed = [];

  for (const year of years) {
    const resp = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule?season=${year}`);
    if (!resp?.ok) continue;
    const data = await resp.json();
    const events = data?.events || [];
    completed = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    if (completed.length > 0) break;
  }

  if (!completed.length) return null;
  const last5 = completed.slice(-5);

  let form = '', scored = 0, conceded = 0;
  for (const event of last5) {
    const comp = event.competitions?.[0];
    const ourTeam = comp?.competitors?.find(c => c.team?.id === String(teamId));
    const oppTeam = comp?.competitors?.find(c => c.team?.id !== String(teamId));
    if (!ourTeam || !oppTeam) continue;
    const ourScore = parseInt(ourTeam.score) || 0;
    const oppScore = parseInt(oppTeam.score) || 0;
    scored += ourScore;
    conceded += oppScore;
    form += ourScore > oppScore ? 'W' : ourScore < oppScore ? 'L' : 'D';
  }

  return form ? `${form} (${scored} scored, ${conceded} conceded)` : null;
}

// ── FLASHSCORE (news for individual sports) ───────────────────────────────────

const flashHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://www.flashscore.com/',
  'x-fsign': 'SW9D1eZo',
};

async function searchFlashscoreEntity(name) {
  const resp = await safeFetch(
    `https://s.flashscore.com/search/?q=${encodeURIComponent(name)}&l=1&s=1&f=1%3B1&pid=2&sid=1`,
    { 'Accept': 'application/json' }
  );
  if (!resp?.ok) return null;
  const text = await resp.text();
  // Parse JSONP: cjs.search.jsonpCallback({...})
  try {
    const jsonMatch = text.match(/jsonpCallback\((.+)\)$/s);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      const result = data?.results?.[0];
      return result?.id || null;
    }
  } catch(e) {}
  // Fallback: regex
  const match = text.match(/"id":"([A-Za-z0-9]{8})"/);
  return match ? match[1] : null;
}

async function getFlashscoreNews(entityId) {
  const resp = await safeFetch(
    `https://16.flashscore.ninja/16/x/feed/pnf_${entityId}`,
    flashHeaders
  );
  if (!resp?.ok) return null;
  const text = await resp.text();
  if (!text || text.length < 10) return null;

  const titles = [];
  const parts = text.split('PV÷');
  for (const part of parts) {
    if (part.length > 20 && part.length < 200 && !part.includes('http') && !part.includes('.jpeg') && !part.includes('.png')) {
      const title = part.split('¬')[0].trim();
      if (title.length > 20 && !title.includes('÷')) titles.push(title);
    }
  }
  return titles.slice(0, 3).join(' | ') || null;
}

// ── MAIN SCRAPE LOGIC ─────────────────────────────────────────────────────────

async function scrapeFootball(event) {
  const { equipe_domicile: home, equipe_exterieur: away, competition } = event;

  const [homeInj, awayInj] = await Promise.all([
    getFootballInjuries(home, competition),
    getFootballInjuries(away, competition),
  ]);

  await delay(500);
  const [homeId, awayId] = await Promise.all([
    searchFlashscoreEntity(home),
    searchFlashscoreEntity(away),
  ]);

  let homeNews = null, awayNews = null;
  if (homeId) { await delay(300); homeNews = await getFlashscoreNews(homeId); }
  if (awayId) { await delay(300); awayNews = await getFlashscoreNews(awayId); }

  const news = [homeNews, awayNews].filter(Boolean).join(' | ') || null;
  const hasData = homeInj || awayInj || news;
  if (!hasData) return null;

  return {
    home_form: null,
    away_form: null,
    h2h: null,
    home_injuries: homeInj,
    away_injuries: awayInj,
    news,
    context_source: 'transfermarkt+flashscore',
    context_updated_at: new Date().toISOString(),
  };
}

async function scrapeUSsport(event) {
  const { equipe_domicile: home, equipe_exterieur: away, sport } = event;
  const config = ESPN_SPORT_CONFIG[sport];
  if (!config) return null;

  const [homeId, awayId] = await Promise.all([
    findESPNTeam(home, config.sport, config.league),
    findESPNTeam(away, config.sport, config.league),
  ]);
  if (!homeId || !awayId) return null;

  const [homeInj, awayInj, homeForm, awayForm] = await Promise.all([
    getESPNInjuries(homeId, config.sport, config.league),
    getESPNInjuries(awayId, config.sport, config.league),
    getESPNForm(homeId, config.sport, config.league),
    getESPNForm(awayId, config.sport, config.league),
  ]);

  if (!homeInj && !awayInj && !homeForm && !awayForm) return null;

  return {
    home_form: homeForm,
    away_form: awayForm,
    h2h: null,
    home_injuries: homeInj,
    away_injuries: awayInj,
    news: null,
    context_source: 'espn',
    context_updated_at: new Date().toISOString(),
  };
}

async function scrapeIndividualSport(event) {
  const { equipe_domicile: p1, equipe_exterieur: p2 } = event;

  const [p1Id, p2Id] = await Promise.all([
    searchFlashscoreEntity(p1),
    searchFlashscoreEntity(p2),
  ]);

  const [p1News, p2News] = await Promise.all([
    p1Id ? getFlashscoreNews(p1Id) : null,
    p2Id ? getFlashscoreNews(p2Id) : null,
  ]);

  const news = [p1News, p2News].filter(Boolean).join(' | ') || null;
  if (!news) return null;

  return {
    home_form: null, away_form: null, h2h: null,
    home_injuries: null, away_injuries: null,
    news,
    context_source: 'flashscore_news',
    context_updated_at: new Date().toISOString(),
  };
}

async function scrapeEvent(event) {
  const { sport } = event;
  if (sport === 'football') return scrapeFootball(event);
  if (['basketball', 'hockey', 'baseball', 'american_football'].includes(sport)) return scrapeUSsport(event);
  if (['tennis', 'mma', 'cricket', 'rugby'].includes(sport)) return scrapeIndividualSport(event);
  return null;
}

// ── MAIN ENDPOINT ─────────────────────────────────────────────────────────────

app.post('/scrape', async (req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const events = await sbFetch(
      `events?statut=eq.NS&context_source=is.null&date_evenement=gte.${from}&date_evenement=lte.${to}&select=id,equipe_domicile,equipe_exterieur,sport,competition&order=date_evenement.asc&limit=80`
    );

    if (!Array.isArray(events)) {
      return res.status(500).json({ error: 'Failed to fetch events', detail: events });
    }

    console.log(`Found ${events.length} events to enrich`);
    let enriched = 0, errors = 0, skipped = 0;

    for (const e of events) {
      try {
        console.log(`Processing: ${e.equipe_domicile} vs ${e.equipe_exterieur} (${e.sport})`);
        const context = await scrapeEvent(e);

        if (context) {
          await sbFetch(`events?id=eq.${e.id}`, { method: 'PATCH', body: JSON.stringify(context) });
          enriched++;
          console.log(`  ✓`);
        } else {
          await sbFetch(`events?id=eq.${e.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ context_source: 'not_found', context_updated_at: new Date().toISOString() })
          });
          skipped++;
          console.log(`  ✗`);
        }
        await delay(800);
      } catch(err) {
        console.error(`Error:`, err.message);
        errors++;
      }
    }

    res.json({ total: events.length, enriched, skipped, errors });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TEST ENDPOINTS ────────────────────────────────────────────────────────────

app.get('/test-transfermarkt', async (req, res) => {
  try {
    const injuries = await fetchTransfermarktInjuries('GB1');
    const teams = Object.keys(injuries);
    const sample = teams.slice(0, 3).map(t => ({ team: t, injured: injuries[t].slice(0, 3) }));
    res.json({ teams: teams.length, sample });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/test-espn-nba', async (req, res) => {
  try {
    const teamId = await findESPNTeam('Los Angeles Lakers', 'basketball', 'nba');
    const [injuries, form] = await Promise.all([
      getESPNInjuries(teamId, 'basketball', 'nba'),
      getESPNForm(teamId, 'basketball', 'nba'),
    ]);
    res.json({ teamId, injuries, form });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/test-flash-news', async (req, res) => {
  try {
    const teamId = await searchFlashscoreEntity('Manchester City');
    const news = teamId ? await getFlashscoreNews(teamId) : null;
    res.json({ teamId, news });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-tm-cells', async (req, res) => {
  try {
    const url = 'https://www.transfermarkt.com/premier-league/verletztespieler/wettbewerb/GB1';
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://www.google.com/',
      }
    });
    const text = await resp.text();
    const cheerio = require('cheerio');
    const $ = cheerio.load(text);
    const rows = [];
    $('table.items tbody tr').each((i, row) => {
      if (i > 3) return;
      const cells = $(row).find('td');
      rows.push({
        cellCount: cells.length,
        cells: cells.map((_, c) => $(c).text().trim().slice(0, 50)).get()
      });
    });
    res.json({ rowCount: $('table.items tbody tr').length, rows });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-espn-scores', async (req, res) => {
  try {
    const resp = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/schedule?season=2026`);
    const data = await resp.json();
    const events = data?.events || [];
    const completed = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    const last = completed.slice(-2).map(e => {
      const comp = e.competitions?.[0];
      return {
        name: e.name,
        status: comp?.status?.type,
        competitors: comp?.competitors?.map(c => ({
          id: c.team?.id, name: c.team?.displayName,
          score: c.score, scoreType: typeof c.score
        }))
      };
    });
    res.json({ total: events.length, completed: completed.length, last });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-tm-html', async (req, res) => {
  try {
    const url = 'https://www.transfermarkt.com/premier-league/verletztespieler/wettbewerb/GB1';
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://www.google.com/',
      }
    });
    const text = await resp.text();
    const cheerio = require('cheerio');
    const $ = cheerio.load(text);
    const tables = $('table').map((_, t) => $(t).attr('class')).get();
    const firstRows = $('table').first().find('tr').slice(0, 3).map((_, r) => $(r).text().trim().slice(0, 100)).get();
    res.json({ tables, firstRows, htmlSnippet: text.slice(text.indexOf('verletzte'), text.indexOf('verletzte') + 500) });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-espn-form', async (req, res) => {
  try {
    const teamId = '13';
    const resp = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/schedule`);
    const data = await resp.json();
    const events = data?.events || [];
    const completed = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    const sample = completed.slice(-3).map(e => {
      const comp = e.competitions?.[0];
      const competitors = comp?.competitors?.map(c => ({
        id: c.team?.id, name: c.team?.displayName, score: c.score, homeAway: c.homeAway
      }));
      return { name: e.name, completed: comp?.status?.type?.completed, competitors };
    });
    res.json({ total: events.length, completed: completed.length, sample });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-transfermarkt', async (req, res) => {
  try {
    const url = 'https://www.transfermarkt.com/premier-league/verletztespieler/wettbewerb/GB1';
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://www.google.com/',
      }
    });
    const text = await resp.text();
    const hasTable = text.includes('table') && text.includes('items');
    res.json({ status: resp.status, length: text.length, hasTable, sample: text.slice(0, 500) });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-flash-search', async (req, res) => {
  try {
    const urls = [
      `https://s.flashscore.com/search/?q=Manchester+City&l=1&s=1&f=1%3B1&pid=2&sid=1`,
      `https://www.flashscore.com/search/?q=Manchester+City`,
    ];
    const results = {};
    for (const url of urls) {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Referer': 'https://www.flashscore.com/' }
      });
      const text = await r.text();
      results[url.slice(0, 50)] = { status: r.status, length: text.length, sample: text.slice(0, 200) };
    }
    res.json(results);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));
