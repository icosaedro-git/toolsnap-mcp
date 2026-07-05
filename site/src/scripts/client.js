// Single global script: header shadow, copy buttons, scroll-reveal,
// connect tabs, mobile nav, docs mini-TOC, hero video playback rate.
// Progressive enhancement only — everything works without this file.

document.documentElement.classList.add('js');

// ── Header shadow on scroll ──────────────────────────────────────
const header = document.querySelector('[data-header]');
if (header) {
  const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

// ── Mobile nav ────────────────────────────────────────────────────
const navToggle = document.querySelector('[data-nav-toggle]');
const navOverlay = document.querySelector('[data-nav-overlay]');
if (navToggle && navOverlay) {
  navToggle.addEventListener('click', () => {
    const isOpen = navOverlay.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });
  navOverlay.querySelectorAll('a').forEach((a) =>
    a.addEventListener('click', () => {
      navOverlay.classList.remove('is-open');
      navToggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    })
  );
}

// ── Copy buttons (event delegation) ──────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const targetSel = btn.getAttribute('data-copy-target');
  const text = targetSel
    ? document.querySelector(targetSel)?.textContent ?? ''
    : btn.getAttribute('data-copy') ?? '';
  navigator.clipboard?.writeText(text.trim()).then(() => {
    btn.classList.add('is-copied');
    setTimeout(() => btn.classList.remove('is-copied'), 1500);
  });
});

// ── Scroll reveal ─────────────────────────────────────────────────
const revealEls = document.querySelectorAll('.reveal');
if (revealEls.length && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );
  revealEls.forEach((el, i) => {
    el.style.setProperty('--i', String(i % 5));
    io.observe(el);
  });
}

// ── Tabs (Connect section, client switcher) ──────────────────────
document.querySelectorAll('[data-tabs]').forEach((group) => {
  const buttons = group.querySelectorAll('[role="tab"]');
  const panels = group.querySelectorAll('[role="tabpanel"]');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab-target');
      buttons.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      panels.forEach((p) => {
        p.hidden = p.getAttribute('data-tab-panel') !== target;
      });
    });
  });
});

// ── Hero living logo: slow the loop, respect reduced motion ──────
const heroVideo = document.querySelector('[data-hero-video]');
if (heroVideo) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    heroVideo.remove();
  } else {
    heroVideo.playbackRate = 0.55;
  }
}

// ── Docs mini-TOC active section ──────────────────────────────────
const tocLinks = document.querySelectorAll('[data-toc-link]');
if (tocLinks.length && 'IntersectionObserver' in window) {
  const sections = Array.from(tocLinks)
    .map((a) => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);
  const tocIo = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = '#' + entry.target.id;
          tocLinks.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === id));
        }
      }
    },
    { rootMargin: '-20% 0px -70% 0px' }
  );
  sections.forEach((s) => tocIo.observe(s));
}

// ── FAQ / details "+" rotation is pure CSS via [open] — no JS needed.
