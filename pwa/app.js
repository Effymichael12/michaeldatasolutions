// ===================== CONFIG =====================
//
// Paste the deployed pwa_control_backend.gs web app URL here (Deploy > New
// deployment > Web app > copy the /exec URL). Everything in this file talks
// to that single endpoint.
var API_BASE_URL = "https://script.google.com/macros/s/AKfycby08KU3XA1es4MlpdDJYOf8yj8jHKUlUmz-17QN4_UEmAf5sDwnGfg_CEdTeNnWGvAR/exec";

// Must match OTP_EXPIRY_MINUTES in pwa_control_backend.gs (currently 1
// minute) — only used to drive the on-screen countdown, the backend is the
// real source of truth for when a code actually expires.
var OTP_EXPIRY_SECONDS = 60;

var STORAGE_KEYS = {
  token: "mds_session_token",
  email: "mds_session_email",
  expiresAt: "mds_session_expires_at",
  lastEmail: "mds_last_email",
};

// ===================== STORAGE HELPERS =====================
// Wrapped in try/catch — Safari private mode and some locked-down browser
// settings throw on localStorage access rather than just no-op'ing.

function storageGet_(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function storageSet_(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* ignore — session just won't persist across app reloads */
  }
}

function storageRemove_(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    /* ignore */
  }
}

function saveSession_(token, email, expiresAtIso) {
  storageSet_(STORAGE_KEYS.token, token);
  storageSet_(STORAGE_KEYS.email, email);
  storageSet_(STORAGE_KEYS.expiresAt, expiresAtIso);
  storageSet_(STORAGE_KEYS.lastEmail, email);
}

function clearSession_() {
  storageRemove_(STORAGE_KEYS.token);
  storageRemove_(STORAGE_KEYS.email);
  storageRemove_(STORAGE_KEYS.expiresAt);
}

function getStoredSession_() {
  var token = storageGet_(STORAGE_KEYS.token);
  var email = storageGet_(STORAGE_KEYS.email);
  var expiresAt = storageGet_(STORAGE_KEYS.expiresAt);
  if (!token || !email) return null;
  return { token: token, email: email, expiresAt: expiresAt };
}

function getLastKnownEmail_() {
  return storageGet_(STORAGE_KEYS.lastEmail) || "";
}

// ===================== API =====================

/**
 * POSTs { action, ...payload } as text/plain (avoids a CORS preflight
 * request, which the Apps Script web app can't answer) and returns the
 * parsed JSON response — always { ok: true, ... } or { ok: false, error }.
 */
function apiRequest_(action, payload) {
  var body = Object.assign({ action: action }, payload || {});
  return fetch(API_BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  })
    .then(function (res) {
      return res.json();
    })
    .catch(function () {
      return { ok: false, error: "Network error — please check your connection and try again." };
    });
}

// ===================== SCREEN / MODAL HELPERS =====================

function showScreen_(id) {
  document.querySelectorAll(".screen").forEach(function (el) {
    el.classList.toggle("active", el.id === id);
  });
}

function showModal_(id) {
  document.getElementById(id).hidden = false;
}

function hideModal_(id) {
  document.getElementById(id).hidden = true;
}

function setButtonLoading_(button, loading) {
  button.disabled = loading;
  var spinner = button.querySelector(".btn-spinner");
  if (spinner) spinner.hidden = !loading;
}

function setError_(id, message) {
  document.getElementById(id).textContent = message || "";
}

// ===================== FORMATTING =====================

/** "2026-10-05" -> "Oct 5, 2026", parsed as a local date to avoid UTC off-by-one. */
function formatIsoDate_(isoDate) {
  if (!isoDate) return "";
  var parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Backend sends LastToggledAt as a Date's toString() — parseable directly. */
function formatTimestamp_(raw) {
  if (!raw) return "";
  var d = new Date(raw);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// ===================== STATE =====================

var state = {
  currentEmail: "",
  countdownIntervalId: null,
  pendingToggle: null, // { automationId, checkbox, li }
};

// ===================== OTP INPUT BOXES =====================

function getOtpBoxes_() {
  return Array.prototype.slice.call(document.querySelectorAll(".otp-box"));
}

function getOtpValue_() {
  return getOtpBoxes_()
    .map(function (box) {
      return box.value;
    })
    .join("");
}

function clearOtpBoxes_() {
  var boxes = getOtpBoxes_();
  boxes.forEach(function (box) {
    box.value = "";
  });
  if (boxes[0]) boxes[0].focus();
}

function wireOtpBoxes_() {
  var boxes = getOtpBoxes_();
  boxes.forEach(function (box, index) {
    box.addEventListener("input", function () {
      box.value = box.value.replace(/[^0-9]/g, "").slice(-1);
      if (box.value && boxes[index + 1]) {
        boxes[index + 1].focus();
      }
    });
    box.addEventListener("keydown", function (e) {
      if (e.key === "Backspace" && !box.value && boxes[index - 1]) {
        boxes[index - 1].focus();
      }
    });
    box.addEventListener("paste", function (e) {
      var pasted = (e.clipboardData || window.clipboardData).getData("text").replace(/[^0-9]/g, "");
      if (!pasted) return;
      e.preventDefault();
      pasted
        .slice(0, boxes.length)
        .split("")
        .forEach(function (digit, i) {
          if (boxes[i]) boxes[i].value = digit;
        });
      var next = boxes[Math.min(pasted.length, boxes.length - 1)];
      if (next) next.focus();
    });
  });
}

// ===================== COUNTDOWN =====================

function stopCountdown_() {
  if (state.countdownIntervalId) {
    clearInterval(state.countdownIntervalId);
    state.countdownIntervalId = null;
  }
}

function startCountdown_(seconds) {
  stopCountdown_();
  var remaining = seconds;
  var label = document.getElementById("verify-countdown");
  var verifySubmit = document.getElementById("verify-submit");
  var resendBtn = document.getElementById("verify-resend");

  // Rebuilt fresh each call (rather than reusing a cached span reference) —
  // the expiry branch below replaces this element's whole textContent, so
  // any previously-cached child node reference would go stale on a resend.
  label.classList.remove("expired");
  label.innerHTML = 'Code expires in <span id="countdown-seconds">' + remaining + "</span>s";
  var secondsEl = document.getElementById("countdown-seconds");
  verifySubmit.disabled = false;
  resendBtn.disabled = true;

  state.countdownIntervalId = setInterval(function () {
    remaining -= 1;
    if (remaining <= 0) {
      stopCountdown_();
      label.textContent = "Code expired — request a new one.";
      label.classList.add("expired");
      verifySubmit.disabled = true;
      resendBtn.disabled = false;
    } else {
      secondsEl.textContent = remaining;
    }
  }, 1000);
}

// ===================== LOGIN =====================

function handleLoginSubmit_(e) {
  e.preventDefault();
  var emailInput = document.getElementById("login-email");
  var submitBtn = document.getElementById("login-submit");
  var email = emailInput.value.trim();

  setError_("login-error", "");

  if (!email) {
    setError_("login-error", "Enter your email address.");
    return;
  }

  setButtonLoading_(submitBtn, true);
  apiRequest_("request_code", { email: email }).then(function (res) {
    setButtonLoading_(submitBtn, false);
    if (!res.ok) {
      setError_("login-error", res.error || "Something went wrong — please try again.");
      return;
    }
    state.currentEmail = email.trim().toLowerCase();
    beginVerifyScreen_();
  });
}

function beginVerifyScreen_() {
  document.getElementById("verify-email").textContent = state.currentEmail;
  setError_("verify-error", "");
  clearOtpBoxes_();
  startCountdown_(OTP_EXPIRY_SECONDS);
  showScreen_("screen-verify");
}

function handleBackToLogin_() {
  stopCountdown_();
  setError_("verify-error", "");
  showScreen_("screen-login");
}

// ===================== VERIFY =====================

function handleVerifySubmit_(e) {
  e.preventDefault();
  var code = getOtpValue_();
  var submitBtn = document.getElementById("verify-submit");

  setError_("verify-error", "");

  if (code.length !== 6) {
    setError_("verify-error", "Enter all 6 digits.");
    return;
  }

  setButtonLoading_(submitBtn, true);
  apiRequest_("verify_code", { email: state.currentEmail, code: code }).then(function (res) {
    setButtonLoading_(submitBtn, false);
    if (!res.ok) {
      setError_("verify-error", res.error || "Something went wrong — please try again.");
      return;
    }
    stopCountdown_();
    saveSession_(res.token, state.currentEmail, res.expiresAt);
    enterDashboard_(state.currentEmail);
  });
}

function handleResend_() {
  var resendBtn = document.getElementById("verify-resend");
  setButtonLoading_(resendBtn, true);
  setError_("verify-error", "");
  apiRequest_("request_code", { email: state.currentEmail }).then(function (res) {
    setButtonLoading_(resendBtn, false);
    if (!res.ok) {
      setError_("verify-error", res.error || "Couldn't resend the code — please try again.");
      return;
    }
    clearOtpBoxes_();
    startCountdown_(OTP_EXPIRY_SECONDS);
  });
}

// ===================== DASHBOARD =====================

function enterDashboard_(email) {
  state.currentEmail = email;
  document.getElementById("dashboard-user").textContent = email;
  showScreen_("screen-dashboard");
  loadAutomations_();
}

function loadAutomations_() {
  var session = getStoredSession_();
  var loadingEl = document.getElementById("dashboard-loading");
  var emptyEl = document.getElementById("dashboard-empty");
  var listEl = document.getElementById("automation-list");

  setError_("dashboard-error", "");
  loadingEl.hidden = false;
  emptyEl.hidden = true;
  listEl.hidden = true;
  listEl.innerHTML = "";

  if (!session) {
    loadingEl.hidden = true;
    openSessionExpired_();
    return;
  }

  apiRequest_("list_automations", { token: session.token }).then(function (res) {
    loadingEl.hidden = true;
    if (!res.ok) {
      openSessionExpired_();
      return;
    }
    if (res.automations.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    res.automations.forEach(function (automation) {
      listEl.appendChild(buildAutomationCard_(automation));
    });
    listEl.hidden = false;
  });
}

function buildAutomationCard_(automation) {
  var li = document.createElement("li");
  li.className = "automation-card";
  li.dataset.automationId = automation.automationId;

  var top = document.createElement("div");
  top.className = "automation-card-top";

  var textWrap = document.createElement("div");
  var name = document.createElement("p");
  name.className = "automation-name";
  name.textContent = automation.name || automation.automationId;
  var desc = document.createElement("p");
  desc.className = "automation-description";
  desc.textContent = automation.description || "";
  textWrap.appendChild(name);
  textWrap.appendChild(desc);

  var toggleLabel = document.createElement("label");
  toggleLabel.className = "toggle";
  var checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = automation.enabled;
  var track = document.createElement("span");
  track.className = "toggle-track";
  toggleLabel.appendChild(checkbox);
  toggleLabel.appendChild(track);

  top.appendChild(textWrap);
  top.appendChild(toggleLabel);

  var meta = document.createElement("div");
  meta.className = "automation-meta";
  li.appendChild(top);
  li.appendChild(meta);

  renderAutomationMeta_(li, automation);

  checkbox.addEventListener("change", function () {
    if (checkbox.checked) {
      // Don't let the flip stick until an end date is confirmed (or
      // explicitly skipped) in the modal.
      checkbox.checked = false;
      openEndDateModal_(automation, checkbox, li);
    } else {
      turnOffAutomation_(automation.automationId, checkbox, li);
    }
  });

  return li;
}

function renderAutomationMeta_(li, automation) {
  var meta = li.querySelector(".automation-meta");
  meta.innerHTML = "";

  var badge = document.createElement("span");
  badge.className = "badge " + (automation.enabled ? "badge-active" : "badge-off");
  badge.textContent = automation.enabled ? "● Active" : "○ Off";
  meta.appendChild(badge);

  var subtext = document.createElement("span");
  subtext.className = "automation-subtext";
  if (automation.enabled && automation.endDate) {
    subtext.textContent = "Runs until " + formatIsoDate_(automation.endDate);
  } else if (automation.enabled) {
    subtext.textContent = "No end date — turn off manually";
  } else if (automation.lastToggledAt) {
    subtext.textContent = "Last updated " + formatTimestamp_(automation.lastToggledAt);
  } else {
    subtext.textContent = "";
  }
  meta.appendChild(subtext);
}

function turnOffAutomation_(automationId, checkbox, li) {
  checkbox.disabled = true;
  var session = getStoredSession_();
  if (!session) {
    openSessionExpired_();
    return;
  }
  apiRequest_("toggle_automation", {
    token: session.token,
    automationId: automationId,
    enabled: false,
    endDate: "",
  }).then(function (res) {
    checkbox.disabled = false;
    if (!res.ok) {
      checkbox.checked = true; // revert
      setError_("dashboard-error", res.error || "Couldn't turn that off — please try again.");
      return;
    }
    setError_("dashboard-error", "");
    renderAutomationMeta_(li, res.automation);
  });
}

// ===================== END-DATE MODAL (turning an automation ON) =====================

function openEndDateModal_(automation, checkbox, li) {
  state.pendingToggle = { automationId: automation.automationId, checkbox: checkbox, li: li };
  document.getElementById("enddate-automation-name").textContent = automation.name || automation.automationId;
  document.getElementById("enddate-input").value = "";
  setError_("enddate-error", "");
  showModal_("enddate-modal");
}

function closeEndDateModal_() {
  hideModal_("enddate-modal");
  state.pendingToggle = null;
}

function handleEndDateConfirm_() {
  if (!state.pendingToggle) return;
  var confirmBtn = document.getElementById("enddate-confirm");
  var endDate = document.getElementById("enddate-input").value; // "" or "yyyy-mm-dd"
  var session = getStoredSession_();

  if (!session) {
    closeEndDateModal_();
    openSessionExpired_();
    return;
  }

  setButtonLoading_(confirmBtn, true);
  setError_("enddate-error", "");

  apiRequest_("toggle_automation", {
    token: session.token,
    automationId: state.pendingToggle.automationId,
    enabled: true,
    endDate: endDate,
  }).then(function (res) {
    setButtonLoading_(confirmBtn, false);
    if (!res.ok) {
      setError_("enddate-error", res.error || "Couldn't turn that on — please try again.");
      return;
    }
    var pending = state.pendingToggle;
    pending.checkbox.checked = true;
    renderAutomationMeta_(pending.li, res.automation);
    closeEndDateModal_();
  });
}

// ===================== SESSION EXPIRED MODAL =====================

function openSessionExpired_() {
  clearSession_();
  setError_("expired-error", "");
  showModal_("session-expired-modal");
}

function handleExpiredRequestCode_() {
  var email = getLastKnownEmail_();
  var btn = document.getElementById("expired-request-code");
  if (!email) {
    hideModal_("session-expired-modal");
    showScreen_("screen-login");
    return;
  }
  setButtonLoading_(btn, true);
  setError_("expired-error", "");
  apiRequest_("request_code", { email: email }).then(function (res) {
    setButtonLoading_(btn, false);
    if (!res.ok) {
      setError_("expired-error", res.error || "Couldn't send a new code — please try again.");
      return;
    }
    state.currentEmail = email;
    hideModal_("session-expired-modal");
    beginVerifyScreen_();
  });
}

function handleSignOut_() {
  clearSession_();
  storageRemove_(STORAGE_KEYS.lastEmail);
  state.currentEmail = "";
  document.getElementById("login-email").value = "";
  hideModal_("session-expired-modal");
  showScreen_("screen-login");
}

// ===================== INIT =====================

function init_() {
  wireOtpBoxes_();

  document.getElementById("login-form").addEventListener("submit", handleLoginSubmit_);
  document.getElementById("verify-form").addEventListener("submit", handleVerifySubmit_);
  document.getElementById("verify-back").addEventListener("click", handleBackToLogin_);
  document.getElementById("verify-change-email").addEventListener("click", handleBackToLogin_);
  document.getElementById("verify-resend").addEventListener("click", handleResend_);
  document.getElementById("dashboard-signout").addEventListener("click", handleSignOut_);
  document.getElementById("enddate-cancel").addEventListener("click", closeEndDateModal_);
  document.getElementById("enddate-confirm").addEventListener("click", handleEndDateConfirm_);
  document.getElementById("expired-request-code").addEventListener("click", handleExpiredRequestCode_);
  document.getElementById("expired-signout").addEventListener("click", handleSignOut_);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(function () {
      /* installability is a nice-to-have — ignore if it fails */
    });
  }

  var session = getStoredSession_();
  if (!session) {
    showScreen_("screen-login");
    return;
  }

  if (session.expiresAt && Date.now() > new Date(session.expiresAt).getTime()) {
    openSessionExpired_();
    return;
  }

  apiRequest_("check_session", { token: session.token }).then(function (res) {
    if (!res.ok) {
      openSessionExpired_();
      return;
    }
    enterDashboard_(res.email);
  });
}

document.addEventListener("DOMContentLoaded", init_);
