// Feature-detect native Popover API and conditionally load polyfill only when missing
if (!Object.hasOwn(HTMLElement.prototype, "popover")) {
  import("https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js").catch(() => {
    // Graceful degradation if offline
  });
}

// ==========================================================================
// 1. Responsive Navbar (Measure-Driven Inline vs Native Popover)
// ==========================================================================

function initNavbar() {
  const header = document.getElementById("site-header");
  const inner = header?.querySelector(".header-inner");
  const menuButton = header?.querySelector(".menu-button");
  const siteMenu = document.getElementById("site-menu");
  if (!header || !inner || !menuButton || !siteMenu) return;

  let lastHeaderWidth = 0;
  let isWide = false;
  let measureRaf = 0;

  function applyLayout(wide, forcePopoverCheck = false) {
    const wasOpen = !isWide && siteMenu.matches(":popover-open, .\\:popover-open");
    if (wide === isWide && !forcePopoverCheck) return;
    isWide = wide;

    header.classList.toggle("is-wide", wide);
    if (wide) {
      siteMenu.removeAttribute("popover");
      menuButton.setAttribute("aria-expanded", "false");
    } else {
      siteMenu.setAttribute("popover", "auto");
      if (wasOpen && typeof siteMenu.showPopover === "function") {
        try {
          siteMenu.showPopover();
        } catch {
          // Ignore if polyfill is still initializing
        }
      }
    }
  }

  function measureLayout() {
    const currentWidth = header.clientWidth;
    if (!isWide && currentWidth <= lastHeaderWidth && lastHeaderWidth > 0) {
      return;
    }
    lastHeaderWidth = currentWidth;

    header.classList.add("is-measuring");
    const prevWide = header.classList.contains("is-wide");
    const hadPopover = siteMenu.hasAttribute("popover");

    header.classList.add("is-wide");
    siteMenu.removeAttribute("popover");

    const fitsInline = currentWidth >= 900 && inner.scrollWidth <= inner.clientWidth;

    if (!prevWide) header.classList.remove("is-wide");
    if (hadPopover) siteMenu.setAttribute("popover", "auto");

    applyLayout(fitsInline, true);

    cancelAnimationFrame(measureRaf);
    measureRaf = requestAnimationFrame(() => {
      header.classList.remove("is-measuring");
    });
  }

  const ro = new ResizeObserver(() => measureLayout());
  ro.observe(header);
  ro.observe(siteMenu);
  measureLayout();

  siteMenu.addEventListener("toggle", (event) => {
    const open = event.newState === "open";
    menuButton.setAttribute("aria-expanded", open ? "true" : "false");
    menuButton.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
  });

  siteMenu.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-nav]");
    if (!trigger) return;
    if (!isWide && typeof siteMenu.hidePopover === "function") {
      try {
        siteMenu.hidePopover();
      } catch {
        // Ignore when already closed
      }
    }
  });
}

// ==========================================================================
// 2. Stage Page Switcher & Parallelogram Side Transition
// ==========================================================================

function initStageNavigation() {
  const VIEW_ORDER = ["home", "about", "skills", "projects", "contact"];
  const root = document.documentElement;
  const stage = document.getElementById("main-content");
  const sections = new Map(
    Array.from(document.querySelectorAll(".view-section")).map((el) => [el.dataset.view, el])
  );
  const projectsLiquid = document.getElementById("projects-liquid");
  const projectsLiquidPath = document.getElementById("projects-liquid-path");
  const previewPanel = document.getElementById("project-preview");
  const previewTitleEl = document.getElementById("preview-title");
  const previewLiveLinkEl = document.getElementById("preview-live-link");
  const previewUrlEl = document.getElementById("preview-url");
  const previewImageEl = document.getElementById("preview-image");
  const previewCloseBtn = document.getElementById("preview-close");
  const projectCards = Array.from(document.querySelectorAll("#view-projects .info-card[data-project]"));
  const skipLink = document.getElementById("skip-to-main");
  const navTriggers = Array.from(document.querySelectorAll("[data-nav]"));
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const desktopMediaQuery = window.matchMedia("(min-width: 56.25rem)");

  if (!stage || sections.size === 0) return;

  let currentView = root.dataset.page || "home";
  let currentSide = root.dataset.side || "right";
  let leaveTimer = 0;
  let liquidRaf = 0;
  let coverRaf = 0;
  let previewHideTimer = 0;
  let swapTimer = 0;
  let liquidProgress = 0;
  let coverProgress = 0;
  let activePreviewId = null;
  let lastTriggerBtn = null;
  let lockUntil = 0;

  // Base corner blob vertices (16 [x,y] pairs -> M 0 1000 L p0 C p1 p2 p3 C ... C p13 p14 p15 Z)
  const BLOB_POINTS = [
    842, 1000,
    832, 835, 885, 765, 962, 670,
    1006, 615, 1002, 535, 955, 498,
    900, 455, 710, 464, 642, 408,
    576, 354, 512, 202, 360, 202,
    210, 202, 95, 292, 0, 384,
  ];

  const DESKTOP_SLANT_Y = [
    1000,
    893, 787, 680,
    600, 520, 440,
    360, 280, 200,
    133, 67, 0,
    0, 0, 0
  ];

  function getDesktopFullCoords(side) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const tanTheta = Math.tan(8.5 * Math.PI / 180);
    const sign = side === "right" ? -1 : 1;
    const out = new Array(32);

    for (let i = 0; i <= 12; i++) {
      const y = DESKTOP_SLANT_Y[i];
      const yNorm = y / 1000;
      // Exact edge of the black parallelogram on desktop:
      const distPx = 0.52 * W + sign * (0.50 * H - yNorm * H) * tanTheta;
      const svgX = (distPx / (0.58 * W)) * 1000;
      // Add a 4 SVG unit (~3px) buffer to guarantee 100% complete coverage into the drop-shadow
      // with zero exposed black edge or corner:
      out[i * 2] = Math.max(0, Math.min(1000, svgX + 4));
      out[i * 2 + 1] = y;
    }

    const xTop = out[12 * 2];
    out[13 * 2] = xTop * (2 / 3);
    out[13 * 2 + 1] = 0;
    out[14 * 2] = xTop * (1 / 3);
    out[14 * 2 + 1] = 0;
    out[15 * 2] = 0;
    out[15 * 2 + 1] = 0;

    return out;
  }

  const FULL_POINTS = {
    mobileLeft: [
      1000, 1000,
      1000, 890, 1000, 780, 1000, 670,
      1000, 560, 1000, 450, 1000, 340,
      1000, 230, 1000, 120, 1000, 0,
      750, 0, 500, 0, 250, 0,
      160, 0, 80, 0, 0, 0,
    ],
    mobileRight: [
      1000, 1000,
      1000, 855, 1000, 710, 1000, 565,
      1000, 420, 1000, 275, 1000, 112,
      880, 96, 760, 81, 640, 67,
      500, 52, 360, 37, 220, 22,
      145, 15, 72, 8, 0, 2,
    ],
  };

  function buildPathFromCoords(coords) {
    const segs = [];
    for (let i = 2; i < coords.length; i += 6) {
      segs.push(
        `C ${coords[i].toFixed(1)} ${coords[i + 1].toFixed(1)}, ${coords[i + 2].toFixed(1)} ${coords[i + 3].toFixed(1)}, ${coords[i + 4].toFixed(1)} ${coords[i + 5].toFixed(1)}`
      );
    }
    return `M 0 1000 L ${coords[0].toFixed(1)} ${coords[1].toFixed(1)} ${segs.join(" ")} Z`;
  }

  function computeBlobCoords(p, scaleX, scaleY) {
    const t = Math.max(0, Math.min(1, p));
    if (t >= 0.9999) {
      const out = new Array(BLOB_POINTS.length);
      for (let i = 0; i < BLOB_POINTS.length; i += 2) {
        out[i] = BLOB_POINTS[i] * scaleX;
        out[i + 1] = 1000 - (1000 - BLOB_POINTS[i + 1]) * scaleY;
      }
      return out;
    }

    const swell = Math.sin(Math.PI * Math.pow(t, 1.1)) * (1 - t);
    const sx = Math.max(0.015, 1 - Math.pow(1 - t, 2.65) + 0.04 * swell);
    const sy = Math.max(
      0.015,
      1 - Math.pow(1 - t, 2.1) + 0.048 * Math.sin(Math.PI * Math.pow(t, 1.25)) * (1 - t)
    );
    const waveEnv = 68 * Math.sin(Math.PI * t) * (1 - 0.55 * t);

    const out = new Array(BLOB_POINTS.length);
    for (let i = 0; i < BLOB_POINTS.length; i += 2) {
      const rawX = BLOB_POINTS[i];
      const rawY = BLOB_POINTS[i + 1];
      const nx = Math.min(1, rawX / 220);
      const ny = Math.min(1, (1000 - rawY) / 180);
      const freeMask = 0.5 * (1 - Math.cos(Math.PI * nx)) * 0.5 * (1 - Math.cos(Math.PI * ny));
      const spatialU = (1000 - rawY) * 0.00075 + (1000 - rawX) * 0.00025;
      const phase = spatialU * 4.2 - t * 6.2;
      const amp = waveEnv * freeMask;
      const x = rawX > 0 ? (sx * rawX + Math.sin(phase) * amp) * scaleX : 0;
      const yBase = rawY < 1000 ? 1000 - sy * (1000 - rawY) + Math.cos(phase) * amp * 0.85 : 1000;
      const y = 1000 - (1000 - yBase) * scaleY;
      out[i] = x;
      out[i + 1] = y;
    }
    return out;
  }

  function renderLiquidShape(p, cover = coverProgress) {
    if (!projectsLiquidPath) return;
    const isDesktop = desktopMediaQuery.matches;
    const side = projectsLiquid?.dataset.liquidSide || currentSide;
    const scaleX = isDesktop ? 46.5 / 58 : side === "right" ? 0.9 : 0.88;
    const scaleY = !isDesktop && side === "right" ? 54 / 58 : 1;

    const blobCoords = computeBlobCoords(p, scaleX, scaleY);
    const c = Math.max(0, Math.min(1, cover));
    if (c <= 0.0001) {
      projectsLiquidPath.setAttribute("d", buildPathFromCoords(blobCoords));
      return;
    }

    const fullCoords = isDesktop
      ? getDesktopFullCoords(side)
      : FULL_POINTS[side === "right" ? "mobileRight" : "mobileLeft"];
    const e = 1 - Math.pow(1 - c, 2.35);
    const rippleEnv = 46 * Math.sin(Math.PI * c);

    const out = new Array(blobCoords.length);
    for (let i = 0; i < blobCoords.length; i += 2) {
      const idx = i / 2;
      const bx = blobCoords[i];
      const by = blobCoords[i + 1];
      const fx = fullCoords[i];
      const fy = fullCoords[i + 1];

      const isWallPoint = idx === 0 || idx === 15;
      const waveOffset = isWallPoint
        ? 0
        : rippleEnv * Math.sin(Math.PI * (idx / 15)) * Math.sin(idx * 0.9 - c * 4.8);

      let x = bx + (fx - bx) * e + waveOffset * 0.65;
      let y = by + (fy - by) * e - Math.abs(waveOffset) * 0.55;

      // Never cross outside the slanted black edge or top/bottom borders
      if (fx > 0) x = Math.max(0, Math.min(x, Math.max(bx, fx)));
      else x = 0;
      y = Math.max(Math.min(by, fy), Math.min(1000, y));

      out[i] = x;
      out[i + 1] = y;
    }

    projectsLiquidPath.setAttribute("d", buildPathFromCoords(out));
  }

  function animateCoverState(fromC, toC, durationMs) {
    cancelAnimationFrame(coverRaf);
    const startedAt = performance.now();

    function tick(now) {
      const raw = Math.min(1, (now - startedAt) / durationMs);
      coverProgress = fromC + (toC - fromC) * raw;
      renderLiquidShape(liquidProgress, coverProgress);
      if (raw < 1) {
        coverRaf = requestAnimationFrame(tick);
      } else {
        coverRaf = 0;
        coverProgress = toC;
        renderLiquidShape(liquidProgress, coverProgress);
      }
    }

    coverRaf = requestAnimationFrame(tick);
  }

  function animateProjectsLiquid(fromP, toP, { delayMs, durationMs, fadeInMs = 0, fadeOutMs = 0, endState, fromCover = coverProgress }) {
    cancelAnimationFrame(liquidRaf);
    cancelAnimationFrame(coverRaf);
    const startedAt = performance.now() + delayMs;

    function tick(now) {
      if (now < startedAt) {
        if (fadeInMs > 0) projectsLiquid.style.opacity = "0";
        liquidRaf = requestAnimationFrame(tick);
        return;
      }

      const raw = Math.min(1, (now - startedAt) / durationMs);
      const eased = toP > fromP ? raw : Math.pow(raw, 1.35);
      liquidProgress = fromP + (toP - fromP) * eased;
      if (toP === 0) {
        coverProgress = fromCover * (1 - eased);
      }
      renderLiquidShape(liquidProgress, coverProgress);

      if (fadeInMs > 0) {
        const elapsed = now - startedAt;
        if (elapsed < fadeInMs) {
          projectsLiquid.style.opacity = (elapsed / fadeInMs).toFixed(3);
        } else {
          projectsLiquid.style.removeProperty("opacity");
        }
      } else if (fadeOutMs > 0) {
        const remaining = durationMs - (now - startedAt);
        if (remaining <= fadeOutMs) {
          projectsLiquid.style.opacity = Math.max(0, remaining / fadeOutMs).toFixed(3);
        } else {
          projectsLiquid.style.opacity = "1";
        }
      }

      if (raw < 1) {
        liquidRaf = requestAnimationFrame(tick);
      } else {
        liquidRaf = 0;
        liquidProgress = toP;
        if (toP === 0) coverProgress = 0;
        renderLiquidShape(liquidProgress, coverProgress);
        projectsLiquid.style.removeProperty("opacity");
        projectsLiquid.dataset.liquidState = endState;
      }
    }

    liquidRaf = requestAnimationFrame(tick);
  }


  const laptopStage = document.getElementById("laptop-stage");
  const laptopDevice = document.getElementById("laptop-device");
  const laptopCameraLed = document.getElementById("laptop-camera-led");
  const laptopGlassReflection = document.getElementById("laptop-glass-reflection");
  const laptopScreenContent = document.getElementById("laptop-screen-content");
  const laptopUnderGlow = document.getElementById("laptop-under-glow");

  // Project Config & Theme Colors
  const PROJECT_CONFIG = {
    chat: {
      themeColor: "#3b82f6",
      glowColor: "rgba(59, 130, 246, 0.45)"
    },
    peekafuture: {
      themeColor: "#8b5cf6",
      glowColor: "rgba(139, 92, 246, 0.45)"
    },
    gallery: {
      themeColor: "#06b6d4",
      glowColor: "rgba(6, 182, 212, 0.45)"
    },
    parallax: {
      themeColor: "#10b981",
      glowColor: "rgba(16, 185, 129, 0.45)"
    },
    carousel3d: {
      themeColor: "#ec4899",
      glowColor: "rgba(236, 72, 153, 0.45)"
    }
  };

  const CHAT_CONTACTS = [
    { id: "sourabh", name: "Sourabh", status: "Online", online: true, initial: "S", gradient: "linear-gradient(135deg, #6366f1 0%, #a855f7 100%)" },
    { id: "priyanshu", name: "Priyanshu", status: "Online", online: true, initial: "P", gradient: "linear-gradient(135deg, #10b981 0%, #059669 100%)" },
    { id: "aman", name: "Aman", status: "Away", away: true, initial: "A", gradient: "linear-gradient(135deg, #f59e0b 0%, #d97706 100%)" },
    { id: "nikhil", name: "Nikhil", status: "Offline", initial: "N", gradient: "linear-gradient(135deg, #64748b 0%, #475569 100%)" },
    { id: "sakshi", name: "Sakshi", status: "Online", online: true, initial: "S", gradient: "linear-gradient(135deg, #ec4899 0%, #be185d 100%)" }
  ];

  let currentChatContact = CHAT_CONTACTS[0];
  let chatMessagesStore = [
    { id: 1, sender: "them", text: "Hey! Are you free now?", time: "10:42 AM" },
    { id: 2, sender: "me", text: "Yes, working on the new feature.", time: "10:43 AM" },
    { id: 3, sender: "them", text: "Looks great! \uD83D\uDD25", time: "10:44 AM" },
    { id: 4, sender: "me", text: "Let's deploy it today.", time: "10:45 AM" }
  ];

  let carousel3dAngle = 0;
  let carousel3dInterval = null;

  let laptopTargetX = 0;
  let laptopTargetY = 0;
  let laptopCurrentX = 0;
  let laptopCurrentY = 0;
  let isLaptopHovered = false;
  let laptopPhysicsRaf = 0;

  function updateLaptopPhysics() {
    if (reducedMotionQuery.matches) {
      if (laptopDevice) {
        laptopDevice.style.transform = "rotateY(0deg) rotateX(2.5deg)";
      }
      return;
    }

    laptopCurrentX += (laptopTargetX - laptopCurrentX) * 0.06;
    laptopCurrentY += (laptopTargetY - laptopCurrentY) * 0.06;

    const t = performance.now() * 0.001;
    let rotY, rotX, floatY, scale, reflectionPos;

    if (isLaptopHovered) {
      rotY = laptopCurrentX * 4.8;
      rotX = 2.5 - laptopCurrentY * 3.5;
      floatY = -6;
      scale = 1.025;
      reflectionPos = 50 + laptopCurrentX * 28;
    } else {
      rotY = Math.sin(t * 0.72) * 4.2;
      rotX = 2.5 + Math.cos(t * 0.6) * 1.5;
      floatY = Math.sin(t * 0.9) * 4.5;
      scale = 1;
      reflectionPos = 50 + Math.sin(t * 0.8) * 32;
    }

    if (laptopDevice) {
      laptopDevice.style.transform = "translateY(" + floatY.toFixed(2) + "px) rotateY(" + rotY.toFixed(2) + "deg) rotateX(" + rotX.toFixed(2) + "deg) scale(" + scale + ")";
    }

    if (laptopGlassReflection) {
      const p1 = Math.max(0, reflectionPos - 30);
      const p2 = Math.max(0, reflectionPos - 10);
      const p3 = Math.min(100, reflectionPos);
      const p4 = Math.min(100, reflectionPos + 10);
      const p5 = Math.min(100, reflectionPos + 30);
      laptopGlassReflection.style.background = "linear-gradient(115deg, transparent " + p1.toFixed(1) + "%, rgba(255, 255, 255, 0.08) " + p2.toFixed(1) + "%, rgba(255, 255, 255, 0.35) " + p3.toFixed(1) + "%, rgba(255, 255, 255, 0.08) " + p4.toFixed(1) + "%, transparent " + p5.toFixed(1) + "%)";
    }

    if (activePreviewId) {
      laptopPhysicsRaf = requestAnimationFrame(updateLaptopPhysics);
    }
  }

  function startLaptopPhysics() {
    cancelAnimationFrame(laptopPhysicsRaf);
    laptopPhysicsRaf = requestAnimationFrame(updateLaptopPhysics);
  }

  function stopLaptopPhysics() {
    cancelAnimationFrame(laptopPhysicsRaf);
  }

  if (laptopStage && laptopDevice) {
    laptopStage.addEventListener("mousemove", (e) => {
      const rect = laptopStage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = ((e.clientY - rect.top) / rect.height) * 2 - 1;
      laptopTargetX = Math.max(-1, Math.min(1, x));
      laptopTargetY = Math.max(-1, Math.min(1, y));
    });

    laptopStage.addEventListener("mouseenter", () => {
      isLaptopHovered = true;
    });

    laptopStage.addEventListener("mouseleave", () => {
      isLaptopHovered = false;
      laptopTargetX = 0;
      laptopTargetY = 0;
    });
  }

  function renderLaptopContent(projectId) {
    if (!laptopScreenContent) return;

    const conf = PROJECT_CONFIG[projectId] || PROJECT_CONFIG.peekafuture;
    if (laptopDevice) {
      laptopDevice.style.setProperty("--theme-color", conf.themeColor);
      laptopDevice.style.setProperty("--glow-color", conf.glowColor);
    }
    if (laptopCameraLed) {
      laptopCameraLed.style.backgroundColor = conf.themeColor;
      laptopCameraLed.style.boxShadow = "0 0 5px " + conf.themeColor;
    }

    if (projectId === "chat") {
      renderChatAppView();
    } else if (projectId === "peekafuture") {
      renderPeekafutureView();
    } else if (projectId === "gallery") {
      renderGalleryView();
    } else if (projectId === "parallax") {
      renderParallaxView();
    } else if (projectId === "carousel3d") {
      renderCarousel3dView();
    } else {
      renderPeekafutureView();
    }
  }

  function renderChatAppView() {
    laptopScreenContent.innerHTML = `
      <div class="preview-chat">
        <aside class="chat-sidebar" aria-label="Chats">
          <div class="chat-sidebar-header">
            <span class="chat-app-title">ChatApp</span>
            <span class="chat-online-pulse" title="Socket.IO Live"></span>
          </div>
          <div class="chat-search-wrap">
            <div class="chat-search-bar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              <span>Search...</span>
            </div>
          </div>
          <div class="chat-contacts-list" id="chat-contacts-container"></div>
        </aside>

        <section class="chat-main-area" aria-label="Conversation">
          <header class="chat-header">
            <div class="chat-header-user">
              <div class="chat-header-avatar" id="chat-header-avatar">${currentChatContact.initial}</div>
              <div class="chat-header-meta">
                <div class="chat-header-name" id="chat-header-name">${currentChatContact.name}</div>
                <div class="chat-header-sub" id="chat-header-sub"><span></span>${currentChatContact.status}</div>
              </div>
            </div>
            <div class="chat-header-actions">
              <button type="button" class="chat-icon-btn" title="Video Call"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg></button>
              <button type="button" class="chat-icon-btn" title="Voice Call"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg></button>
              <button type="button" class="chat-icon-btn" title="Options"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="1.5"></circle><circle cx="19" cy="12" r="1.5"></circle><circle cx="5" cy="12" r="1.5"></circle></svg></button>
            </div>
          </header>

          <div class="chat-messages-flow" id="chat-messages-flow"></div>

          <form class="chat-input-form" id="chat-form">
            <div class="chat-input-wrapper">
              <input type="text" id="chat-input-field" class="chat-text-input" placeholder="Type a message..." autocomplete="off">
              <button type="button" class="chat-emoji-btn" title="Insert Emoji">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
              </button>
            </div>
            <button type="submit" class="chat-send-btn" title="Send message">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path></svg>
            </button>
          </form>
        </section>
      </div>
    `;

    renderChatContacts();
    renderChatMessagesFlow();

    const form = document.getElementById("chat-form");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("chat-input-field");
      if (!input) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";

      chatMessagesStore.push({
        id: Date.now(),
        sender: "me",
        text: text,
        time: "Now"
      });
      renderChatMessagesFlow();

      setTimeout(() => {
        const replies = [
          "Sub-50ms Socket.IO sync is live on Render! \uD83D\uDE80",
          "Merged PR into main. Auth tokens active! \u2705",
          "Looking slick! 99.9% uptime verified \uD83D\uDD25",
          "Received! All 12 REST endpoints responding in 32ms \u26A1"
        ];
        const reply = replies[Math.floor(Math.random() * replies.length)];
        chatMessagesStore.push({
          id: Date.now() + 1,
          sender: "them",
          text: reply,
          time: "Now"
        });
        renderChatMessagesFlow();
      }, 650);
    });
  }

  function renderChatContacts() {
    const listEl = document.getElementById("chat-contacts-container");
    if (!listEl) return;
    listEl.innerHTML = CHAT_CONTACTS.map((c) => {
      const activeClass = c.id === currentChatContact.id ? "is-active" : "";
      const dotClass = c.online ? "chat-contact-dot--online" : c.away ? "chat-contact-dot--away" : "chat-contact-dot--offline";
      return `
        <div class="chat-contact-item ${activeClass}" data-contact-id="${c.id}">
          <div class="chat-avatar-wrap" style="background: ${c.gradient}">
            ${c.initial}
            <span class="chat-contact-dot ${dotClass}"></span>
          </div>
          <div class="chat-contact-info">
            <div class="chat-contact-name">${c.name}</div>
            <div class="chat-contact-status">${c.status}</div>
          </div>
        </div>
      `;
    }).join("");

    const items = listEl.querySelectorAll(".chat-contact-item");
    for (const item of items) {
      item.addEventListener("click", () => {
        const cId = item.dataset.contactId;
        const found = CHAT_CONTACTS.find((x) => x.id === cId);
        if (found) {
          currentChatContact = found;
          const nameEl = document.getElementById("chat-header-name");
          const avatarEl = document.getElementById("chat-header-avatar");
          const subEl = document.getElementById("chat-header-sub");
          if (nameEl) nameEl.textContent = found.name;
          if (avatarEl) {
            avatarEl.textContent = found.initial;
            avatarEl.style.background = found.gradient;
          }
          if (subEl) subEl.innerHTML = "<span></span>" + found.status;
          renderChatContacts();
        }
      });
    }
  }

  function renderChatMessagesFlow() {
    const flowEl = document.getElementById("chat-messages-flow");
    if (!flowEl) return;
    flowEl.innerHTML = chatMessagesStore.map((m) => {
      const isMe = m.sender === "me";
      const rowClass = isMe ? "chat-message-row chat-message-row--me" : "chat-message-row";
      const bubbleClass = isMe ? "chat-bubble chat-bubble--me" : "chat-bubble chat-bubble--them";
      return `
        <div class="${rowClass}">
          <div class="${bubbleClass}">
            <span>${m.text}</span>
          </div>
        </div>
      `;
    }).join("");
    flowEl.scrollTop = flowEl.scrollHeight;
  }

  function renderPeekafutureView() {
    laptopScreenContent.innerHTML = `
      <div class="preview-peekafuture">
        <div class="pf-topbar">
          <div class="pf-brand">Peekafuture &mdash; AI Career Platform</div>
          <span class="pf-badge-fastapi">FASTAPI + FIREBASE</span>
        </div>

        <div class="pf-main-grid">
          <div class="pf-score-card">
            <div class="pf-gauge-wrap">
              <svg class="pf-gauge-svg" viewBox="0 0 36 36">
                <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="rgba(255, 255, 255, 0.1)" stroke-width="3" />
                <path id="pf-gauge-progress" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#a78bfa" stroke-width="3.2" stroke-dasharray="94, 100" stroke-linecap="round" />
              </svg>
              <div class="pf-gauge-center">
                <span class="pf-gauge-num" id="pf-score-num">94%</span>
                <span class="pf-gauge-lbl">ATS SCORE</span>
              </div>
            </div>
            <div class="pf-score-meta">
              <h4>Target: Senior Full Stack Engineer</h4>
              <p>15 of 16 core competencies matched</p>
              <div class="pf-skills-chips">
                <span class="pf-chip">FastAPI</span>
                <span class="pf-chip">React</span>
                <span class="pf-chip">TypeScript</span>
                <span class="pf-chip">Firebase</span>
                <span class="pf-chip">Pydantic</span>
              </div>
            </div>
          </div>

          <div class="pf-telemetry-card">
            <div class="pf-log-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
              <span>FastAPI latency &lt; 25ms (sub-50ms target)</span>
            </div>
            <div class="pf-log-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
              <span>Pydantic v2 schemas strictly validated</span>
            </div>
            <div class="pf-log-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>
              <span>Firebase Auth session active (-30% latency)</span>
            </div>
          </div>
        </div>

        <div class="pf-action-row">
          <span>Target Job: AI &amp; Full Stack Platform Engineer</span>
          <button type="button" class="pf-btn-scan" id="pf-scan-btn">Simulate AI Scan &rarr;</button>
        </div>
      </div>
    `;

    const scanBtn = document.getElementById("pf-scan-btn");
    const gaugePath = document.getElementById("pf-gauge-progress");
    const scoreNum = document.getElementById("pf-score-num");

    scanBtn?.addEventListener("click", () => {
      if (!gaugePath || !scoreNum) return;
      gaugePath.style.transition = "none";
      gaugePath.setAttribute("stroke-dasharray", "0, 100");
      scoreNum.textContent = "0%";
      void gaugePath.offsetWidth;
      gaugePath.style.transition = "stroke-dasharray 1s cubic-bezier(0.16, 1, 0.3, 1)";
      gaugePath.setAttribute("stroke-dasharray", "98, 100");
      let count = 0;
      const counter = setInterval(() => {
        count += 2;
        if (count >= 98) {
          count = 98;
          clearInterval(counter);
        }
        scoreNum.textContent = count + "%";
      }, 20);
    });
  }

  function renderGalleryView() {
    laptopScreenContent.innerHTML = `
      <div class="preview-gallery">
        <div class="gal-header">
          <div class="gal-title">My Gallery &mdash; Visual Showcase</div>
          <div class="gal-filter-pills">
            <button type="button" class="gal-pill is-active" data-filter="all">All</button>
            <button type="button" class="gal-pill" data-filter="ui">UI/UX</button>
            <button type="button" class="gal-pill" data-filter="3d">3D Art</button>
            <button type="button" class="gal-pill" data-filter="code">Code</button>
          </div>
        </div>
        <div class="gal-grid" id="gal-grid">
          <div class="gal-card" data-cat="3d">
            <div class="gal-card-thumb gal-card-thumb--1">&#x1F30C;</div>
            <div class="gal-card-info">
              <span class="gal-card-name">Cosmic Voyage 3D</span>
              <span class="gal-card-likes">&#x2605; 142</span>
            </div>
          </div>
          <div class="gal-card" data-cat="ui">
            <div class="gal-card-thumb gal-card-thumb--2">&#x1F4F1;</div>
            <div class="gal-card-info">
              <span class="gal-card-name">Minimalist UI Kit</span>
              <span class="gal-card-likes">&#x2605; 98</span>
            </div>
          </div>
          <div class="gal-card" data-cat="3d">
            <div class="gal-card-thumb gal-card-thumb--3">&#x1F52E;</div>
            <div class="gal-card-info">
              <span class="gal-card-name">Glass Sphere Physics</span>
              <span class="gal-card-likes">&#x2605; 210</span>
            </div>
          </div>
          <div class="gal-card" data-cat="code">
            <div class="gal-card-thumb gal-card-thumb--4">&#x26A1;</div>
            <div class="gal-card-info">
              <span class="gal-card-name">Shader Animations</span>
              <span class="gal-card-likes">&#x2605; 175</span>
            </div>
          </div>
        </div>
      </div>
    `;

    const pills = laptopScreenContent.querySelectorAll(".gal-pill");
    const cards = laptopScreenContent.querySelectorAll(".gal-card");

    for (const pill of pills) {
      pill.addEventListener("click", () => {
        pills.forEach((p) => p.classList.remove("is-active"));
        pill.classList.add("is-active");
        const filter = pill.dataset.filter;
        cards.forEach((card) => {
          const match = filter === "all" || card.dataset.cat === filter;
          card.style.display = match ? "flex" : "none";
        });
      });
    }

    for (const card of cards) {
      card.addEventListener("click", () => {
        const likesEl = card.querySelector(".gal-card-likes");
        if (likesEl) {
          const current = parseInt(likesEl.textContent.replace(/[^0-9]/g, ""), 10) || 100;
          likesEl.textContent = "\u2605 " + (current + 1);
        }
      });
    }
  }

  function renderParallaxView() {
    laptopScreenContent.innerHTML = `
      <div class="preview-parallax" id="par-container">
        <div class="par-controls">
          <span class="par-label">Adventure Time Parallax</span>
          <span class="par-label" style="background: rgba(0,0,0,0.5);">Depth Parallax Active</span>
        </div>
        <div class="par-cloud par-cloud--1" id="par-cloud-1"></div>
        <div class="par-cloud par-cloud--2" id="par-cloud-2"></div>
        <div class="par-mountains" id="par-mountains"></div>
        <div class="par-foreground" id="par-fg">
          <div class="par-character-badge">Finn &amp; Jake &mdash; Land of Ooo</div>
        </div>
      </div>
    `;

    const container = document.getElementById("par-container");
    const cloud1 = document.getElementById("par-cloud-1");
    const cloud2 = document.getElementById("par-cloud-2");
    const mountains = document.getElementById("par-mountains");
    const fg = document.getElementById("par-fg");

    container?.addEventListener("mousemove", (e) => {
      const rect = container.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;

      if (cloud1) cloud1.style.transform = "translate(" + (nx * 8).toFixed(1) + "px, " + (ny * 4).toFixed(1) + "px)";
      if (cloud2) cloud2.style.transform = "translate(" + (nx * -10).toFixed(1) + "px, " + (ny * 5).toFixed(1) + "px)";
      if (mountains) mountains.style.transform = "translate(" + (nx * 14).toFixed(1) + "px, " + (ny * 6).toFixed(1) + "px)";
      if (fg) fg.style.transform = "translate(" + (nx * -18).toFixed(1) + "px, " + (ny * -4).toFixed(1) + "px)";
    });

    container?.addEventListener("mouseleave", () => {
      [cloud1, cloud2, mountains, fg].forEach((el) => {
        if (el) el.style.transform = "translate(0, 0)";
      });
    });
  }

  function renderCarousel3dView() {
    carousel3dAngle = 0;
    clearInterval(carousel3dInterval);

    laptopScreenContent.innerHTML = `
      <div class="preview-carousel3d">
        <div class="c3d-title-bar">
          <span>3D ROTATING CAROUSEL</span>
          <span id="c3d-deg-lbl">Angle: 0&deg;</span>
        </div>

        <div class="c3d-ring-stage" id="c3d-ring">
          <div class="c3d-card" style="transform: rotateY(0deg) translateZ(80px);">
            <div class="c3d-card-num">01</div>
            <div class="c3d-card-label">Pure CSS 3D Depth</div>
          </div>
          <div class="c3d-card" style="transform: rotateY(72deg) translateZ(80px);">
            <div class="c3d-card-num">02</div>
            <div class="c3d-card-label">Matrix Perspective</div>
          </div>
          <div class="c3d-card" style="transform: rotateY(144deg) translateZ(80px);">
            <div class="c3d-card-num">03</div>
            <div class="c3d-card-label">Hardware Acceleration</div>
          </div>
          <div class="c3d-card" style="transform: rotateY(216deg) translateZ(80px);">
            <div class="c3d-card-num">04</div>
            <div class="c3d-card-label">Keyframe Fluidity</div>
          </div>
          <div class="c3d-card" style="transform: rotateY(288deg) translateZ(80px);">
            <div class="c3d-card-num">05</div>
            <div class="c3d-card-label">Responsive Cylinder</div>
          </div>
        </div>

        <div class="c3d-controls">
          <button type="button" class="c3d-btn" id="c3d-prev-btn">&larr; Prev</button>
          <button type="button" class="c3d-btn" id="c3d-auto-btn">Auto-Spin</button>
          <button type="button" class="c3d-btn" id="c3d-next-btn">Next &rarr;</button>
        </div>
      </div>
    `;

    const ring = document.getElementById("c3d-ring");
    const degLbl = document.getElementById("c3d-deg-lbl");
    const prevBtn = document.getElementById("c3d-prev-btn");
    const nextBtn = document.getElementById("c3d-next-btn");
    const autoBtn = document.getElementById("c3d-auto-btn");

    function rotateRing(delta) {
      carousel3dAngle += delta;
      if (ring) ring.style.transform = "rotateY(" + carousel3dAngle + "deg)";
      if (degLbl) degLbl.innerHTML = "Angle: " + ((carousel3dAngle % 360 + 360) % 360) + "&deg;";
    }

    prevBtn?.addEventListener("click", () => rotateRing(-72));
    nextBtn?.addEventListener("click", () => rotateRing(72));

    let autoSpin = false;
    autoBtn?.addEventListener("click", () => {
      autoSpin = !autoSpin;
      if (autoSpin) {
        autoBtn.textContent = "Stop Spin";
        carousel3dInterval = setInterval(() => rotateRing(72), 1600);
      } else {
        autoBtn.textContent = "Auto-Spin";
        clearInterval(carousel3dInterval);
      }
    });
  }


  function closeProjectPreview({ restoreFocus = false, drainLiquid = false } = {}) {
    const returnTarget = restoreFocus ? lastTriggerBtn : null;
    activePreviewId = null;
    root.removeAttribute("data-project-preview");

    stopLaptopPhysics();
    clearInterval(carousel3dInterval);

    for (const card of projectCards) {
      card.classList.remove("is-selected");
      const btn = card.querySelector(".project-select-btn");
      btn?.setAttribute("aria-pressed", "false");
    }

    clearTimeout(previewHideTimer);
    clearTimeout(swapTimer);

    if (previewPanel) {
      previewPanel.classList.remove("is-visible", "is-swapping");
      if (reducedMotionQuery.matches || drainLiquid) {
        previewPanel.hidden = true;
      } else {
        previewHideTimer = setTimeout(() => {
          if (!activePreviewId) {
            previewPanel.hidden = true;
          }
        }, 280);
      }
    }

    if (!drainLiquid && currentView === "projects") {
      if (reducedMotionQuery.matches) {
        coverProgress = 0;
        renderLiquidShape(liquidProgress, 0);
      } else {
        animateCoverState(coverProgress, 0, 560);
      }
    }

    if (returnTarget && typeof returnTarget.focus === "function") {
      requestAnimationFrame(() => returnTarget.focus({ preventScroll: true }));
    }
  }

  function openProjectPreview(card) {
    if (!card || !previewPanel) return;
    const projectId = card.dataset.project;
    if (!projectId) return;

    if (activePreviewId === projectId) {
      closeProjectPreview({ restoreFocus: false });
      return;
    }

    const wasAlreadyOpen = Boolean(activePreviewId);
    activePreviewId = projectId;
    root.dataset.projectPreview = projectId;

    for (const item of projectCards) {
      const selected = item === card;
      item.classList.toggle("is-selected", selected);
      item.querySelector(".project-select-btn")?.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    lastTriggerBtn = card.querySelector(".project-select-btn");

    const title = card.querySelector(".project-select-btn")?.textContent?.trim() || "";
    const cardLink = card.querySelector("a.card-link");
    const previewSrc = card.dataset.previewSrc || "";
    const previewUrl = card.dataset.previewUrl || "";
    const actionLabel = card.dataset.previewLabel || "Open Live Site";

    const updateContent = () => {
      if (previewTitleEl) previewTitleEl.textContent = title;
      if (previewLiveLinkEl && cardLink) {
        previewLiveLinkEl.href = cardLink.href;
        previewLiveLinkEl.textContent = `${actionLabel} \u2192`;
      }
      if (previewUrlEl) previewUrlEl.textContent = previewUrl;
      if (previewImageEl && previewSrc) {
        previewImageEl.src = previewSrc;
        previewImageEl.alt = `Preview of ${title}`;
      }
      renderLaptopContent(projectId);
    };

    clearTimeout(previewHideTimer);
    clearTimeout(swapTimer);

    if (wasAlreadyOpen && !reducedMotionQuery.matches) {
      previewPanel.classList.add("is-swapping");
      swapTimer = setTimeout(() => {
        updateContent();
        previewPanel.classList.remove("is-swapping");
      }, 110);
    } else {
      updateContent();
    }

    previewPanel.hidden = false;
    void previewPanel.offsetWidth;
    previewPanel.classList.add("is-visible");
    startLaptopPhysics();

    // Expand yellow shape to flood the entire black parallelogram area smoothly
    liquidProgress = 1;
    if (reducedMotionQuery.matches) {
      coverProgress = 1;
      renderLiquidShape(1, 1);
    } else if (!wasAlreadyOpen || coverProgress < 0.99) {
      animateCoverState(coverProgress, 1, 660);
    }
  }

  for (const card of projectCards) {
    const btn = card.querySelector(".project-select-btn");
    btn?.addEventListener("click", () => {
      if (currentView === "projects") {
        openProjectPreview(card);
      }
    });
  }

  previewCloseBtn?.addEventListener("click", () => {
    closeProjectPreview({ restoreFocus: true });
  });

  desktopMediaQuery.addEventListener("change", () => {
    if (currentView === "projects") {
      renderLiquidShape(liquidProgress, coverProgress);
    }
  });

  window.addEventListener("resize", () => {
    if (currentView === "projects") {
      renderLiquidShape(liquidProgress, coverProgress);
    }
  });

  function syncProjectsLiquid(oldView, nextView, side) {
    if (!projectsLiquid) return;
    cancelAnimationFrame(liquidRaf);
    cancelAnimationFrame(coverRaf);

    if (nextView === "projects") {
      coverProgress = 0;
      projectsLiquid.dataset.liquidSide = side;
      if (reducedMotionQuery.matches) {
        liquidProgress = 1;
        renderLiquidShape(1, 0);
        projectsLiquid.style.removeProperty("opacity");
        projectsLiquid.dataset.liquidState = "active";
      } else {
        liquidProgress = 0;
        renderLiquidShape(0, 0);
        projectsLiquid.style.opacity = "0";
        projectsLiquid.dataset.liquidState = "active";
        animateProjectsLiquid(0, 1, {
          delayMs: 580,
          durationMs: 1120,
          fadeInMs: 180,
          endState: "active",
        });
      }
      return;
    }

    if (oldView === "projects") {
      const startCover = coverProgress;
      closeProjectPreview({ restoreFocus: false, drainLiquid: true });
      if (reducedMotionQuery.matches) {
        liquidProgress = 0;
        coverProgress = 0;
        renderLiquidShape(0, 0);
        projectsLiquid.style.removeProperty("opacity");
        projectsLiquid.dataset.liquidState = "idle";
      } else {
        // Keep data-liquid-side locked to the outgoing corner while draining smoothly back into it
        projectsLiquid.dataset.liquidState = "leaving";
        animateProjectsLiquid(liquidProgress, 0, {
          delayMs: 0,
          durationMs: 480,
          fadeOutMs: 180,
          endState: "idle",
          fromCover: startCover,
        });
      }
      return;
    }

    liquidProgress = 0;
    coverProgress = 0;
    projectsLiquid.style.removeProperty("opacity");
    projectsLiquid.dataset.liquidState = "idle";
  }

  function syncChrome(viewId) {
    for (const el of navTriggers) {
      if (el.dataset.nav === viewId) {
        el.setAttribute("aria-current", "page");
      } else {
        el.removeAttribute("aria-current");
      }
    }

    const activeSection = sections.get(viewId);
    const activeHeading = activeSection?.querySelector("h1[id]");
    if (skipLink && activeHeading) {
      skipLink.href = `#${activeHeading.id}`;
    }
    if (activeSection?.dataset.title) {
      document.title = activeSection.dataset.title;
    }
  }

  function switchToView(nextId, { focusHeading = false, updateHash = true } = {}) {
    if (!sections.has(nextId) || nextId === currentView) return;

    const oldView = currentView;
    const oldSection = sections.get(oldView);
    const newSection = sections.get(nextId);
    const oldIndex = VIEW_ORDER.indexOf(oldView);
    const nextIndex = VIEW_ORDER.indexOf(nextId);
    const direction = nextIndex >= oldIndex ? "forward" : "backward";

    currentSide = currentSide === "right" ? "left" : "right";
    currentView = nextId;

    root.dataset.page = nextId;
    root.dataset.side = currentSide;
    root.dataset.dir = direction;

    syncProjectsLiquid(oldView, nextId, currentSide);

    clearTimeout(leaveTimer);
    for (const [id, section] of sections) {
      if (id !== nextId && id !== oldSection?.dataset.view) {
        section.classList.remove("is-active", "is-leaving");
        section.inert = true;
        section.hidden = true;
      }
    }

    const focusWasInOld = oldSection?.contains(document.activeElement);

    if (oldSection) {
      oldSection.classList.remove("is-active");
      oldSection.inert = true;
      if (reducedMotionQuery.matches) {
        oldSection.classList.remove("is-leaving");
        oldSection.hidden = true;
      } else {
        oldSection.classList.add("is-leaving");
        leaveTimer = setTimeout(() => {
          oldSection.classList.remove("is-leaving");
          oldSection.hidden = true;
        }, 660);
      }
    }

    newSection.dataset.viewSide = currentSide;
    newSection.hidden = false;
    newSection.inert = false;
    newSection.classList.remove("is-leaving");
    if (reducedMotionQuery.matches) {
      newSection.classList.add("is-active");
    } else {
      void newSection.offsetWidth;
      newSection.classList.add("is-active");
    }

    syncChrome(nextId);

    if (updateHash && window.location.hash !== `#${nextId}`) {
      history.replaceState(null, "", `#${nextId}`);
    }

    if (focusHeading || focusWasInOld) {
      const heading = newSection.querySelector("h1[tabindex]");
      requestAnimationFrame(() => {
        heading?.focus({ preventScroll: true });
      });
    }
  }

  function stepView(delta, options = {}) {
    const currentIndex = VIEW_ORDER.indexOf(currentView);
    const targetIndex = Math.max(0, Math.min(VIEW_ORDER.length - 1, currentIndex + delta));
    if (targetIndex === currentIndex) return;
    switchToView(VIEW_ORDER[targetIndex], options);
  }

  // Click navigation across header logo and nav menu buttons
  document.addEventListener("click", (event) => {
    const navBtn = event.target.closest("[data-nav]");
    if (!navBtn) return;
    lockUntil = performance.now() + 700;
    switchToView(navBtn.dataset.nav, { focusHeading: true });
  });

  // Mouse wheel / trackpad gesture view switching (no document scrollbar)
  let wheelAccum = 0;
  let wheelResetTimer = 0;

  window.addEventListener(
    "wheel",
    (event) => {
      if (event.ctrlKey || Math.abs(event.deltaY) < 2) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

      const activeMenu = document.getElementById("site-menu");
      if (activeMenu?.matches(":popover-open, .\\:popover-open")) return;

      const pane = event.target.closest?.(".pane");
      if (pane && pane.scrollHeight > pane.clientHeight + 2) {
        const atTop = pane.scrollTop <= 1;
        const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2;
        if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom)) {
          return;
        }
      }

      const now = performance.now();
      if (now < lockUntil) return;

      wheelAccum += event.deltaY;
      clearTimeout(wheelResetTimer);
      wheelResetTimer = setTimeout(() => {
        wheelAccum = 0;
      }, 150);

      if (Math.abs(wheelAccum) >= 35) {
        const delta = wheelAccum > 0 ? 1 : -1;
        wheelAccum = 0;
        lockUntil = now + 1850;
        stepView(delta, { focusHeading: false });
      }
    },
    { passive: true }
  );

  // Touch vertical swipe view switching (respects scrollable inner panes & form controls)
  let touchStartY = 0;
  let touchStartX = 0;
  let touchPane = null;
  let touchPaneStartTop = 0;

  stage.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) return;
      touchStartY = event.touches[0].clientY;
      touchStartX = event.touches[0].clientX;
      touchPane = event.target.closest?.(".pane") || null;
      touchPaneStartTop = touchPane ? touchPane.scrollTop : 0;
    },
    { passive: true }
  );

  stage.addEventListener(
    "touchend",
    (event) => {
      if (event.changedTouches.length !== 1) return;
      const dy = event.changedTouches[0].clientY - touchStartY;
      const dx = event.changedTouches[0].clientX - touchStartX;

      if (Math.abs(dy) < 48 || Math.abs(dy) <= Math.abs(dx) * 1.25) return;
      if (touchPane && Math.abs(touchPane.scrollTop - touchPaneStartTop) > 4) return;
      if (event.target.closest?.("input, textarea")) return;

      const now = performance.now();
      if (now < lockUntil) return;
      lockUntil = now + 1850;

      stepView(dy < 0 ? 1 : -1, { focusHeading: false });
    },
    { passive: true }
  );

  // Keyboard PageUp/PageDown (and ArrowUp/Down when not inside form controls or overflowing panes)
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && currentView === "projects" && activePreviewId) {
      event.preventDefault();
      closeProjectPreview({ restoreFocus: true });
      return;
    }
    if (event.target.closest?.("input, textarea, select")) return;

    if (event.key === "PageDown") {
      event.preventDefault();
      stepView(1, { focusHeading: true });
    } else if (event.key === "PageUp") {
      event.preventDefault();
      stepView(-1, { focusHeading: true });
    } else if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      !event.target.closest?.("button, a, .site-menu")
    ) {
      event.preventDefault();
      stepView(event.key === "ArrowDown" ? 1 : -1, { focusHeading: true });
    }
  });

  // Deep link / URL hash support on load & hashchange
  const normalizeHash = (raw) => {
    const clean = raw.replace(/^#/, "");
    return clean === "portfolio" ? "projects" : clean;
  };

  const initialHash = normalizeHash(window.location.hash);
  if (VIEW_ORDER.includes(initialHash) && initialHash !== "home") {
    switchToView(initialHash, { focusHeading: false, updateHash: true });
  } else {
    syncChrome("home");
  }

  window.addEventListener("hashchange", () => {
    const hashView = normalizeHash(window.location.hash);
    if (VIEW_ORDER.includes(hashView)) {
      switchToView(hashView, { focusHeading: true, updateHash: false });
    }
  });
}

// ==========================================================================
// 3. Contact Form Validation & Accessible ARIA Sync
// ==========================================================================

function initContactForm() {
  const form = document.getElementById("contact-form");
  const statusEl = document.getElementById("contact-status");
  if (!form || !statusEl) return;

  const controls = Array.from(form.querySelectorAll("input, textarea"));
  const dirtyState = new WeakMap();
  const announced = new WeakSet();

  const announcer = document.createElement("div");
  announcer.setAttribute("aria-live", "polite");
  announcer.className = "visually-hidden";
  document.body.appendChild(announcer);
  let announceTimer;
  let announcedField;

  const linkError = (el, shown) => {
    const errorId = el.dataset.error;
    if (!errorId) return;
    const ids = (el.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) el.setAttribute("aria-describedby", ids.join(" "));
    else el.removeAttribute("aria-describedby");
  };

  const announceError = (el) => {
    const errorEl = document.getElementById(el.dataset.error);
    if (!errorEl) return;
    const labelText = el.labels?.[0]?.textContent?.replace(/\*/g, "").trim() || "";
    const msgText = errorEl.textContent.replace(/^!\s*/, "").trim();
    clearTimeout(announceTimer);
    announcer.textContent = "";
    announcedField = el;
    announceTimer = setTimeout(() => {
      announcer.textContent = labelText ? `${labelText}: ${msgText}` : msgText;
    }, 500);
  };

  const updateFieldState = (el, shouldAnnounce = false) => {
    const isValid = el.validity.valid;
    el.classList.toggle("user-invalid-fallback", !isValid);
    el.classList.toggle("user-valid-fallback", isValid && el.value.trim().length > 0);
    el.setAttribute("aria-invalid", isValid ? "false" : "true");
    linkError(el, !isValid);

    if (!isValid && shouldAnnounce && !announced.has(el)) {
      announceError(el);
      announced.add(el);
    } else if (isValid) {
      announced.delete(el);
      if (announcedField === el) {
        clearTimeout(announceTimer);
        announcer.textContent = "";
      }
    }
  };

  for (const control of controls) {
    control.setAttribute("aria-invalid", "false");
  }

  form.addEventListener("input", (event) => {
    const el = event.target;
    if (!controls.includes(el)) return;
    const state = dirtyState.get(el) || { hasInteracted: false, hasBlurred: false };
    state.hasInteracted = true;
    dirtyState.set(el, state);
    if (state.hasBlurred) {
      updateFieldState(el, false);
    }
  });

  form.addEventListener(
    "blur",
    (event) => {
      const el = event.target;
      if (!controls.includes(el)) return;
      const state = dirtyState.get(el) || { hasInteracted: false, hasBlurred: false };
      state.hasBlurred = true;
      dirtyState.set(el, state);
      if (state.hasInteracted) {
        updateFieldState(el, true);
      }
    },
    true
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    statusEl.hidden = true;

    let firstInvalid = null;
    for (const control of controls) {
      dirtyState.set(control, { hasInteracted: true, hasBlurred: true });
      if (!control.validity.valid) {
        announced.add(control);
        updateFieldState(control, false);
        if (!firstInvalid) firstInvalid = control;
      } else {
        updateFieldState(control, false);
      }
    }

    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    const data = new FormData(form);
    const senderName = String(data.get("name") || "").trim();
    const senderEmail = String(data.get("email") || "").trim();
    const senderMessage = String(data.get("message") || "").trim();

    const mailSubject = encodeURIComponent(`Portfolio Inquiry from ${senderName}`);
    const bodyLines = [`Name: ${senderName}`, `Email: ${senderEmail}`, "", senderMessage].join("\n");
    const mailtoHref = `mailto:jayeshanand160@gmail.com?subject=${mailSubject}&body=${encodeURIComponent(bodyLines)}`;

    statusEl.replaceChildren();
    const p = document.createElement("p");
    p.style.margin = "0";
    p.textContent = `Thanks, ${senderName}! Your message is validated and ready to send to jayeshanand160@gmail.com.`;

    const actions = document.createElement("div");
    actions.className = "contact-status-actions";

    const mailLink = document.createElement("a");
    mailLink.className = "pipe-btn pipe-btn--light pipe-btn--sm";
    mailLink.href = mailtoHref;
    mailLink.textContent = "OPEN EMAIL DRAFT";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "pipe-btn pipe-btn--light pipe-btn--sm";
    copyBtn.textContent = "COPY EMAIL";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText("jayeshanand160@gmail.com");
        copyBtn.textContent = "COPIED!";
      } catch {
        copyBtn.textContent = "jayeshanand160@gmail.com";
      }
    });

    actions.append(mailLink, copyBtn);
    statusEl.append(p, actions);
    statusEl.hidden = false;

    form.reset();
    for (const control of controls) {
      dirtyState.delete(control);
      announced.delete(control);
      control.classList.remove("user-invalid-fallback", "user-valid-fallback");
      control.setAttribute("aria-invalid", "false");
      linkError(control, false);
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initNavbar();
  initStageNavigation();
  initContactForm();
});
