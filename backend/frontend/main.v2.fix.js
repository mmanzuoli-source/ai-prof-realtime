// main.v2.fix.js
import { initAvatar3D, resizeAvatar, setTalkingIntensity } from "./avatar.js";

let avatarInitialized = false;

// URL backend
const BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:8000"
    : "https://www.aiprofrealtime.com";

// === AUTH ADMIN (JWT) ===
const ADMIN_TOKEN_KEY = "ai_prof_admin_token";

function getAdminToken() {
  return window.localStorage.getItem(ADMIN_TOKEN_KEY) || null;
}

function setAdminToken(token) {
  if (token) {
    window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(ADMIN_TOKEN_KEY);
  }
}

function isAdminLoggedIn() {
  return !!getAdminToken();
}

async function adminFetch(path, options = {}) {
  const token = getAdminToken();
  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const url =
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("/")
      ? path
      : `${BASE_URL}${path.startsWith("/") ? path : "/" + path}`;

  return fetch(url, { ...options, headers });
}

// === FINE AUTH ADMIN ===

initChat();

window.addEventListener("resize", () => {
  if (avatarInitialized) {
    resizeAvatar();
  }
});

// --- Gestione voce maschile TTS ---

function cleanTextForSpeech(text) {
  if (!text) return "";

  let t = String(text);

  t = t.replace(/```json[\s\S]*?```/gi, "");
  t = t.replace(/```[\s\S]*?```/g, "");

  const matchTesto = String(text).match(/"testo"\s*:\s*"([\s\S]*?)"/i);
  if (matchTesto && matchTesto[1]) {
    t = matchTesto[1];
  }

  t = t.replace(/\{[^}]*"tipo"[^}]*\}/gi, "");
  t = t.replace(/\{[^}]*"score_delta"[^}]*\}/gi, "");
  t = t.replace(/"score_delta"\s*:\s*\d+/gi, "");
  t = t.replace(/score_delta/gi, "");

  t = t
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
    .replace(/:\w+:/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return t;
}

async function speakText(text) {
  if (!text) return;

  if (!("speechSynthesis" in window)) {
    console.warn("speechSynthesis non supportato dal browser");
    return;
  }

  try {
    setTalkingIntensity(1.0);

    const t = cleanTextForSpeech(text);
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(t);
    utter.lang = "it-IT";

    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find(
        (v) =>
          v.lang.startsWith("it") &&
          /male|uomo|ragazzo|Luca|Paolo/i.test(v.name)
      ) ||
      voices.find((v) => v.lang.startsWith("it")) ||
      null;

    if (preferred) {
      utter.voice = preferred;
    }

    utter.onend = () => {
      setTalkingIntensity(0.0);
    };

    utter.onerror = (e) => {
      console.error("Errore speechSynthesis", e);
      setTalkingIntensity(0.0);
    };

    window.speechSynthesis.speak(utter);
  } catch (error) {
    console.error("Errore TTS browser:", error);
    setTalkingIntensity(0.0);
  }
}

function initChat() {
  let points = 0;
  let level = 1;

  const savedState = JSON.parse(localStorage.getItem("tutorState") || "{}");
  if (typeof savedState.points === "number") points = savedState.points;
  if (typeof savedState.level === "number") level = savedState.level;

  const USER_KEY = "tutorUserId";
  const USERS_KEY = "tutorUsers";
  const HISTORY_KEY = "tutorHistory";
  const STREAK_KEY = "tutorStreak";
  const MISSIONS_KEY = "tutorMissions";

  const loginPanel = document.getElementById("login-panel");
  const appPanel = document.getElementById("app-panel");

  const tabLogin = document.getElementById("tab-login");
  const tabRegister = document.getElementById("tab-register");
  const loginExistingPanel = document.getElementById("login-existing");
  const loginRegisterPanel = document.getElementById("login-register");
  const loginUserSelect = document.getElementById("login-user-select");
  const loginExistingBtn = document.getElementById("login-existing-btn");
  const loginEmailInput = document.getElementById("login-email");
  const loginPasswordInput = document.getElementById("login-password");
  const loginEmailBtn = document.getElementById("login-email-btn");

  const registerNameInput = document.getElementById("register-name");
  const registerEmailInput = document.getElementById("register-email");
  const registerPasswordInput = document.getElementById("register-password");
  const registerBtn = document.getElementById("register-btn");
  const forgotPasswordLink = document.getElementById("forgot-password-link");
  const forgotPasswordPanel = document.getElementById("forgot-password-panel");
  const forgotEmailInput = document.getElementById("forgot-email");
  const forgotPasswordInput = document.getElementById("forgot-password");
  const forgotPasswordBtn = document.getElementById("forgot-password-btn");

  const scoreLabel = document.getElementById("score-label");
  const levelLabel = document.getElementById("level-label");
  const xpBar = document.getElementById("xp-bar");
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");
  const micBtn = document.getElementById("mic-btn");
  const listenModeBtn = document.getElementById("listen-mode-btn");
  const playVoiceBtn = document.getElementById("play-voice-btn");
  const pauseVoiceBtn = document.getElementById("pause-voice-btn");
  const stopVoiceBtn = document.getElementById("stop-voice-btn");
  const statusLabel = document.getElementById("status-label");
  const historyBtn = document.getElementById("history-btn");
  const historyPanel = document.getElementById("history-panel");
  const historyContent = document.getElementById("history-content");
  const historySummaryText = document.getElementById("history-summary-text");
  const clearHistoryBtn = document.getElementById("clear-history-btn");
  const lastSessionSummaryEl = document.getElementById("last-session-summary");
  const missionsListEl = document.getElementById("missions-list");
  const missionsStreakLabel = document.getElementById("missions-streak-label");
  const logoutBtn = document.getElementById("logout-btn");

  const schoolInput = document.getElementById("school-input");
  const subjectInput = document.getElementById("subject-input");

  const listenPreview = document.getElementById("listen-preview");
  const listenPreviewText = document.getElementById("listen-preview-text");

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let micTimeoutId = null;

  let listenModeActive = false;
  let listeningBuffer = "";

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = "it-IT";
    recognition.continuous = true;
    recognition.interimResults = false;
  }

  if (schoolInput && savedState.school) schoolInput.value = savedState.school;
  if (subjectInput && savedState.subject) subjectInput.value = savedState.subject;

  function loadUsers() {
    try {
      return JSON.parse(localStorage.getItem(USERS_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }

  function getCurrentUserId() {
    try {
      return localStorage.getItem(USER_KEY) || null;
    } catch {
      return null;
    }
  }

  function setCurrentUserId(id) {
    try {
      localStorage.setItem(USER_KEY, id);
    } catch {}
  }

  function clearCurrentUserId() {
    try {
      localStorage.removeItem(USER_KEY);
    } catch {}
  }

  function getUserById(id) {
    const users = loadUsers();
    return users.find((u) => u.id === id) || null;
  }

  function getUserByEmailAndPassword(email, password) {
    const users = loadUsers();
    return (
      users.find(
        (u) =>
          (u.email || "").toLowerCase() === email.toLowerCase() &&
          u.password === password
      ) || null
    );
  }

  function createUser(name, email, password) {
    const users = loadUsers();
    const id = Date.now().toString();
    users.push({ id, name, email, password, createdAt: Date.now() });
    saveUsers(users);
    return { id, name, email };
  }

  function resetUserPasswordByEmail(email, newPassword) {
    if (!email || !newPassword) return false;
    const users = loadUsers();
    const idx = users.findIndex(
      (u) => (u.email || "").toLowerCase() === email.toLowerCase()
    );
    if (idx === -1) return false;

    users[idx].password = newPassword;
    saveUsers(users);
    return true;
  }

  function refreshUserSelect() {
    if (!loginUserSelect || !loginExistingBtn) return;
    const users = loadUsers();
    loginUserSelect.innerHTML = "";

    if (users.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Nessun profilo salvato";
      loginUserSelect.appendChild(opt);
      loginExistingBtn.disabled = true;
      return;
    }

    users.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = `${u.name} (${u.email || "senza email"})`;
      loginUserSelect.appendChild(opt);
    });
    loginExistingBtn.disabled = false;
  }

  function showLoginTab() {
    if (!tabLogin || !tabRegister || !loginExistingPanel || !loginRegisterPanel)
      return;
    tabLogin.classList.add("active");
    tabRegister.classList.remove("active");
    tabLogin.style.background = "#111827";
    tabLogin.style.color = "#e5e7eb";
    tabRegister.style.background = "transparent";
    tabRegister.style.color = "#9ca3af";
    loginExistingPanel.style.display = "block";
    loginRegisterPanel.style.display = "none";
  }

  function showRegisterTab() {
    if (!tabLogin || !tabRegister || !loginExistingPanel || !loginRegisterPanel)
      return;
    tabRegister.classList.add("active");
    tabLogin.classList.remove("active");
    tabRegister.style.background = "#111827";
    tabRegister.style.color = "#e5e7eb";
    tabLogin.style.background = "transparent";
    tabLogin.style.color = "#9ca3af";
    loginExistingPanel.style.display = "none";
    loginRegisterPanel.style.display = "block";
  }

  if (tabLogin && tabRegister) {
    tabLogin.addEventListener("click", showLoginTab);
    tabRegister.addEventListener("click", showRegisterTab);
  }

  function showAppForUserId(id) {
    const user = getUserById(id);
    const name = user ? user.name : "Studente";

    if (loginPanel) loginPanel.style.display = "none";
    if (appPanel) appPanel.style.display = "grid";
    if (statusLabel) statusLabel.textContent = `Online • Ciao, ${name}!`;

    if (!avatarInitialized) {
      initAvatar3D();
      resizeAvatar();
      avatarInitialized = true;
    }
  }

  function showAppForAdmin() {
    if (loginPanel) loginPanel.style.display = "none";
    if (appPanel) appPanel.style.display = "grid";
    if (statusLabel) statusLabel.textContent = "Online • Amministratore";

    if (!avatarInitialized) {
      initAvatar3D();
      resizeAvatar();
      avatarInitialized = true;
    }
  }

  function showLogin() {
    if (appPanel) appPanel.style.display = "none";
    if (loginPanel) loginPanel.style.display = "flex";
    if (statusLabel) statusLabel.textContent = "Offline";
    refreshUserSelect();
    showLoginTab();
  }

  const existingUserId = getCurrentUserId();
  if (existingUserId && getUserById(existingUserId)) {
    showAppForUserId(existingUserId);
  } else if (isAdminLoggedIn()) {
    showAppForAdmin();
  } else {
    showLogin();
  }

  if (registerBtn && registerNameInput && registerEmailInput && registerPasswordInput) {
    registerBtn.addEventListener("click", () => {
      const name = registerNameInput.value.trim();
      const email = registerEmailInput.value.trim();
      const password = registerPasswordInput.value.trim();
      if (!name || !email || !password) return;

      const users = loadUsers();
      if (users.some((u) => u.email === email)) {
        alert("Esiste già un profilo con questa email.");
        return;
      }

      const user = createUser(name, email, password);
      setCurrentUserId(user.id);
      showAppForUserId(user.id);
      if (inputEl) inputEl.focus();
    });

    registerPasswordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        registerBtn.click();
      }
    });
  }

  if (loginExistingBtn && loginUserSelect) {
    loginExistingBtn.addEventListener("click", () => {
      const selectedId = loginUserSelect.value;
      if (!selectedId) return;
      setCurrentUserId(selectedId);
      showAppForUserId(selectedId);
