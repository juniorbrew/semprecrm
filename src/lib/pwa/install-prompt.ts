// Chrome fires `beforeinstallprompt` once per page load, as soon as it
// decides the page is installable — usually on /login, long before the
// dashboard (and its install banner) mounts. The root layout runs this
// boot script before hydration so the event is parked on `window` and
// the banner can replay it whenever it appears. Kept dependency-free:
// it ships as a single inline <script>.

export const INSTALL_PROMPT_KEY = '__semprecrmInstallPrompt';
export const INSTALL_PROMPT_EVENT = 'semprecrm:install-prompt';

export const INSTALL_PROMPT_BOOT_SCRIPT = `
(function(){
  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    window[${JSON.stringify(INSTALL_PROMPT_KEY)}] = e;
    window.dispatchEvent(new Event(${JSON.stringify(INSTALL_PROMPT_EVENT)}));
  });
  window.addEventListener('appinstalled', function(){
    window[${JSON.stringify(INSTALL_PROMPT_KEY)}] = null;
    window.dispatchEvent(new Event(${JSON.stringify(INSTALL_PROMPT_EVENT)}));
  });
})();
`;
