// Freezy — freeze the page's hover / active state so transient UI can be screenshotted.
//
// Two mechanisms, both required:
//
//   1. Swallow events, so JS-driven menus (React state, mouseenter handlers) never learn
//      that the mouse left.
//   2. Rewrite CSS :hover / :active rules into class-based ones and pin those classes onto
//      the elements that were hovered, so pure-CSS effects survive too. The browser updates
//      native :hover from the real cursor position and no amount of event blocking changes
//      that, which is why mechanism 1 alone is not enough.
//
// This file runs at document_start on purpose: our capture-phase listeners must be
// registered before any page script registers its own, otherwise stopImmediatePropagation
// has nothing left to stop.

(() => {
  const HOVER_CLASS = '__freezy-hover';
  const ACTIVE_CLASS = '__freezy-active';
  const IS_TOP_FRAME = window.top === window;

  let frozen = false;
  let taggedElements = []; // [element, className] pairs we added
  let injectedStyles = []; // <style> / CSSStyleSheet we added, removed on unfreeze
  const remoteSheets = new Map(); // href -> CSSRuleList, re-fetched cross-origin stylesheets

  /* ------------------------------------------------------------------ *
   * 1. Event swallowing
   * ------------------------------------------------------------------ */

  // Pointer events keep JS-driven menus open. Focus events matter just as much: macOS
  // screenshot shortcuts blur the browser window, and plenty of menus close themselves on
  // blur / focusout / visibilitychange. Missing those would mean "freezing works, but the
  // state dies the moment you reach for the screenshot key".
  const SWALLOWED = [
    'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
    'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
    'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
    'touchstart', 'touchmove', 'touchend',
    'blur', 'focus', 'focusin', 'focusout',
    'visibilitychange', 'pagehide', 'resize', 'scroll', 'wheel',
  ];

  // Not cancelable, or cancelling them is meaningless / noisy.
  const NEVER_PREVENT = new Set([
    'blur', 'focus', 'focusin', 'focusout', 'visibilitychange', 'pagehide', 'resize', 'scroll',
  ]);

  function swallow(event) {
    if (!frozen) return;
    event.stopImmediatePropagation();
    if (event.cancelable && !NEVER_PREVENT.has(event.type)) event.preventDefault();
  }

  for (const type of SWALLOWED) {
    window.addEventListener(type, swallow, true);
  }

  // Keyboard is swallowed too, so a stray keypress can't disturb the frozen page — but Escape
  // is ours, and it's the only way out that doesn't involve the mouse.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type, (event) => {
      if (!frozen) return;
      event.stopImmediatePropagation();
      if (type === 'keydown' && event.key === 'Escape') {
        event.preventDefault();
        unfreeze();
      }
    }, true);
  }

  /* ------------------------------------------------------------------ *
   * 2. Rewriting :hover / :active rules
   * ------------------------------------------------------------------ */

  // Specificity is why this works without !important: `:hover` and a single class are both
  // (0,1,0), so `.btn:hover` and `.btn.__freezy-hover` weigh exactly the same. Our sheet goes
  // in last, so it wins ties against the element's resting style and nothing else changes.
  function rewriteSelector(selector) {
    const rewritten = selector
      .replace(/:hover\b/g, `.${HOVER_CLASS}`)
      .replace(/:active\b/g, `.${ACTIVE_CLASS}`);
    return rewritten === selector ? null : rewritten;
  }

  function collectRules(rules, out) {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const selector = rewriteSelector(rule.selectorText);
        if (selector) out.push(`${selector}{${rule.style.cssText}}`);
      } else if (rule.cssRules) {
        // Grouping rule: @media, @supports, @layer, @container. Recurse, and rebuild the
        // prelude from cssText — there's no common property that exposes it.
        const inner = [];
        collectRules(rule.cssRules, inner);
        if (!inner.length) continue;
        const brace = rule.cssText.indexOf('{');
        if (brace === -1) continue;
        out.push(`${rule.cssText.slice(0, brace).trim()}{${inner.join('')}}`);
      }
    }
  }

  function harvestSheet(sheet, out) {
    try {
      collectRules(sheet.cssRules, out);
      return;
    } catch {
      // Cross-origin stylesheet — cssRules throws. Fall through to the re-fetched copy.
    }
    const cached = sheet.href && remoteSheets.get(sheet.href);
    if (cached) collectRules(cached, out);
  }

  // Cross-origin sheets (anything on a CDN) have to be fetched again and re-parsed. On a site
  // like Stripe every single sheet is cross-origin, so without this fallback mechanism 2
  // recovers zero rules.
  //
  // The fetch goes through the service worker on purpose: fetching here would run with the
  // page's origin and hit CORS, which silently fails on any CDN that doesn't send
  // Access-Control-Allow-Origin. The parsed copy is kept in a `media="not all"` <style> so it
  // never applies but its cssRules stay alive.
  async function prefetchRemoteSheets() {
    const pending = [];
    for (const sheet of document.styleSheets) {
      if (!sheet.href || remoteSheets.has(sheet.href)) continue;
      try {
        sheet.cssRules; // readable, nothing to do
        continue;
      } catch { /* needs fetching */ }
      pending.push(sheet.href);
    }

    await Promise.all(pending.map(async (href) => {
      try {
        const { css } = await chrome.runtime.sendMessage({ type: 'freezy:fetch-css', href });
        if (!css) return;
        const parser = document.createElement('style');
        parser.media = 'not all';
        parser.dataset.freezyParser = '1';
        parser.textContent = css;
        (document.head || document.documentElement).appendChild(parser);
        remoteSheets.set(href, parser.sheet.cssRules);
        // The node stays in the DOM on purpose: removing it invalidates the CSSRuleList.
      } catch { /* blocked or gone — mechanism 1 still covers this element */ }
    }));
  }

  /* ------------------------------------------------------------------ *
   * 3. Roots, tagging, injection
   * ------------------------------------------------------------------ */

  // Open shadow roots carry their own stylesheets and their own :hover chain.
  function collectRoots() {
    const roots = [document];
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) {
          roots.push(element.shadowRoot);
          walk(element.shadowRoot);
        }
      }
    };
    walk(document);
    return roots;
  }

  // `querySelectorAll(':hover')` returns the whole chain from <html> down to the deepest
  // hovered element, which is exactly what needs pinning.
  function tagState(root, pseudo, className) {
    let matches;
    try {
      matches = root.querySelectorAll(pseudo);
    } catch {
      return;
    }
    for (const element of matches) {
      element.classList.add(className);
      taggedElements.push([element, className]);
    }
  }

  function injectInto(root, cssText) {
    if (!cssText) return;
    const style = document.createElement('style');
    style.dataset.freezy = '1';
    style.textContent = cssText;
    (root === document ? document.head || document.documentElement : root).appendChild(style);
    injectedStyles.push(style);
  }

  /* ------------------------------------------------------------------ *
   * 4. Freeze / unfreeze
   * ------------------------------------------------------------------ */

  async function freeze() {
    if (frozen) return;

    // Order matters. Flipping the flag and tagging the chain are synchronous, so the menu is
    // already safe before any of the async stylesheet work below starts.
    frozen = true;

    const roots = collectRoots();
    for (const root of roots) {
      tagState(root, ':hover', HOVER_CLASS);
      tagState(root, ':active', ACTIVE_CLASS);
    }

    if (IS_TOP_FRAME) { showToast(); chime('freeze'); reportState(true); }

    await prefetchRemoteSheets();
    if (!frozen) return; // unfrozen while we were fetching

    for (const root of roots) {
      const rules = [];
      const sheets = root === document ? document.styleSheets : root.styleSheets || [];
      for (const sheet of sheets) harvestSheet(sheet, rules);
      for (const adopted of root.adoptedStyleSheets || []) harvestSheet(adopted, rules);
      injectInto(root, rules.join('\n'));
    }
  }

  function unfreeze() {
    if (!frozen) return;
    frozen = false;

    for (const [element, className] of taggedElements) element.classList.remove(className);
    taggedElements = [];

    for (const style of injectedStyles) style.remove();
    injectedStyles = [];

    hideToast();
    if (IS_TOP_FRAME) { chime('release'); reportState(false); }
  }

  /* ------------------------------------------------------------------ *
   * 5. Toast
   * ------------------------------------------------------------------ */

  // Loud on arrival, then gone — it must not end up in the screenshot. The countdown says
  // plainly that the NOTICE is what hides, not the freeze: a bare "3…2…1" that vanishes reads
  // as "the state expired", and the page would then feel broken rather than held.
  const TOAST_SECONDS = 3;
  let toastHost = null;
  let toastTimer = null;

  function showToast() {
    hideToast();
    toastHost = document.createElement('div');
    toastHost.dataset.freezy = 'toast';
    const shadow = toastHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .toast {
          position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
          min-width: 208px; padding: 12px 15px 11px; border-radius: 11px;
          font: 12px/1.35 ui-sans-serif, -apple-system, system-ui, sans-serif;
          color: #fff; background: rgba(13, 15, 18, 0.94);
          border: 1px solid rgba(110, 200, 255, 0.55);
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.42), 0 0 0 4px rgba(110, 200, 255, 0.10);
          pointer-events: none; user-select: none;
          /* opacity stays owned by the element, never by the entry animation. If animations
             don't run — throttled tab, reduced motion, anything — the toast must degrade to
             "visible without the flourish", not to invisible. So the entry only moves it. */
          opacity: 1;
          animation: rise 200ms cubic-bezier(.2,.9,.3,1),
                     out 380ms ease ${TOAST_SECONDS * 1000 - 380}ms forwards;
        }
        .row { display: flex; align-items: center; gap: 8px; }
        .dot {
          width: 8px; height: 8px; border-radius: 50%; background: #6ec8ff;
          box-shadow: 0 0 0 0 rgba(110,200,255,.6); animation: pulse 1.6s ease-out infinite;
        }
        .title { font-weight: 650; letter-spacing: .04em; font-size: 12.5px; }
        .sub { margin-top: 6px; font-size: 10.5px; opacity: .62; letter-spacing: .01em; }
        kbd {
          font: inherit; font-size: 10px; padding: 1px 4px; border-radius: 3px;
          background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.16);
        }
        .track { margin-top: 9px; height: 2px; border-radius: 2px; background: rgba(255,255,255,.13); overflow: hidden; }
        .fill { height: 100%; background: #6ec8ff; transform-origin: left;
                animation: drain ${TOAST_SECONDS}s linear forwards; }
        @keyframes drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
        @keyframes rise { from { transform: translateY(8px) scale(.97); } }
        @keyframes out  { to { opacity: 0; transform: translateY(4px); } }
        @keyframes pulse {
          70%  { box-shadow: 0 0 0 7px rgba(110,200,255,0); }
          100% { box-shadow: 0 0 0 0 rgba(110,200,255,0); }
        }
      </style>
      <div class="toast">
        <div class="row"><span class="dot"></span><span class="title">FROZEN</span></div>
        <div class="sub">Notice hides in <b id="n">${TOAST_SECONDS}</b>s · <kbd>Esc</kbd> to release</div>
        <div class="track"><div class="fill"></div></div>
      </div>
    `;
    (document.body || document.documentElement).appendChild(toastHost);

    const n = shadow.getElementById('n');
    let left = TOAST_SECONDS;
    toastTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) return hideToast();
      if (n) n.textContent = String(left);
    }, 1000);
  }

  function hideToast() {
    clearInterval(toastTimer);
    toastTimer = null;
    toastHost?.remove();
    toastHost = null;
  }

  /* ------------------------------------------------------------------ *
   * 6. Chimes
   * ------------------------------------------------------------------ */

  // Sound is the one channel that cannot land in a screenshot, which makes it the right place
  // for state feedback here.
  //
  // The two cues are deliberately ASYMMETRIC rather than mirror images: freeze is ~0.5s of
  // low weight landing plus an ice ring; release is an ~0.08s puff of air. Two sounds that
  // differ only in pitch direction are genuinely hard to tell apart at low volume with your
  // attention on the page — separating them on duration, register, texture and layer count
  // all at once is what makes the state readable without looking.
  //
  // Purely a bonus: if the autoplay policy blocks the context on some site, this fails silently
  // and the toast still does its job. Never surface an error for a decoration.
  //
  // Every envelope below ramps both ends. Starting or stopping a gain at full amplitude
  // produces an audible click.
  let audio = null;

  function tone(ctx, freq, at, dur, peak) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(ctx.destination);
    o.start(at); o.stop(at + dur + 0.03);
  }

  function glide(ctx, f1, f2, at, dur, peak) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(f1, at);
    o.frequency.exponentialRampToValueAtTime(f2, at + dur * 0.85);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(ctx.destination);
    o.start(at); o.stop(at + dur + 0.03);
  }

  // Inharmonic partials, upper ones decaying first. Those two properties are what separate
  // struck glass and ice from a plucked string — without them this reads as a synth chord.
  function bell(ctx, base, at, dur, peak, drift = 1) {
    const RATIOS = [1, 2.72, 4.83, 7.10];
    const GAINS = [1, 0.48, 0.25, 0.12];
    RATIOS.forEach((ratio, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      const f = base * ratio;
      o.frequency.setValueAtTime(f, at);
      if (drift !== 1) o.frequency.exponentialRampToValueAtTime(f * drift, at + dur);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak * GAINS[i], at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur * (1 - i * 0.16));
      o.connect(g).connect(ctx.destination);
      o.start(at); o.stop(at + dur + 0.05);
    });
  }

  function noise(ctx, at, dur, peak, freq, filterType) {
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.value = peak;
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start(at);
  }

  function chime(kind) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio = audio || new AC();
      if (audio.state === 'suspended') audio.resume().catch(() => {});
      const t = audio.currentTime + 0.01;
      if (kind === 'freeze') {
        // weight landing, then the ice ring on top of it
        glide(audio, 165, 92, t, 0.26, 0.075);
        bell(audio, 760, t + 0.012, 0.46, 0.036, 0.99);
      } else {
        // a short breath of air, gone almost immediately
        noise(audio, t, 0.07, 0.04, 5200, 'highpass');
        tone(audio, 2700, t + 0.004, 0.05, 0.018);
      }
    } catch { /* no audio on this page — the toast already carried the message */ }
  }

  function reportState(isFrozen) {
    try { chrome.runtime.sendMessage({ type: 'freezy:state', frozen: isFrozen }); } catch {}
  }

  /* ------------------------------------------------------------------ *
   * 7. Wiring
   * ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'freezy:toggle') return;
    frozen ? unfreeze() : freeze();
  });

  // Warm the cross-origin cache once the page settles, so the first freeze is instant.
  window.addEventListener('load', () => { prefetchRemoteSheets().catch(() => {}); }, { once: true });
})();
