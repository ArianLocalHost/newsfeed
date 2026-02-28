/**
 * =============================================
 * פיד החדשות של אריאן — app.js
 * =============================================
 *
 * CORS NOTE:
 * Browsers block cross-origin RSS fetches from static pages.
 * Two strategies are tried in order:
 *   1. Direct fetch (works only if the server sends CORS headers — usually fails)
 *   2. Proxy via rss2json.com (free, no API key required for public feeds)
 *
 * To swap proxy: change PROXY_URL below.
 * Alternatives:
 *   - https://api.rss2json.com/v1/api.json?rss_url=   (current)
 *   - https://api.allorigins.win/get?url=              (returns raw XML)
 *   - Your own Cloudflare Worker / Netlify function
 *
 * TIME NOTE:
 * All dates are parsed as-is from the feed. RSS pubDate strings are typically
 * in RFC 2822 format which includes a timezone offset (e.g. "+0200" for Israel).
 * We always display using local browser time via date.toLocaleTimeString().
 * Do NOT manually add/subtract hours — the JS Date object handles TZ conversion.
 */

// =============================================
// CONFIG
// =============================================
const CONFIG = {
  INITIAL_POSTS:    20,
  POLL_INTERVAL_MS: 30_000,        // 30 seconds
  TIME_WINDOW_MS:   10 * 60_000,   // 10 minutes
  PROXY_URL: 'https://api.rss2json.com/v1/api.json?rss_url=',

  FEEDS: [
    { url: 'https://storage.googleapis.com/mako-sitemaps/rssHomepage.xml', name: 'mako',  label: 'מאקו' },
    { url: 'https://www.ynet.co.il/Integration/StoryRss1854.xml',          name: 'ynet',  label: 'ynet' },
    { url: 'https://rss.walla.co.il/feed/22',                              name: 'walla', label: 'וואלה' },
  ],
};

// =============================================
// STATE
// =============================================
let allItems    = [];  // all fetched items, sorted newest-first
let activeTab   = 'all';
let shownCount  = 0;   // cards currently in the DOM for the active tab
let pendingNew  = [];  // newly fetched items awaiting user acknowledgement

// =============================================
// DOM REFS
// =============================================
const feedEl      = document.getElementById('feed');
const loadMoreBtn = document.getElementById('load-more-btn');
const newItemsBar = document.getElementById('new-items-bar');
const lastUpdEl   = document.getElementById('last-updated');
const tabs        = document.querySelectorAll('.tab');

// =============================================
// FETCH
// =============================================

async function fetchFeed(feed) {
  // Strategy 1: direct fetch
  try {
    const res = await fetch(feed.url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const text = await res.text();
      return parseRssXml(text, feed.name);
    }
  } catch (_) { /* CORS / network — fall through */ }

  // Strategy 2: rss2json proxy
  try {
    const proxyUrl = CONFIG.PROXY_URL + encodeURIComponent(feed.url);
    const res = await fetch(proxyUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.items) return parseRss2JsonItems(json.items, feed.name);
    }
  } catch (e) {
    console.warn(`[feed] ${feed.name} failed:`, e.message);
  }

  return [];
}

// =============================================
// PARSE — XML path
// =============================================

function parseRssXml(xmlText, sourceName) {
  const doc   = new DOMParser().parseFromString(xmlText, 'text/xml');
  const items = [...doc.querySelectorAll('item, entry')];
  return items.map(el => normaliseXmlItem(el, sourceName)).filter(Boolean);
}

function normaliseXmlItem(item, sourceName) {
  const get = tag => item.querySelector(tag)?.textContent?.trim() || '';

  const title = get('title');
  const link  = get('link') || item.querySelector('link')?.getAttribute('href') || '';

  // Parse date — RSS uses RFC 2822 with embedded TZ offset; JS Date handles it correctly.
  const pubStr      = get('pubDate') || get('published') || get('updated') || '';
  const publishedAt = pubStr ? new Date(pubStr) : null;
  if (!title || !link || !publishedAt || isNaN(publishedAt)) return null;

  const description = stripHtml(get('description') || get('summary') || get('content')).slice(0, 220);
  const media       = extractMediaXml(item);

  return { id: link, title, link, publishedAt, sourceName, description, media };
}

function extractMediaXml(item) {
  const mc = item.querySelector('content');
  if (mc?.getAttribute('url')) return mc.getAttribute('url');

  const enc = item.querySelector('enclosure');
  if (enc && /image/i.test(enc.getAttribute('type') || '')) return enc.getAttribute('url');

  const th = item.querySelector('thumbnail');
  if (th?.getAttribute('url')) return th.getAttribute('url');

  const rawDesc = item.querySelector('description')?.textContent || '';
  const m = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return m[1];

  return null;
}

// =============================================
// PARSE — rss2json proxy path
// =============================================

function parseRss2JsonItems(items, sourceName) {
  return items.map(item => {
    const title       = item.title?.trim();
    const link        = item.link?.trim();
    // rss2json returns pubDate in "YYYY-MM-DD HH:MM:SS" UTC — parse carefully
    const publishedAt = item.pubDate ? parsePubDate(item.pubDate) : null;
    if (!title || !link || !publishedAt || isNaN(publishedAt)) return null;

    const description = stripHtml(item.description || item.content || '').slice(0, 220);
    const media = item.enclosure?.link
               || item.thumbnail
               || extractImgFromHtml(item.description || '')
               || null;

    return { id: link, title, link, publishedAt, sourceName, description, media };
  }).filter(Boolean);
}

/**
 * rss2json returns dates as "2024-06-10 14:30:00" which JS treats as LOCAL time.
 * But the original feed times are typically in Israel time (UTC+2/UTC+3).
 * rss2json converts to UTC before returning. We append "Z" to treat as UTC.
 */
function parsePubDate(str) {
  // If the string already has a timezone indicator, trust it
  if (/[Z+\-]\d{2}:?\d{2}$/.test(str)) return new Date(str);
  // Otherwise rss2json gives us UTC — append Z
  return new Date(str.replace(' ', 'T') + 'Z');
}

// =============================================
// HELPERS
// =============================================

function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || '';
}

function extractImgFromHtml(html) {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/**
 * Format time for display.
 * Uses the browser's local timezone — no manual offset arithmetic.
 */
function formatAbsoluteTime(date) {
  // e.g. "14:32" in local time
  return date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatRelativeTime(date) {
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1)  return 'עכשיו';
  if (diffMin < 60) return `לפני ${diffMin} דק׳`;

  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `לפני ${diffH} שע׳`;

  // Older than a day: show date + time
  return date.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })
    + ' ' + formatAbsoluteTime(date);
}

function formatTimeLabel(date) {
  return `${formatRelativeTime(date)} · ${formatAbsoluteTime(date)}`;
}

// =============================================
// TABS
// =============================================

function getActiveItems() {
  if (activeTab === 'all') return allItems;
  return allItems.filter(i => i.sourceName === activeTab);
}

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    activeTab = tab.dataset.source;
    renderFull();
  });
});

// =============================================
// RENDER
// =============================================

function buildCard(item, isNew = false) {
  const a = document.createElement('a');
  a.className = 'card' + (isNew ? ' is-new' : '');
  a.href      = item.link;
  a.target    = '_blank';
  a.rel       = 'noopener noreferrer';

  // Thumbnail (only for image URLs)
  if (item.media && /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(item.media)) {
    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src       = item.media;
    img.alt       = '';
    img.loading   = 'lazy';
    img.onerror   = () => img.remove();
    a.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  // Meta row
  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const badge = document.createElement('span');
  badge.className = `source-badge source-${item.sourceName}`;
  badge.textContent = CONFIG.FEEDS.find(f => f.name === item.sourceName)?.label || item.sourceName;

  const timeEl = document.createElement('time');
  timeEl.className = 'card-time';
  timeEl.dateTime  = item.publishedAt.toISOString();
  timeEl.textContent = formatTimeLabel(item.publishedAt);
  timeEl.title = item.publishedAt.toLocaleString('he-IL');

  meta.appendChild(badge);
  meta.appendChild(timeEl);

  // Title
  const titleEl = document.createElement('h2');
  titleEl.className = 'card-title';
  titleEl.textContent = item.title;

  body.appendChild(meta);
  body.appendChild(titleEl);

  // Summary
  if (item.description) {
    const sum = document.createElement('p');
    sum.className = 'card-summary';
    sum.textContent = item.description;
    body.appendChild(sum);
  }

  a.appendChild(body);
  return a;
}

/** Full re-render of the feed for the active tab */
function renderFull() {
  feedEl.innerHTML = '';
  shownCount = 0;

  const items = getActiveItems();

  if (items.length === 0) {
    feedEl.innerHTML = '<div class="feed-status">אין פריטים להצגה</div>';
    loadMoreBtn.classList.add('hidden');
    return;
  }

  appendCards(items, 0, CONFIG.INITIAL_POSTS);
}

/** Append a slice of cards to the feed */
function appendCards(items, from, count) {
  const slice = items.slice(from, from + count);
  const frag  = document.createDocumentFragment();
  slice.forEach(item => frag.appendChild(buildCard(item)));
  feedEl.appendChild(frag);
  shownCount = from + slice.length;
  loadMoreBtn.classList.toggle('hidden', shownCount >= items.length);
}

/** Show loading spinner in the feed area */
function showSpinner() {
  feedEl.innerHTML = '<div class="feed-status"><div class="spinner"></div><br>טוען חדשות...</div>';
  loadMoreBtn.classList.add('hidden');
}

// =============================================
// POLLING LOGIC
// =============================================

async function loadFeeds(isFirstLoad = false) {
  if (isFirstLoad) showSpinner();

  const cutoff = Date.now() - CONFIG.TIME_WINDOW_MS;

  const results = await Promise.all(CONFIG.FEEDS.map(fetchFeed));
  const fresh   = results.flat()
    .filter(item => item.publishedAt.getTime() >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  if (isFirstLoad) {
    allItems = dedup(fresh);
    renderFull();
  } else {
    const existingIds = new Set(allItems.map(i => i.id));
    const newItems    = fresh.filter(i => !existingIds.has(i.id));

    if (newItems.length > 0) {
      pendingNew = newItems;
      newItemsBar.textContent = `נמצאו ${newItems.length} פריטים חדשים — לחץ לרענון`;
      newItemsBar.classList.remove('hidden');
    }
  }

  lastUpdEl.textContent = `עודכן ${formatAbsoluteTime(new Date())}`;
}

function applyPendingNew() {
  if (!pendingNew.length) return;

  const existingIds = new Set(allItems.map(i => i.id));
  const toAdd       = pendingNew.filter(i => !existingIds.has(i.id));
  pendingNew = [];

  allItems = dedup([...toAdd, ...allItems]).sort((a, b) => b.publishedAt - a.publishedAt);

  newItemsBar.classList.add('hidden');

  // Prepend new cards relevant to the active tab
  const relevant = toAdd.filter(i => activeTab === 'all' || i.sourceName === activeTab);
  if (relevant.length) {
    const frag = document.createDocumentFragment();
    relevant.forEach(item => frag.appendChild(buildCard(item, true)));
    feedEl.prepend(frag);
    shownCount += relevant.length;
    // Remove highlight after 12 s
    setTimeout(() => {
      feedEl.querySelectorAll('.card.is-new').forEach(c => c.classList.remove('is-new'));
    }, 12_000);
  }

  loadMoreBtn.classList.toggle('hidden', shownCount >= getActiveItems().length);
}

function dedup(items) {
  const seen = new Set();
  return items.filter(i => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
}

// =============================================
// TIMESTAMP REFRESH (every 60 s)
// =============================================

function refreshTimestamps() {
  feedEl.querySelectorAll('time.card-time').forEach(el => {
    const date = new Date(el.dateTime);
    el.textContent = formatTimeLabel(date);
  });
}

// =============================================
// INIT
// =============================================
(async function init() {
  await loadFeeds(true);

  setInterval(() => loadFeeds(false), CONFIG.POLL_INTERVAL_MS);
  setInterval(refreshTimestamps, 60_000);

  loadMoreBtn.addEventListener('click', () => {
    const items = getActiveItems();
    appendCards(items, shownCount, CONFIG.INITIAL_POSTS);
  });

  newItemsBar.addEventListener('click', () => {
    applyPendingNew();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
