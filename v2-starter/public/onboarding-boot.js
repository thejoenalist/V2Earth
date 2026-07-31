/**
 * Tiny classic-script bootstrap — must NOT be a module.
 *
 * main.js pulls in Cesium and a large dependency graph; until that module
 * finishes evaluating, nothing in it has run — including the Explore-the-Earth
 * click handler. Users who click during that load window get a dead button.
 *
 * This file is served from /onboarding-boot.js (public/), loads as a blocking
 * classic script before the module, and dismisses onboarding immediately.
 * Consent reveal listens for the CustomEvent from main.js / ConsentBanner.
 * No window.* globals (CLAUDE.md).
 */
(function () {
  var btn = document.getElementById('onboarding-start');
  var overlay = document.getElementById('onboarding');
  if (!btn || !overlay) return;

  btn.addEventListener('click', function () {
    overlay.classList.add('hidden');
    document.dispatchEvent(new CustomEvent('earthsim:onboarding-done'));
  });
})();
