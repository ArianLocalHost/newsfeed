/**
 * =============================================
 * חדשות עכשיו — Hebrew News Feed
 * =============================================
 *
 * CORS NOTE:
 * Browsers block cross-origin RSS fetches from static pages.
 * We try two strategies in order:
 *   1. Direct fetch (works if the server sends CORS headers — often fails)
 *   2. Proxy via rss2json.com (free, no key needed for public feeds)
 *
 * To swap proxy: change PROXY_URL below to any RSS-to-JSON proxy you prefer.
 * Popular alternatives:
 *   - https://api.rss2json.com/v1/api.json?rss_url=
 *   - https://api.allorigins.win/get?url=   (returns raw XML you must parse)
 *   - Your own Cloudflare Worker / Netlify function
 */

// =============================================
// ⚙️  CONFIG — edit these values
// =============================================
const CONFIG = {
  INITIAL_POSTS: 20,           // how many cards to show on first render
  POLL_INTERVAL_MS: 30_000,    // how often to refetch (ms) — 30 s
  TIME_WINDOW_MS: 10 * 60_000, // only show items from last N ms — 10 min
  PROXY_URL: 'https://api.rss2json.com/v1/api.json?rss_url=',

  FEEDS: [
    { url: 'https://storage.googleapis.com/mako-sitemaps/rssHomepage.xml', name: 'mako' },
    { url: 'https://www.ynet.co.il/Integration/StoryRss1854.xml',          name: 'ynet' },
    { url: 'https://rss.walla.co.il/feed/22',                              name: 'walla' },
  ],
};

// =============================================
// STATE
// =============================================
let allItems   = [];   // all fetched & filtered items (sorted newest first)
let shownCount = 0;    // how many cards are currently rendered
let pendingNew = [];   // new items waiting for user to acknowledge

// =============================================
// DOM REFS
// =============================================
const feedEl       = document.getElementById('feed');
const loadMoreBtn  = document.getElementById('load-more-btn');
const newItemsBar  = document.getElementById('new-items-bar');
const lastUpdEl    = document.getElementById('last-updated');

// =============================================
// FETCH + PARSE
// =============================================

/**
 * Fetch a single RSS feed, trying direct first, then proxy.
 * Returns an array of normalised item objects.
 */
async function fetchFeed(feed) {
  // Strategy 1: try direct (works for feeds with permissive CORS)
  try {
    const res = await fetch(feed.url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const text = await res.text();
      return parseRssXml(text, feed.name);
    }
  } catch (_) { /* CORS or network error — fall through */ }

  // Strategy 2: proxy via rss2json
  try {
    const proxyUrl = CONFIG.PROXY_URL + encodeURIComponent(feed.url);
    const res = await fetch(proxyUrl, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      // rss2json returns { items: [...] }
      if (json.items) {
        return parseRss2JsonItems(json.items, feed.name);
      }
    }
  } catch (e) {
    console.warn(`[feed] Failed to load ${feed.name}:`, e.message);
  }

  return [];
}

/** Parse raw RSS/Atom XML string into normalised items */
function parseRssXml(xmlText, sourceName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const items = [...doc.querySelectorAll('item, entry')];

  return items.map(item => normaliseXmlItem(item, sourceName)).filter(Boolean);
}

/** Extract a normalised item from an XML <item> / <entry> element */
function normaliseXmlItem(item, sourceName) {
  const get = (tag) => item.querySelector(tag)?.textContent?.trim() || '';

  const title = get('title');
  const link  = get('link') || item.querySelector('link')?.getAttribute('href') || '';
  const pubDateStr = get('pubDate') || get('published') || get('updated') || '';
  const publishedAt = pubDateStr ? new Date(pubDateStr) : null;

  if (!title || !link || !publishedAt || isNaN(publishedAt)) return null;

  // Description / summary
  let description = get('description') || get('summary') || get('content');
  description = stripHtml(description).slice(0, 200);

  // Media: try several common patterns
  const media = extractMediaFromXml(item, description);

  return { id: link, title, link, publishedAt, sourceName, description, media };
}

/** Try to extract an image URL from various RSS media fields */
function extractMediaFromXml(item, descriptionText) {
  // <media:content url="...">
  const mediaContent = item.querySelector('content');
  if (mediaContent?.getAttribute('url')) return mediaContent.getAttribute('url');

  // <enclosure url="..." type="image/...">
  const enclosure = item.querySelector('enclosure');
  if (enclosure && /image/.test(enclosure.getAttribute('type') || '')) {
    return enclosure.getAttribute('url');
  }

  // <media:thumbnail url="...">
  const thumb = item.querySelector('thumbnail');
  if (thumb?.getAttribute('url')) return thumb.getAttribute('url');

  // First <img> in description HTML
  const rawDesc = item.querySelector('description')?.textContent || '';
  const imgMatch = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return null;
}

/** Parse items from rss2json proxy response */
function parseRss2JsonItems(items, sourceName) {
  return items.map(item => {
    const title = item.title?.trim();
    const link  = item.link?.trim();
    const publishedAt = item.pubDate ? new Date(item.pubDate) : null;
    if (!title || !link || !publishedAt || isNaN(publishedAt)) return null;

    const description = stripHtml(item.description || item.content || '').slice(0, 200);
    const media = item.enclosure?.link ||
                  item['media:content']?.['@attributes']?.url ||
                  item.thumbnail ||
                  extractImgFromHtml(item.description || '') ||
                  null;

    return { id: link, title, link, publishedAt, sourceName, description, media };
  }).filter(Boolean);
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

/** Format a Date as "לפני X דקות" or absolute time */
function relativeTime(date) {
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1)   return 'עכשיו';
  if (diffMin < 60)  return `לפני ${diffMin} דק׳`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)    return `לפני ${diffH} שע׳`;

  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const d = date.getDate();
  const mo = date.getMonth() + 1;
  return `${d}/${mo} ${h}:${m}`;
}

function absoluteTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// =============================================
// RENDER
// =============================================

/** Build a single card DOM element */
function buildCard(item, isNew = false) {
  const a = document.createElement('a');
  a.className = 'card' + (isNew ? ' is-new' : '');
  a.href = item.link;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', item.title);

  // Thumbnail
  if (item.media && /\.(jpg|jpeg|png|webp|gif)/i.test(item.media)) {
    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src = item.media;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.remove(); // hide broken images
    a.appendChild(img);
  }

  // Body
  const body = document.createElement('div');
  body.className = 'card-body';

  // Meta
  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const badge = document.createElement('span');
  badge.className = `source-badge source-${item.sourceName}`;
  badge.textContent = item.sourceName;

  const time = document.createElement('time');
  time.className = 'card-time';
  time.dateTime = item.publishedAt.toISOString();
  time.textContent = `${relativeTime(item.publishedAt)} · ${absoluteTime(item.publishedAt)}`;
  time.title = item.publishedAt.toLocaleString('he-IL');

  meta.appendChild(badge);
  meta.appendChild(time);

  // Title
  const titleEl = document.createElement('h2');
  titleEl.className = 'card-title';
  titleEl.textContent = item.title;

  body.appendChild(meta);
  body.appendChild(titleEl);

  // Summary
  if (item.description) {
    const summary = document.createElement('p');
    summary.className = 'card-summary';
    summary.textContent = item.description;
    body.appendChild(summary);
  }

  a.appendChild(body);
  return a;
}

/** Render the next batch of cards after `from` index */
function renderCards(from, count) {
  const slice = allItems.slice(from, from + count);
  const frag  = document.createDocumentFragment();
  slice.forEach(item => frag.appendChild(buildCard(item)));
  feedEl.appendChild(frag);
  shownCount = from + slice.length;
  loadMoreBtn.classList.toggle('hidden', shownCount >= allItems.length);
}

/** Initial render: clear feed, show spinner, render first batch */
function renderInitial() {
  feedEl.innerHTML = '';
  shownCount = 0;

  if (allItems.length === 0) {
    feedEl.innerHTML = '<div class="feed-status"><div class="spinner"></div><br>טוען חדשות...</div>';
    loadMoreBtn.classList.add('hidden');
    return;
  }

  renderCards(0, CONFIG.INITIAL_POSTS);
}

// =============================================
// CORE LOGIC
// =============================================

/** Fetch all feeds, filter to time window, sort, merge with existing */
async function loadFeeds(isFirstLoad = false) {
  if (isFirstLoad) {
    // Show spinner on very first load
    feedEl.innerHTML = '<div class="feed-status"><div class="spinner"></div><br>טוען חדשות...</div>';
  }

  const now = Date.now();
  const cutoff = now - CONFIG.TIME_WINDOW_MS;

  // Fetch all in parallel
  const results = await Promise.all(CONFIG.FEEDS.map(fetchFeed));
  const fresh = results.flat()
    .filter(item => item.publishedAt.getTime() >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  // Deduplicate by id
  const existingIds = new Set(allItems.map(i => i.id));

  if (isFirstLoad) {
    allItems = fresh;
    renderInitial();
  } else {
    // Find genuinely new items
    const newItems = fresh.filter(item => !existingIds.has(item.id));

    if (newItems.length > 0) {
      pendingNew = newItems;
      showNewItemsBar(newItems.length);
    }

    // Also merge any fresh items that may have been missed (shouldn't matter much)
    // We'll apply pendingNew to allItems when user clicks the bar or auto-flush
  }

  // Update timestamp
  const now2 = new Date();
  lastUpdEl.textContent = `עודכן ${absoluteTime(now2)}`;
}

/** Show the "N new items" bar */
function showNewItemsBar(count) {
  newItemsBar.textContent = `נמצאו ${count} פריטים חדשים — לחץ לרענון`;
  newItemsBar.classList.remove('hidden');
}

/** Apply pending new items to the top of the feed */
function applyPendingNew() {
  if (pendingNew.length === 0) return;

  const existingIds = new Set(allItems.map(i => i.id));
  const toAdd = pendingNew.filter(item => !existingIds.has(item.id));

  allItems = [...toAdd, ...allItems].sort((a, b) => b.publishedAt - a.publishedAt);
  pendingNew = [];
  newItemsBar.classList.add('hidden');

  // Prepend new cards to the top
  const frag = document.createDocumentFragment();
  toAdd.forEach(item => frag.appendChild(buildCard(item, true)));
  feedEl.prepend(frag);
  shownCount += toAdd.length;

  // Remove "is-new" highlight after 10 s
  setTimeout(() => {
    document.querySelectorAll('.card.is-new').forEach(c => c.classList.remove('is-new'));
  }, 10_000);
}

// =============================================
// RELATIVE TIME TICKER
// Update time labels every minute
// =============================================
function refreshTimestamps() {
  document.querySelectorAll('.card-time').forEach(el => {
    const dt = new Date(el.dateTime);
    el.textContent = `${relativeTime(dt)} · ${absoluteTime(dt)}`;
  });
}

// =============================================
// INIT
// =============================================
(async function init() {
  // First load
  await loadFeeds(true);

  // Poll
  setInterval(() => loadFeeds(false), CONFIG.POLL_INTERVAL_MS);

  // Refresh relative timestamps every 60 s
  setInterval(refreshTimestamps, 60_000);

  // Load more
  loadMoreBtn.addEventListener('click', () => {
    renderCards(shownCount, CONFIG.INITIAL_POSTS);
  });

  // Apply new items when bar is clicked
  newItemsBar.addEventListener('click', () => {
    applyPendingNew();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
