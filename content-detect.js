// Exposed — Content Script (MAIN world)
// Monkey-patches fingerprinting and geolocation APIs to detect usage

(function () {
  "use strict";

  const CHANNEL = "__exposed_detection__";

  function notify(type, evidence) {
    window.postMessage({ channel: CHANNEL, type, evidence }, "*");
  }

  // --- Canvas fingerprinting ---
  // Any call to toDataURL/toBlob is suspicious — legitimate use is rare outside
  // fingerprinting. Deduplication in the bridge prevents repeat noise.
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    notify("fingerprint-detected", "your device identified via canvas");
    return origToDataURL.apply(this, args);
  };

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (...args) {
    notify("fingerprint-detected", "your device identified via canvas");
    return origToBlob.apply(this, args);
  };

  // --- WebGL fingerprinting ---
  function patchWebGL(proto) {
    if (!proto) return;

    const origGetParam = proto.getParameter;
    if (origGetParam) {
      proto.getParameter = function (pname) {
        // RENDERER, VENDOR, UNMASKED_RENDERER, UNMASKED_VENDOR
        const suspectParams = [0x1f01, 0x1f00, 0x9245, 0x9246];
        if (suspectParams.includes(pname)) {
          notify("fingerprint-detected", "your device identified via WebGL");
        }
        return origGetParam.apply(this, arguments);
      };
    }

    const origGetExtension = proto.getExtension;
    if (origGetExtension) {
      proto.getExtension = function (name) {
        if (name === "WEBGL_debug_renderer_info") {
          notify(
            "fingerprint-detected",
            "your device identified via WebGL"
          );
        }
        return origGetExtension.apply(this, arguments);
      };
    }
  }

  try {
    patchWebGL(WebGLRenderingContext.prototype);
  } catch (e) {}
  try {
    patchWebGL(WebGL2RenderingContext.prototype);
  } catch (e) {}

  // --- AudioContext fingerprinting ---
  // Only hook OfflineAudioContext — it doesn't produce audible sound and is
  // the specific API used for audio fingerprinting.  Regular AudioContext is
  // used legitimately by music players, games, etc. and would cause false positives.
  try {
    const origOfflineCreateOscillator =
      OfflineAudioContext.prototype.createOscillator;
    let offlineNotified = false;
    OfflineAudioContext.prototype.createOscillator = function (...args) {
      if (!offlineNotified) {
        offlineNotified = true;
        notify(
          "fingerprint-detected",
          "your device identified via audio"
        );
      }
      return origOfflineCreateOscillator.apply(this, args);
    };
  } catch (e) {}

  // --- Geolocation ---
  if (navigator.geolocation) {
    const origGetCurrentPosition =
      navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = function (
      success,
      error,
      options
    ) {
      notify("geolocation-detected", "this page requested your GPS location");
      return origGetCurrentPosition(success, error, options);
    };

    const origWatchPosition = navigator.geolocation.watchPosition.bind(
      navigator.geolocation
    );
    navigator.geolocation.watchPosition = function (
      success,
      error,
      options
    ) {
      notify("geolocation-detected", "this page is tracking your GPS location");
      return origWatchPosition(success, error, options);
    };
  }
})();
