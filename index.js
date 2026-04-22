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
  'Premier League': 'GB1', 'EPL': 'GB1', 'English Premier League': 'GB1',
  'La Liga': 'ES1', 'LaLiga': 'ES1', 'La Liga - Spain': 'ES1',
  'Bundesliga': 'L1', 'German Bundesliga': 'L1', 'Bundesliga - Germany': 'L1',
  'Bundesliga 2 - Germany': 'L2', '2. Bundesliga': 'L2',
  '3. Liga - Germany': 'L3',
  'Serie A': 'IT1', 'Italian Serie A': 'IT1',
  'Ligue 1': 'FR1', 'French Ligue 1': 'FR1', 'Ligue 1 - France': 'FR1',
  'Ligue 2': 'FR2', 'Ligue 2 - France': 'FR2',
  'Eredivisie': 'NL1', 'Dutch Eredivisie': 'NL1',
  'Primeira Liga': 'PO1', 'Portuguese Primeira Liga': 'PO1',
  'Super Lig': 'TR1', 'Turkish Super Lig': 'TR1',
  'Championship': 'GB2', 'EFL Championship': 'GB2',
  'League One': 'GB3', 'EFL League One': 'GB3', 'League 1': 'GB3',
  'League Two': 'GB4', 'EFL League Two': 'GB4', 'League 2': 'GB4',
  'Scottish Premiership': 'SC1',
  'Saudi Pro League': 'SA1',
  'MLS': 'MLS1',
  'Brazil Série A': 'BRA1', 'Brasileirao': 'BRA1', 'Brazilian Serie A': 'BRA1',
  'Brazil Série B': 'BRA2',
  'Liga MX': 'MEX1',
  'Argentine Primera División': 'AR1N',
  'FA Cup': 'GBFAC',
  'EFL Cup': 'GBLC',
  'Copa del Rey': 'ES_POC',
  'DFB-Pokal': 'DFB5',
  'Coppa Italia': 'IT_CUP',
  'Coupe de France': 'FR_CUP',
  'UEFA Champions League': 'CL', 'Champions League': 'CL',
  'UEFA Europa League': 'EL', 'Europa League': 'EL',
  'UEFA Conference League': 'UECL', 'Conference League': 'UECL',
  'Belgium First Div': 'BE1',
  'Ekstraklasa - Poland': 'PL1',
  'Denmark Superliga': 'DK1',
  'Eliteserien - Norway': 'NO1',
  'Allsvenskan - Sweden': 'SE1',
  'A-League': 'AUS1',
  'Copa Libertadores': 'CLI',
  'Copa Sudamericana': 'CSA',
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

  // Structure: rows with 8 cells = player row
  // cells[2]=name, cells[3]=position, cells[5]=injury, cells[7]=value
  // Team is stored in a data attribute on the row or nearby
  let currentTeam = null;
  $('table.items tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    const $row = $(row);

    // Try to get team from row data or link
    // Team is in td[4] as the title attribute of the link
    const teamTitle = cells.eq(4).find('a').first().attr('title');
    if (teamTitle && teamTitle.length > 1) {
      currentTeam = teamTitle;
    }

    if (cells.length < 7) return;

    const playerName = cells.eq(2).text().trim();
    const position = cells.eq(3).text().trim();
    const injuryType = cells.eq(5).text().trim();
    const returnDate = cells.eq(6).text().trim();
    const valueText = cells.eq(7).text().trim();

    if (!playerName || playerName.length < 2) return;

    let value = 0;
    const vm = valueText.replace(/[€$£]/g, '').trim();
    if (vm.includes('m')) value = parseFloat(vm) || 0;
    else if (vm.includes('k')) value = (parseFloat(vm) || 0) / 1000;

    // Use currentTeam or extract from row
    const team = currentTeam || 'Unknown';
    if (!injuries[team]) injuries[team] = [];
    injuries[team].push({ name: playerName, position, injury: injuryType, returnDate, value });
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

  const clean = (s) => s.toLowerCase().replace(/\b(fc|afc|cf|sc|ac)\b/g, '').replace(/\s+/g,' ').trim();
  const eN = clean(teamName);
  const teamKey = Object.keys(injuries).find(t => {
    const tN = clean(t);
    if (tN === eN) return true;
    if (tN.startsWith(eN + ' ') || tN.endsWith(' ' + eN)) return true;
    if (eN.startsWith(tN + ' ') || eN.endsWith(' ' + tN)) return true;
    return false;
  });
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

// Map competition name → ESPN soccer slug
const ESPN_SOCCER_SLUGS = {
  'EPL': 'eng.1', 'Premier League': 'eng.1', 'English Premier League': 'eng.1',
  'Championship': 'eng.2', 'League One': 'eng.3', 'League 1': 'eng.3',
  'League Two': 'eng.4', 'League 2': 'eng.4', 'FA Cup': 'eng.fa',
  'EFL Cup': 'eng.league_cup',
  'La Liga': 'esp.1', 'La Liga - Spain': 'esp.1',
  'Bundesliga': 'ger.1', 'Bundesliga - Germany': 'ger.1',
  'Bundesliga 2 - Germany': 'ger.2',
  'Serie A': 'ita.1', 'Italian Serie A': 'ita.1',
  'Ligue 1': 'fra.1', 'Ligue 1 - France': 'fra.1',
  'Ligue 2': 'fra.2', 'Ligue 2 - France': 'fra.2',
  'Dutch Eredivisie': 'ned.1', 'Eredivisie': 'ned.1',
  'Primeira Liga': 'por.1',
  'Super Lig': 'tur.1', 'Turkish Super Lig': 'tur.1',
  'Scottish Premiership': 'sco.1',
  'MLS': 'usa.1',
  'Liga MX': 'mex.1',
  'Brazil Série A': 'bra.1', 'Brasileirao': 'bra.1',
  'UEFA Champions League': 'uefa.champions', 'Champions League': 'uefa.champions',
  'UEFA Europa League': 'uefa.europa', 'Europa League': 'uefa.europa',
  'UEFA Conference League': 'uefa.europa.conf', 'Conference League': 'uefa.europa.conf',
  'Copa del Rey': 'esp.copa_del_rey',
  'DFB-Pokal': 'ger.dfb_pokal',
  'Coppa Italia': 'ita.coppa_italia',
  'Coupe de France': 'fra.coupe_de_france',
};

// Cache for ESPN soccer team IDs per league
const espnSoccerTeamCache = {};

async function findESPNSoccerTeam(teamName, slug) {
  if (!espnSoccerTeamCache[slug]) {
    const resp = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams?limit=100`);
    if (!resp?.ok) return null;
    const data = await resp.json();
    espnSoccerTeamCache[slug] = data?.sports?.[0]?.leagues?.[0]?.teams || [];
  }
  const teams = espnSoccerTeamCache[slug];
  const normalized = teamName.toLowerCase().replace(/\bfc\b|\bafc\b|\bsc\b/g, '').trim();
  const found = teams.find(t => {
    const dn = (t.team?.displayName || '').toLowerCase().replace(/\bfc\b|\bafc\b|\bsc\b/g, '').trim();
    return dn === normalized || dn.includes(normalized) || normalized.includes(dn);
  });
  return found?.team?.id || null;
}

async function getESPNSoccerForm(teamId, slug) {
  const resp = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${teamId}/schedule`);
  if (!resp?.ok) return null;
  const data = await resp.json();
  const events = data?.events || [];
  const completed = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
  if (!completed.length) return null;
  const last5 = completed.slice(-5);

  let form = '', scored = 0, conceded = 0;
  for (const event of last5) {
    const comp = event.competitions?.[0];
    const ourTeam = comp?.competitors?.find(c => c.team?.id === String(teamId));
    const oppTeam = comp?.competitors?.find(c => c.team?.id !== String(teamId));
    if (!ourTeam || !oppTeam) continue;
    const getScore = (s) => typeof s === 'object' ? (s?.value || 0) : (parseInt(s) || 0);
    const ourScore = getScore(ourTeam.score);
    const oppScore = getScore(oppTeam.score);
    scored += ourScore;
    conceded += oppScore;
    form += ourScore > oppScore ? 'W' : ourScore < oppScore ? 'L' : 'D';
  }
  return form ? `${form} (${scored} scored, ${conceded} conceded)` : null;
}

async function getESPNSoccerStandings(teamName, slug) {
  const resp = await safeFetch(`https://site.api.espn.com/apis/v2/sports/soccer/${slug}/standings`);
  if (!resp?.ok) return null;
  const data = await resp.json();

  // Navigate through standings structure
  const groups = data?.children?.[0]?.standings?.entries || data?.standings?.entries || [];
  const normalized = teamName.toLowerCase().replace(/\bfc\b|\bafc\b/g, '').trim();

  const entry = groups.find(e => {
    const tn = (e.team?.displayName || '').toLowerCase().replace(/\bfc\b|\bafc\b/g, '').trim();
    return tn === normalized || tn.includes(normalized) || normalized.includes(tn);
  });

  if (!entry) return null;

  // Extract stats
  const stats = {};
  (entry.stats || []).forEach(s => { stats[s.name] = s.value; });

  const pos = entry.note?.rank || stats.rank || null;
  const pts = stats.points || stats.pts || null;
  const played = stats.gamesPlayed || stats.played || null;
  const gd = stats.pointDifferential || stats.goalDifference || null;

  if (!pos) return null;
  return `${pos}e (${pts} pts, ${played} matchs joués, GD: ${gd > 0 ? '+' : ''}${gd})`;
}

async function getESPNSoccerH2H(homeId, awayId, slug) {
  // Get last matches of home team and filter for matches against away team
  const resp = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${homeId}/schedule`);
  if (!resp?.ok) return null;
  const data = await resp.json();
  const events = data?.events || [];

  const h2h = events.filter(e => {
    const comp = e.competitions?.[0];
    const hasAway = comp?.competitors?.some(c => c.team?.id === String(awayId));
    return hasAway && comp?.status?.type?.completed;
  }).slice(-5);

  if (!h2h.length) return null;

  return h2h.map(e => {
    const comp = e.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === 'home');
    const away = comp?.competitors?.find(c => c.homeAway === 'away');
    const getScore = (s) => typeof s === 'object' ? (s?.value || 0) : (parseInt(s) || 0);
    const hs = getScore(home?.score);
    const as = getScore(away?.score);
    const date = e.date ? new Date(e.date).toLocaleDateString('fr-FR') : '';
    return `${home?.team?.shortDisplayName || home?.team?.displayName} ${hs}-${as} ${away?.team?.shortDisplayName || away?.team?.displayName} (${date})`;
  }).join(' | ');
}

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
  // Try with seasontype=2 (regular season) first, then fallback
  const attempts = [
    `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule?season=2026&seasontype=2`,
    `https://site.web.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule?season=2026&seasontype=2`,
    `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams/${teamId}/schedule?season=2025`,
  ];

  let completed = [];
  for (const url of attempts) {
    const resp = await safeFetch(url);
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
    // Score can be object {value, displayValue} or string
    const getScore = (s) => typeof s === 'object' ? (s?.value || 0) : (parseInt(s) || 0);
    const ourScore = getScore(ourTeam.score);
    const oppScore = getScore(oppTeam.score);
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

  // Get ESPN soccer slug for this competition
  const espnSlug = ESPN_SOCCER_SLUGS[competition] || null;

  // Run all sources in parallel
  const [homeInj, awayInj] = await Promise.all([
    getFootballInjuries(home, competition),
    getFootballInjuries(away, competition),
  ]);

  // ESPN form + standings + H2H
  let homeForm = null, awayForm = null, h2h = null, homeStandings = null, awayStandings = null;
  if (espnSlug) {
    const [homeEspnId, awayEspnId] = await Promise.all([
      findESPNSoccerTeam(home, espnSlug),
      findESPNSoccerTeam(away, espnSlug),
    ]);

    if (homeEspnId && awayEspnId) {
      const [hForm, aForm, hStand, aStand, h2hData] = await Promise.all([
        getESPNSoccerForm(homeEspnId, espnSlug),
        getESPNSoccerForm(awayEspnId, espnSlug),
        getESPNSoccerStandings(home, espnSlug),
        getESPNSoccerStandings(away, espnSlug),
        getESPNSoccerH2H(homeEspnId, awayEspnId, espnSlug),
      ]);
      homeForm = hForm;
      awayForm = aForm;
      homeStandings = hStand;
      awayStandings = aStand;
      h2h = h2hData;
    }
  }

  // FlashScore news
  await delay(300);
  const [homeFlashId, awayFlashId] = await Promise.all([
    searchFlashscoreEntity(home),
    searchFlashscoreEntity(away),
  ]);

  let homeNews = null, awayNews = null;
  if (homeFlashId) { await delay(200); homeNews = await getFlashscoreNews(homeFlashId); }
  if (awayFlashId) { await delay(200); awayNews = await getFlashscoreNews(awayFlashId); }
  const news = [homeNews, awayNews].filter(Boolean).join(' | ') || null;

  const hasData = homeInj || awayInj || news || homeForm || h2h;
  if (!hasData) return null;

  // Build standings string for context
  const standingsContext = [
    homeStandings ? `${home}: ${homeStandings}` : null,
    awayStandings ? `${away}: ${awayStandings}` : null,
  ].filter(Boolean).join(' | ') || null;

  return {
    home_form: homeForm,
    away_form: awayForm,
    h2h: h2h,
    home_injuries: homeInj,
    away_injuries: awayInj,
    news: news,
    standings: standingsContext,
    context_source: 'transfermarkt+espn+flashscore',
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

const MAJOR_COMPETITIONS = [
  'Premier League','La Liga','Bundesliga','Serie A','Ligue 1',
  'UEFA Champions League','UEFA Europa League','UEFA Conference League',
  'FA Cup','EFL Cup','Championship','League One','League Two',
  'Eredivisie','Primeira Liga','Super Lig','Scottish Premiership',
  'Saudi Pro League','MLS','Liga MX','Brasileirao',
];
const MAJOR_SPORTS = ['basketball','hockey','baseball','american_football','mma'];
const BATCH_SIZE = 80;

app.post('/scrape', async (req, res) => {
  try {
    const { offset = 0 } = req.body || {};
    const now = new Date();
    const from = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Fetch large pool sorted by date
    const events = await sbFetch(
      `events?statut=eq.NS&context_source=is.null&date_evenement=gte.${from}&date_evenement=lte.${to}&select=id,equipe_domicile,equipe_exterieur,sport,competition&order=date_evenement.asc&limit=500`
    );

    if (!Array.isArray(events)) {
      return res.status(500).json({ error: 'Failed to fetch events', detail: events });
    }

    // Sort: major leagues first, then others (both sorted by date)
    const major = events.filter(e => MAJOR_COMPETITIONS.includes(e.competition) || MAJOR_SPORTS.includes(e.sport));
    const others = events.filter(e => !MAJOR_COMPETITIONS.includes(e.competition) && !MAJOR_SPORTS.includes(e.sport));
    const sorted = [...major, ...others];

    // Apply batch offset
    const toProcess = sorted.slice(offset, offset + BATCH_SIZE);

    if (toProcess.length === 0) {
      return res.json({ total: events.length, enriched: 0, skipped: 0, errors: 0, message: 'No more events to process' });
    }

    console.log(`Batch offset=${offset}: ${toProcess.length} events (pool: ${events.length}, major: ${major.length})`);
    let enriched = 0, errors = 0, skipped = 0;

    for (const e of toProcess) {
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

app.get('/debug-espn-nba-schedule', async (req, res) => {
  try {
    const results = {};
    const urls = [
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/schedule',
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/schedule?season=2025',
      'https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/schedule?season=2026&seasontype=2',
      'https://site.api.espn.com/apis/v2/sports/basketball/nba/standings',
    ];
    for (const url of urls) {
      const r = await safeFetch(url);
      const data = await r?.json();
      const events = data?.events || [];
      const completed = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
      results[url.slice(-40)] = { 
        total: events.length, 
        completed: completed.length,
        sample: completed.slice(-1).map(e => ({ name: e.name, competitors: e.competitions?.[0]?.competitors?.map(c => ({ name: c.team?.displayName, score: c.score })) }))
      };
    }
    res.json(results);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-injuries-fulham', async (req, res) => {
  try {
    delete injuryCache['GB1'];
    const injuries = await fetchTransfermarktInjuries('GB1');
    const clean = (s) => s.toLowerCase().replace(/\b(fc|afc|cf|sc|ac)\b/g, '').replace(/\s+/g,' ').trim();
    const eN = clean('Fulham');
    const teamKey = Object.keys(injuries).find(t => {
      const tN = clean(t);
      if (tN === eN) return true;
      if (tN.startsWith(eN + ' ') || tN.endsWith(' ' + eN)) return true;
      if (eN.startsWith(tN + ' ') || eN.endsWith(' ' + tN)) return true;
      return false;
    });
    if (!teamKey) return res.json({ error: 'Team not found', teams: Object.keys(injuries) });
    const teamInjuries = injuries[teamKey];
    // Show impact for each player
    const withImpact = teamInjuries.map(p => ({ ...p, impact: getInjuryImpact(p, teamInjuries) }));
    res.json({ teamKey, count: teamInjuries.length, players: withImpact });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-tm-match', async (req, res) => {
  try {
    delete injuryCache['GB1'];
    const injuries = await fetchTransfermarktInjuries('GB1');
    const teams = Object.keys(injuries);
    const normalize = (s) => s.toLowerCase()
      .replace(/\b(fc|afc|cf|sc|ac|bc|if|bk|sk|fk|united|city|town|rovers|wanderers|athletic|albion|county|hotspur|villa)\b/g, '')
      .replace(/[^a-z0-9]/g, '').trim();
    
    const testNames = ['Fulham', 'Brentford', 'Arsenal', 'Liverpool'];
    const results = {};
    for (const name of testNames) {
      const normName = normalize(name);
      const found = teams.find(t => {
        const normT = normalize(t);
        return normT === normName || normT.includes(normName) || normName.includes(normT);
      });
      results[name] = { normName, found, injuries: found ? injuries[found]?.length : 0 };
    }
    res.json(results);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-tm-all-teams', async (req, res) => {
  try {
    const injuries = await fetchTransfermarktInjuries('GB1');
    // Clear cache to force re-fetch
    delete injuryCache['GB1'];
    const injuries2 = await fetchTransfermarktInjuries('GB1');
    const teams = Object.keys(injuries2);
    res.json({ count: teams.length, teams });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-tm-fulham', async (req, res) => {
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
      const cells = $(row).find('td');
      const rowText = $(row).text();
      if (rowText.includes('Fulham') || rowText.includes('Tete') || rowText.includes('Kevin')) {
        rows.push({
          i,
          cellCount: cells.length,
          cells: cells.map((_, c) => $(c).text().trim().slice(0, 50)).get(),
          td4_title: cells.eq(4).find('a').first().attr('title'),
          links: $(row).find('a').map((_, a) => ({ title: $(a).attr('title'), href: $(a).attr('href')?.slice(0,40) })).get()
        });
      }
    });
    res.json({ found: rows.length, rows });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-tm-team', async (req, res) => {
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
    // Show first 5 rows with full HTML
    const rows = [];
    $('table.items tbody tr').each((i, row) => {
      if (i > 5) return;
      const cells = $(row).find('td');
      rows.push({
        i,
        cellCount: cells.length,
        td4_html: cells.eq(4).html()?.slice(0, 200),
        td4_text: cells.eq(4).text().trim().slice(0, 100),
        links: $(row).find('a').map((_, a) => ({ href: $(a).attr('href')?.slice(0, 50), title: $(a).attr('title'), text: $(a).text().trim().slice(0, 30) })).get()
      });
    });
    res.json({ rows });
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

app.get('/test-espn-soccer', async (req, res) => {
  try {
    const slug = 'eng.1';
    const [homeId, awayId] = await Promise.all([
      findESPNSoccerTeam('Brentford', slug),
      findESPNSoccerTeam('Fulham', slug),
    ]);
    const [homeForm, awayForm, homeStand, awayStand, h2h] = await Promise.all([
      getESPNSoccerForm(homeId, slug),
      getESPNSoccerForm(awayId, slug),
      getESPNSoccerStandings('Brentford', slug),
      getESPNSoccerStandings('Fulham', slug),
      getESPNSoccerH2H(homeId, awayId, slug),
    ]);
    res.json({ homeId, awayId, homeForm, awayForm, homeStand, awayStand, h2h });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/test-espn-soccer-search', async (req, res) => {
  try {
    const results = {};
    const leagues = [
      { key: 'epl', slug: 'eng.1' },
      { key: 'ligue1', slug: 'fra.1' },
      { key: 'laliga', slug: 'esp.1' },
      { key: 'bundesliga', slug: 'ger.1' },
      { key: 'seriea', slug: 'ita.1' },
      { key: 'ucl', slug: 'uefa.champions' },
    ];
    for (const { key, slug } of leagues) {
      const r = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams?limit=100`);
      const data = await r?.json();
      const teams = data?.sports?.[0]?.leagues?.[0]?.teams || [];
      const brentford = teams.find(t => t.team?.displayName?.toLowerCase().includes('brentford'));
      results[key] = { total: teams.length, brentford: brentford?.team?.id, sample: teams.slice(0,3).map(t => ({ id: t.team?.id, name: t.team?.displayName })) };
    }
    res.json(results);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/test-espn-football', async (req, res) => {
  try {
    const results = {};
    const endpoints = {
      // EPL standings
      epl_standings: 'https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings',
      // Brentford last matches
      brentford_form: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/396/schedule',
      // Search team
      brentford_info: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/396',
      // H2H / scoreboard
      epl_scores: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
    };
    for (const [key, url] of Object.entries(endpoints)) {
      const r = await safeFetch(url);
      const data = await r?.json();
      results[key] = { status: r?.status, keys: Object.keys(data||{}), sample: JSON.stringify(data).slice(0, 200) };
    }
    res.json(results);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/test-sofascore', async (req, res) => {
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.sofascore.com/',
    };
    const results = {};
    const endpoints = [
      // Search Brentford
      'https://api.sofascore.com/api/v1/search/multi/?q=Brentford&page=0',
      // Last matches Brentford (id=43')
      'https://api.sofascore.com/api/v1/team/43/events/last/0',
      // Standings EPL
      'https://api.sofascore.com/api/v1/unique-tournament/17/season/61627/standings/total',
    ];
    for (const url of endpoints) {
      const r = await fetch(url, { headers });
      const text = await r.text();
      results[url.split('/api/v1/')[1].slice(0,40)] = { 
        status: r.status, 
        length: text.length, 
        sample: text.slice(0, 300) 
      };
    }
    res.json(results);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-flash-upcoming', async (req, res) => {
  try {
    // Try to get upcoming matches for Brentford via their page
    const urls = [
      'https://www.flashscore.com/team/brentford/xYe7DwID/fixtures/',
      'https://16.flashscore.ninja/16/x/feed/d_sr_2_xYe7DwID',
      'https://16.flashscore.ninja/16/x/feed/d_su_2_xYe7DwID',
    ];
    const results = {};
    for (const url of urls) {
      const r = await fetch(url, { headers: { ...flashHeaders, 'Accept': 'text/html,*/*' } });
      const text = await r.text();
      // Look for match IDs (8 char alphanumeric)
      const matchIds = text.match(/mid=([A-Za-z0-9]{8})/g) || [];
      const feedIds = text.match(/~([A-Za-z0-9]{8})~/g)?.slice(0,5) || [];
      results[url.split('/').pop()] = { status: r.status, length: text.length, matchIds: matchIds.slice(0,5), feedIds, sample: text.slice(0, 300) };
    }
    res.json(results);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug-flash-match-id', async (req, res) => {
  try {
    // Brentford team ID from search
    const teamId = 'xYe7DwID';
    const results = {};
    const endpoints = [
      `https://16.flashscore.ninja/16/x/feed/tr_1_${teamId}_1_en_1`,
      `https://16.flashscore.ninja/16/x/feed/tr_1_${teamId}_2_en_1`,
      `https://16.flashscore.ninja/16/x/feed/tf_1_${teamId}_1_en_1`,
    ];
    for (const url of endpoints) {
      const r = await fetch(url, { headers: flashHeaders });
      const text = await r.text();
      results[url.split('feed/')[1]] = { status: r.status, length: text.length, sample: text.slice(0, 400) };
    }
    res.json(results);
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
