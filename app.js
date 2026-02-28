/**
 * =============================================
 * פיד החדשות של אריאן — app.js
 * =============================================
 */

const CONFIG = {
  INITIAL_POSTS:    10,
  POLL_INTERVAL_MS: 30_000,
  TIME_WINDOW_MS:   60 * 60_000,

  PROXY_RSS2JSON:   'https://api.rss2json.com/v1/api.json?rss_url=',
  PROXY_ALLORIGINS: 'https://api.allorigins.win/get?url=',

  FEEDS: [
    { url: 'https://storage.googleapis.com/mako-sitemaps/rssHomepage.xml', name: 'mako',  label: 'מאקו',  encoding: 'utf-8'        },
    { url: 'https://www.ynet.co.il/Integration/StoryRss1854.xml',          name: 'ynet',  label: 'ynet',  encoding: 'windows-1255' },
    { url: 'https://rss.walla.co.il/feed/22',                              name: 'walla', label: 'וואלה', encoding: 'utf-8'        },
  ],
};

// STATE
let allItems   = [];
let activeTab  = 'all';
let shownCount = 0;
let pendingNew = [];

// DOM
const feedEl      = document.getElementById('feed');
const loadMoreBtn = document.getElementById('load-more-btn');
const newItemsBar = document.getElementById('new-items-bar');
const lastUpdEl   = document.getElementById('last-updated');
const tabs        = document.querySelectorAll('.tab');

// ── DEBUG BAR ──────────────────────────────────────────────────────────────
// Shows the raw pubDate string from rss2json so we can verify the timezone.
// Remove this block once the time is confirmed correct.
let _debugShown = false;
function showDebug(rawStr, parsedDate) {
  if (_debugShown) return;
  _debugShown = true;
  const bar = document.createElement('div');
  bar.style.cssText = 'background:#fffbe6;border-bottom:1px solid #f0c040;padding:6px 12px;font-size:11px;font-family:monospace;direction:ltr;text-align:left;position:sticky;top:0;z-index:200';
  bar.innerHTML = `<b>DEBUG TIME</b> — raw: <code>${rawStr}</code> → parsed: <code>${parsedDate.toISOString()}</code> → local: <code>${parsedDate.toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit',hour12:false})}</code> <button onclick="this.parentElement.remove()" style="margin-right:8px;cursor:pointer">✕</button>`;
  document.body.prepend(bar);
}
// ──────────────────────────────────────────────────────────────────────────

// =============================================
// FETCH
// =============================================

async function fetchFeed(feed) {
  // Strategy 1: direct fetch with correct encoding
  try {
    const res = await fetch(feed.url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const buf  = await res.arrayBuffer();
      const text = new TextDecoder(feed.encoding || 'utf-8').decode(buf);
      const items = parseRssXml(text, feed.name, 'xml');
      if (items.length > 0) return items;
    }
  } catch (_) {}

  // Strategy 2: rss2json
  try {
    const res = await fetch(CONFIG.PROXY_RSS2JSON + encodeURIComponent(feed.url), {
      cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.status === 'ok' && json.items?.length) {
        return parseRss2JsonItems(json.items, feed.name);
      }
    }
  } catch (_) {}

  // Strategy 3: allorigins
  try {
    const res = await fetch(CONFIG.PROXY_ALLORIGINS + encodeURIComponent(feed.url), {
      cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.contents) return parseRssXml(json.contents, feed.name, 'xml');
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
  const doc   = new DOMParser().parseFromString(xmlText, 'text/xml');
  const items = [...doc.querySelectorAll('item, entry')];
  return items.map(el => normaliseXmlItem(el, sourceName)).filter(Boolean);
}

function normaliseXmlItem(item, sourceName) {
  const get = tag => item.querySelector(tag)?.textContent?.trim() || '';
  const title = get('title');
  const link  = get('link') || item.querySelector('link')?.getAttribute('href') || '';
  const pubStr = get('pubDate') || get('published') || get('updated') || '';

  // XML feeds include full RFC 2822 with timezone offset — JS handles correctly
  const publishedAt = pubStr ? new Date(pubStr) : null;
  if (!title || !link || !publishedAt || isNaN(publishedAt)) return null;

  const description = stripHtml(get('description') || get('summary') || get('content')).slice(0, 220);
  const media = extractMediaXml(item);
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
  return m ? m[1] : null;
}

// =============================================
// PARSE — rss2json
// =============================================

function parseRss2JsonItems(items, sourceName) {
  return items.map(item => {
    const title = item.title?.trim();
    const link  = item.link?.trim();
    if (!title || !link || !item.pubDate) return null;

    const publishedAt = parseRss2JsonDate(item.pubDate);
    if (!publishedAt) return null;

    // Show debug for first walla item
    if (sourceName === 'walla' && !_debugShown) showDebug(item.pubDate, publishedAt);

    const description = stripHtml(item.description || item.content || '').slice(0, 220);
    const media = item.enclosure?.link || item.thumbnail || extractImgFromHtml(item.description || '') || null;
    return { id: link, title, link, publishedAt, sourceName, description, media };
  }).filter(Boolean);
}

/**
 * rss2json pubDate format: "2024-06-10 16:00:00"
 *
 * rss2json documentation states it outputs UTC.
 * However some users report it reflects local time of the feed.
 *
 * Current setting: treated as UTC (appending Z).
 * If times appear 3h fast → remove the 'Z' (treat as local).
 * If times appear 3h slow → keep 'Z' (this is the current setting).
 */
function parseRss2JsonDate(str) {
  const s = str.trim();
  // Already has timezone info — trust it
  if (/[Z+\-]\d{2}:?\d{2}$/.test(s) || s.endsWith('Z')) {
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  // "YYYY-MM-DD HH:MM:SS" — append Z to treat as UTC
  const d = new Date(s.replace(' ', 'T') + 'Z');
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

function formatAbsoluteTime(date) {
  return date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatRelativeTime(date) {
  const diffMs  = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)  return 'עכשיו';
  if (diffMin < 60) return `לפני ${diffMin} דק׳`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `לפני ${diffH} שע׳`;
  return date.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) + ' ' + formatAbsoluteTime(date);
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
  a.href = item.link;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  if (item.media && /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(item.media)) {
    const img = document.createElement('img');
    img.className = 'card-thumb';
    img.src = item.media;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    a.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const badge = document.createElement('span');
  badge.className   = `source-badge source-${item.sourceName}`;
  badge.textContent = CONFIG.FEEDS.find(f => f.name === item.sourceName)?.label || item.sourceName;

  const timeEl = document.createElement('time');
  timeEl.className   = 'card-time';
  timeEl.dateTime    = item.publishedAt.toISOString();
  timeEl.textContent = formatTimeLabel(item.publishedAt);
  timeEl.title       = item.publishedAt.toLocaleString('he-IL');

  meta.appendChild(badge);
  meta.appendChild(timeEl);

  const titleEl = document.createElement('h2');
  titleEl.className   = 'card-title';
  titleEl.textContent = item.title;

  body.appendChild(meta);
  body.appendChild(titleEl);

  if (item.description) {
    const sum = document.createElement('p');
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

  const results = await Promise.all(CONFIG.FEEDS.map(fetchFeed));

  // Per source: sort desc, take top 10
  const allSorted = CONFIG.FEEDS.flatMap((feed, idx) =>
    (results[idx] || [])
      .filter(i => i.publishedAt && !isNaN(i.publishedAt))
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 10)
  ).sort((a, b) => b.publishedAt - a.publishedAt);

  if (isFirstLoad) {
    allItems = dedup(allSorted);
    renderFull();
  } else {
    const existingIds = new Set(allItems.map(i => i.id));
    const newItems    = allSorted.filter(i => !existingIds.has(i.id));
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
  const toAdd = pendingNew.filter(i => !existingIds.has(i.id));
  pendingNew = [];
  allItems = dedup([...toAdd, ...allItems]).sort((a, b) => b.publishedAt - a.publishedAt);
  newItemsBar.classList.add('hidden');
  const relevant = toAdd.filter(i => activeTab === 'all' || i.sourceName === activeTab);
  if (relevant.length) {
    const frag = document.createDocumentFragment();
    relevant.forEach(item => frag.appendChild(buildCard(item, true)));
    feedEl.prepend(frag);
    shownCount += relevant.length;
    setTimeout(() => feedEl.querySelectorAll('.card.is-new').forEach(c => c.classList.remove('is-new')), 12_000);
  }
  loadMoreBtn.classList.toggle('hidden', shownCount >= getActiveItems().length);
}

function dedup(items) {
  const seen = new Set();
  return items.filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
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
  loadMoreBtn.addEventListener('click', () => appendCards(getActiveItems(), shownCount, CONFIG.INITIAL_POSTS));
  newItemsBar.addEventListener('click', () => { applyPendingNew(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
})();
