/**
 * =============================================
 * פיד החדשות של אריאן — app.js
 * =============================================
 *
 * CORS: Two proxy strategies are tried per feed.
 *   1. rss2json.com  — returns JSON, handles most feeds
 *   2. allorigins.win — returns raw XML (we parse it), good fallback
 *
 * TIME FIX:
 *   rss2json returns pubDate as "YYYY-MM-DD HH:MM:SS" in the feed's LOCAL
 *   timezone (Israel, UTC+2/+3). Do NOT append "Z" — treat as local time.
 *   JS new Date("2024-06-10 16:00:00") → parsed as local → displays correctly.
 *
 * ENCODING FIX:
 *   ynet RSS is Windows-1255. When fetching raw XML, we use TextDecoder with
 *   'windows-1255' to get proper Hebrew text.
 */

// =============================================
// CONFIG
// =============================================
const CONFIG = {
  INITIAL_POSTS:    20,
  POLL_INTERVAL_MS: 30_000,
  TIME_WINDOW_MS:   10 * 60_000,   // 10 minutes

  // Primary proxy: rss2json (JSON response)
  PROXY_RSS2JSON: 'https://api.rss2json.com/v1/api.json?rss_url=',
  // Fallback proxy: allorigins (returns raw XML inside JSON)
  PROXY_ALLORIGINS: 'https://api.allorigins.win/get?url=',

  FEEDS: [
    {
      url:      'https://storage.googleapis.com/mako-sitemaps/rssHomepage.xml',
      name:     'mako',
      label:    'מאקו',
      encoding: 'utf-8',
    },
    {
      url:      'https://www.ynet.co.il/Integration/StoryRss1854.xml',
      name:     'ynet',
      label:    'ynet',
      encoding: 'windows-1255',   // ynet publishes in Windows-1255
    },
    {
      url:      'https://rss.walla.co.il/feed/22',
      name:     'walla',
      label:    'וואלה',
      encoding: 'utf-8',
    },
  ],
};

// =============================================
// STATE
// =============================================
let allItems   = [];
let activeTab  = 'all';
let shownCount = 0;
let pendingNew = [];

// =============================================
// DOM REFS
// =============================================
const feedEl      = document.getElementById('feed');
const loadMoreBtn = document.getElementById('load-more-btn');
const newItemsBar = document.getElementById('new-items-bar');
const lastUpdEl   = document.getElementById('last-updated');
const tabs        = document.querySelectorAll('.tab');

// =============================================
// FETCH — three strategies per feed
// =============================================

async function fetchFeed(feed) {

  // ── Strategy 1: direct fetch with correct encoding ──
  try {
    const res = await fetch(feed.url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      // Read as ArrayBuffer so we can decode with the correct charset
      const buf  = await res.arrayBuffer();
      const text = new TextDecoder(feed.encoding || 'utf-8').decode(buf);
      const items = parseRssXml(text, feed.name);
      if (items.length > 0) return items;
    }
  } catch (_) { /* CORS or network — try proxy */ }

  // ── Strategy 2: rss2json proxy ──
  try {
    const url = CONFIG.PROXY_RSS2JSON + encodeURIComponent(feed.url);
    const res  = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      if (json.status === 'ok' && json.items?.length) {
        return parseRss2JsonItems(json.items, feed.name);
      }
    }
  } catch (_) { /* try next */ }

  // ── Strategy 3: allorigins proxy (returns raw XML) ──
  try {
    const url = CONFIG.PROXY_ALLORIGINS + encodeURIComponent(feed.url);
    const res  = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const json = await res.json();
      if (json.contents) {
        return parseRssXml(json.contents, feed.name);
      }
    }
  } catch (e) {
    console.warn(`[feed] ${feed.name} all strategies failed:`, e.message);
  }

  return [];
}

// =============================================
// PARSE — raw XML
// =============================================

function parseRssXml(xmlText, sourceName) {
  // allorigins sometimes escapes the XML — unescape if needed
  const cleaned = xmlText.startsWith('&lt;') ? unescapeHtml(xmlText) : xmlText;
  const doc   = new DOMParser().parseFromString(cleaned, 'text/xml');
  const items = [...doc.querySelectorAll('item, entry')];
  return items.map(el => normaliseXmlItem(el, sourceName)).filter(Boolean);
}

function normaliseXmlItem(item, sourceName) {
  const get = tag => item.querySelector(tag)?.textContent?.trim() || '';

  const title = get('title');
  const link  = get('link') || item.querySelector('link')?.getAttribute('href') || '';

  const pubStr      = get('pubDate') || get('published') || get('updated') || '';
  const publishedAt = parseFeedDate(pubStr);
  if (!title || !link || !publishedAt) return null;

  const description = stripHtml(
    get('description') || get('summary') || get('content')
  ).slice(0, 220);

  const media = extractMediaXml(item);

  return { id: link, title, link, publishedAt, sourceName, description, media };
}

function extractMediaXml(item) {
  // <media:content url="...">
  const mc = item.querySelector('content');
  if (mc?.getAttribute('url')) return mc.getAttribute('url');

  // <enclosure url="..." type="image/...">
  const enc = item.querySelector('enclosure');
  if (enc && /image/i.test(enc.getAttribute('type') || '')) return enc.getAttribute('url');

  // <media:thumbnail url="...">
  const th = item.querySelector('thumbnail');
  if (th?.getAttribute('url')) return th.getAttribute('url');

  // <img> inside description CDATA
  const rawDesc = item.querySelector('description')?.textContent || '';
  const m = rawDesc.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return m[1];

  return null;
}

// =============================================
// PARSE — rss2json JSON items
// =============================================

function parseRss2JsonItems(items, sourceName) {
  return items.map(item => {
    const title       = item.title?.trim();
    const link        = item.link?.trim();
    const publishedAt = item.pubDate ? parseFeedDate(item.pubDate) : null;
    if (!title || !link || !publishedAt) return null;

    const description = stripHtml(item.description || item.content || '').slice(0, 220);
    const media = item.enclosure?.link
               || item.thumbnail
               || extractImgFromHtml(item.description || '')
               || null;

    return { id: link, title, link, publishedAt, sourceName, description, media };
  }).filter(Boolean);
}

// =============================================
// DATE PARSING — the critical fix
// =============================================

/**
 * Parse a feed date string into a JS Date, displaying the correct local time.
 *
 * RSS feeds from Israel send dates in one of these formats:
 *   A) RFC 2822 with explicit offset:  "Mon, 10 Jun 2024 16:00:00 +0300"
 *      → JS Date() parses this perfectly → getHours() gives local time ✓
 *
 *   B) rss2json proxy output:          "2024-06-10 16:00:00"
 *      → This is already the feed's local time (Israel), NOT UTC.
 *      → Do NOT add "Z". Parse as-is so JS treats it as local time.
 *      → On an Israeli browser: displays 16:00 ✓
 *
 *   C) ISO with Z:                     "2024-06-10T13:00:00Z"
 *      → JS parses as UTC → browser converts to local → correct ✓
 */
function parseFeedDate(str) {
  if (!str) return null;

  // Format B: "YYYY-MM-DD HH:MM:SS" — no timezone info.
  // rss2json passes through the feed's local time unchanged.
  // Treat as local time (no Z suffix).
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str.trim())) {
    const d = new Date(str.trim().replace(' ', 'T'));
    return isNaN(d) ? null : d;
  }

  // All other formats (RFC 2822, ISO with Z, etc.) — let JS handle it
  const d = new Date(str);
  return isNaN(d) ? null : d;
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
  const m = (html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function unescapeHtml(str) {
  const d = document.createElement('div');
  d.innerHTML = str;
  return d.textContent;
}

// =============================================
// TIME FORMATTING
// =============================================

function formatAbsoluteTime(date) {
  // Use browser locale + local timezone — always correct
  return date.toLocaleTimeString('he-IL', {
    hour:   '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatRelativeTime(date) {
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1)  return 'עכשיו';
  if (diffMin < 60) return `לפני ${diffMin} דק׳`;

  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `לפני ${diffH} שע׳`;

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
    tabs.forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
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

  // Thumbnail
  if (item.media && /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(item.media)) {
    const img     = document.createElement('img');
    img.className = 'card-thumb';
    img.src       = item.media;
    img.alt       = '';
    img.loading   = 'lazy';
    img.onerror   = () => img.remove();
    a.appendChild(img);
  }

  const body     = document.createElement('div');
  body.className = 'card-body';

  const meta     = document.createElement('div');
  meta.className = 'card-meta';

  const badge       = document.createElement('span');
  badge.className   = `source-badge source-${item.sourceName}`;
  badge.textContent = CONFIG.FEEDS.find(f => f.name === item.sourceName)?.label || item.sourceName;

  const timeEl         = document.createElement('time');
  timeEl.className     = 'card-time';
  timeEl.dateTime      = item.publishedAt.toISOString();
  timeEl.textContent   = formatTimeLabel(item.publishedAt);
  timeEl.title         = item.publishedAt.toLocaleString('he-IL');

  meta.appendChild(badge);
  meta.appendChild(timeEl);

  const titleEl       = document.createElement('h2');
  titleEl.className   = 'card-title';
  titleEl.textContent = item.title;

  body.appendChild(meta);
  body.appendChild(titleEl);

  if (item.description) {
    const sum       = document.createElement('p');
    sum.className   = 'card-summary';
    sum.textContent = item.description;
    body.appendChild(sum);
  }

  a.appendChild(body);
  return a;
}

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

function appendCards(items, from, count) {
  const slice = items.slice(from, from + count);
  const frag  = document.createDocumentFragment();
  slice.forEach(item => frag.appendChild(buildCard(item)));
  feedEl.appendChild(frag);
  shownCount = from + slice.length;
  loadMoreBtn.classList.toggle('hidden', shownCount >= items.length);
}

function showSpinner() {
  feedEl.innerHTML = '<div class="feed-status"><div class="spinner"></div><br>טוען חדשות...</div>';
  loadMoreBtn.classList.add('hidden');
}

// =============================================
// POLLING
// =============================================

async function loadFeeds(isFirstLoad = false) {
  if (isFirstLoad) showSpinner();

  const cutoff  = Date.now() - CONFIG.TIME_WINDOW_MS;
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

  const relevant = toAdd.filter(i => activeTab === 'all' || i.sourceName === activeTab);
  if (relevant.length) {
    const frag = document.createDocumentFragment();
    relevant.forEach(item => frag.appendChild(buildCard(item, true)));
    feedEl.prepend(frag);
    shownCount += relevant.length;
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

function refreshTimestamps() {
  feedEl.querySelectorAll('time.card-time').forEach(el => {
    el.textContent = formatTimeLabel(new Date(el.dateTime));
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
    appendCards(getActiveItems(), shownCount, CONFIG.INITIAL_POSTS);
  });

  newItemsBar.addEventListener('click', () => {
    applyPendingNew();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
