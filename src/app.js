(function () {
  var CA = '53uxQtB9pcjWvCHguz3JTTndvuKqGxhrD37EetnCpump';
  var PAIR = 'https://www.geckoterminal.com/solana/pools/9KkDpvUQRqXjiuyMFcy1CwqrxLwDcGGUR2Cap2Qt7bU7';
  var BUY =
    'https://jup.ag/swap?sell=So11111111111111111111111111111111111111112&buy=' + CA;
  var SOLSCAN = 'https://solscan.io/token/' + CA;
  var DESK = 'https://www.getdasha.com/dasha';
  var CASINO = 'How u crying at the casino and u can’t even get in';
  var DEX =
    'https://api.dexscreener.com/latest/dex/tokens/' + CA;

  function $(id) {
    return document.getElementById(id);
  }

  function buildSharePack(kind) {
    kind = kind || 'share';
    if (kind === 'verify') {
      return (
        '$dasha mint (verify before buy)\n' +
        CA +
        '\n' +
        SOLSCAN
      );
    }
    // Neutral fact pack for every other kind (share/default). No FOMO, raid, or referral.
    return (
      '$dasha\n' +
      CASINO +
      '\n\nMint:\n' +
      CA +
      '\n\nChart:\n' +
      PAIR +
      '\n\nDesk:\n' +
      DESK
    );
  }

  function normalizeMint(raw) {
    var s = String(raw || '')
      .trim()
      /* zero-width / BOM that break exact match when pasting */
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, '');
    /* paste of explorer / jupiter / phantom URL → extract base58 mint */
    var m = s.match(/[1-9A-HJ-NP-Za-km-z]{32,50}/);
    if (m) {
      /* prefer segment after /token/ or buy= when present */
      var u = s.match(/(?:token\/|buy=|mint=)([1-9A-HJ-NP-Za-km-z]{32,50})/i);
      return (u && u[1]) || m[0];
    }
    return s;
  }

  /**
   * Local last-visit stamp (this browser only). Helps spot mint drift without a server.
   * storage: { getItem, setItem }; now: ms epoch; mint: expected CA string.
   */
  function visitStamp(storage, now, mint) {
    var key = 'dasha-desk-visit-v1';
    var prev = null;
    try {
      prev = JSON.parse(storage.getItem(key) || 'null');
    } catch (e) {
      prev = null;
    }
    if (prev && typeof prev !== 'object') prev = null;
    var next = { mint: String(mint || ''), at: Number(now) || 0 };
    try {
      storage.setItem(key, JSON.stringify(next));
    } catch (e) {}
    var mintChanged = !!(prev && prev.mint && prev.mint !== next.mint);
    var label = '';
    if (mintChanged) {
      label = 'Mint differs from your last visit on this device — re-verify the full address.';
    } else if (prev && prev.at) {
      try {
        label = 'Last check on this device: ' + new Date(prev.at).toLocaleString();
      } catch (e) {
        label = 'Last check on this device recorded.';
      }
    } else {
      label = 'First check on this device — full mint stored only locally.';
    }
    return { prev: prev, current: next, mintChanged: mintChanged, label: label };
  }

  /**
   * Relative age of a successful fetch. Buckets, not tenths of a second.
   * from/now: ms epoch. Empty string if there has not been a success yet.
   */
  function ageLabel(from, now) {
    var t = Number(from) || 0;
    var n = Number(now) || 0;
    if (!t || !n || n < t) return '';
    var s = Math.round((n - t) / 1000);
    if (s < 10) return 'just now';
    if (s < 50) return 'checked ' + s + ' seconds ago';
    if (s < 90) return 'about a minute ago';
    var m = Math.round(s / 60);
    if (m < 45) return 'checked ' + m + ' minutes ago';
    if (m < 90) return 'about an hour ago';
    var h = Math.round(m / 60);
    if (h < 36) return 'checked ' + h + ' hours ago';
    var days = Math.round(h / 24);
    return days === 1 ? 'about a day ago' : 'checked ' + days + ' days ago';
  }

  // Pure export for unit tests / reuse (no FOMO builders).
  globalThis.DDShare = {
    CA: CA,
    PAIR: PAIR,
    BUY: BUY,
    DESK: DESK,
    buildSharePack: buildSharePack,
    normalizeMint: normalizeMint,
    visitStamp: visitStamp,
    ageLabel: ageLabel,
  };

  if (typeof document === 'undefined') return;

  (function setupScrollTop() {
    var btn = document.getElementById('scrollTopBtn');
    if (!btn || typeof window === 'undefined') return;
    var sync = function () {
      btn.hidden = window.scrollY < 280;
    };
    window.addEventListener('scroll', sync, { passive: true });
    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    sync();
  })();

  function toast(el, label) {
    if (!el) return;
    var prev = el.textContent;
    el.textContent = label || 'Copied';
    setTimeout(function () {
      el.textContent = prev;
    }, 1400);
  }

  function copy(text, btn) {
    var done = function () {
      toast(btn, 'Copied');
      var t = $('dd-toast');
      if (t) {
        t.hidden = false;
        setTimeout(function () {
          t.hidden = true;
        }, 1400);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        fallbackCopy(text);
        done();
      });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch (e) {}
    document.body.removeChild(ta);
  }


  function verify() {
    var box = $('dd-verify');
    var paste = $('dd-paste');
    if (!box || !paste) return;
    var raw = normalizeMint(paste.value);
    if (!raw) {
      box.className = 'dd-verify';
      box.textContent = 'Waiting…';
      return;
    }
    if (raw === CA) {
      box.className = 'dd-verify ok';
      box.textContent = 'Exact match — this is the associated mint.';
      return;
    }
    /* Solana addresses are 32-44 chars of base58. A well-formed-but-different
       address is "not the mint"; anything else is "not an address at all". */
    if (raw.length >= 32 && raw.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(raw)) {
      box.className = 'dd-verify bad';
      box.textContent = 'Does not match the associated mint.';
      return;
    }
    box.className = 'dd-verify warn';
    box.textContent = 'Not a Solana mint format.';
  }

  /* null/undefined/''/NaN mean "no data" — never let them become 0, which
     money() would print as $0.00 and read as a fact about the token. */
  function num(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function money(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    if (n >= 1) return '$' + n.toFixed(2);
    return '$' + n.toPrecision(3);
  }

  function pct(n) {
    if (n == null || !isFinite(n)) return '—';
    var s = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
    return s;
  }

  function setShare() {
    var line = buildSharePack('share');
    if ($('dd-share')) $('dd-share').value = line;
    if ($('dd-tweet')) {
      $('dd-tweet').href =
        'https://x.com/intent/post?text=' + encodeURIComponent(line);
    }
  }

  function paintPair(pair) {
    if (!pair) return;
    var price = num(pair.priceUsd);
    var mcap = num(pair.marketCap || pair.fdv);
    var liq = pair.liquidity ? num(pair.liquidity.usd) : null;
    var ch = pair.priceChange ? num(pair.priceChange.h24) : null;
    if ($('s-price')) $('s-price').textContent = money(price);
    if ($('s-mcap')) $('s-mcap').textContent = money(mcap);
    if ($('s-liq')) $('s-liq').textContent = money(liq);
    if ($('s-24h')) {
      $('s-24h').textContent = pct(ch);
      $('s-24h').style.color =
        ch > 0 ? 'var(--ok)' : ch < 0 ? 'var(--bad)' : 'var(--text)';
    }
    if ($('dd-px')) $('dd-px').textContent = money(price);
    if ($('dd-asof')) {
      $('dd-asof').textContent = 'Dexscreener · ' + (pair.dexId || 'pool');
    }
    if ($('dd-live')) $('dd-live').textContent = 'live';
  }

  function clearPair(message, status) {
    ['s-price', 's-mcap', 's-liq', 's-24h', 'dd-px'].forEach(function (id) {
      if ($(id)) $(id).textContent = '—';
    });
    if ($('s-24h')) $('s-24h').style.removeProperty('color');
    if ($('dd-asof')) $('dd-asof').textContent = message;
    if ($('dd-live')) $('dd-live').textContent = status;
  }

  var lastOk = 0;
  var ageClock = 0;
  /* Consecutive Dex fetch failures. Drives the poll backoff below: each
     failure doubles the wait, a success resets it. */
  var pollFails = 0;
  var POLL_BASE_MS = 60000;
  var POLL_MAX_MS = 30 * 60000;

  function paintAge() {
    var el = $('dd-age');
    if (!el) return;
    try {
      el.textContent = lastOk ? ageLabel(lastOk, Date.now()) : '';
    } catch (e) {}
  }

  function markOk() {
    lastOk = Date.now();
    paintAge();
    if (ageClock) return;
    try {
      ageClock = setInterval(function () {
        try {
          paintAge();
        } catch (e) {}
      }, 1000);
    } catch (e) {}
  }

  function refresh() {
    if (!lastOk && $('dd-asof')) $('dd-asof').textContent = 'Refreshing…';
    if ($('dd-live')) $('dd-live').textContent = '…';
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var tid = null;
    if (ctrl) {
      tid = setTimeout(function () {
        try {
          ctrl.abort();
        } catch (e) {}
      }, 12000);
    }
    fetch(DEX, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('Dex HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var pairs = (data && data.pairs) || [];
        if (!pairs.length) {
          clearPair('Dex returned no pools · use sources below', 'no pool');
          paintAge();
          return;
        }
        var best = pairs[0];
        for (var i = 1; i < pairs.length; i++) {
          var a = pairs[i].liquidity && pairs[i].liquidity.usd;
          var b = best.liquidity && best.liquidity.usd;
          if ((a || 0) > (b || 0)) best = pairs[i];
        }
        paintPair(best);
        markOk();
        pollFails = 0;
      })
      .catch(function () {
        pollFails += 1;
        clearPair('Dex unavailable · use sources below', 'offline');
        paintAge();
      })
      .then(function () {
        if (tid) clearTimeout(tid);
      });
  }

  if ($('dd-copy')) {
    $('dd-copy').addEventListener('click', function () {
      copy(CA, $('dd-copy'));
    });
  }
  if ($('dd-copy-share')) {
    $('dd-copy-share').addEventListener('click', function () {
      copy(($('dd-share') && $('dd-share').value) || buildSharePack('share'), $('dd-copy-share'));
    });
  }
  if ($('dd-paste')) {
    $('dd-paste').addEventListener('input', verify);
    $('dd-paste').addEventListener('paste', function () {
      setTimeout(verify, 0);
    });
  }
  if ($('dd-refresh')) {
    $('dd-refresh').addEventListener('click', refresh);
  }

  setShare();
  refresh();
  /* last-visit honesty — local only, no server */
  (function paintVisit() {
    var el = $('dd-visit');
    if (!el || typeof localStorage === 'undefined') return;
    try {
      var stamp = visitStamp(localStorage, Date.now(), CA);
      el.textContent = stamp.label;
      el.className = 'dd-visit' + (stamp.mintChanged ? ' dd-visit-warn' : '');
    } catch (e) {}
  })();
  /* Poll with exponential backoff: the desk refetches Dex forever, and during a
     long outage a fixed 60s cadence spends quota and attention for no new
     information. Each consecutive failure doubles the wait from 60s up to a
     30-minute ceiling; one success resets it. The manual refresh button and
     the tab-visible nudge still fire immediately. */
  function pollDelay() {
    return Math.min(POLL_BASE_MS * Math.pow(2, Math.min(pollFails, 6)), POLL_MAX_MS);
  }
  (function schedulePoll() {
    setTimeout(function () {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        refresh();
      }
      schedulePoll();
    }, pollDelay());
  })();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refresh();
    });
  }
})();
