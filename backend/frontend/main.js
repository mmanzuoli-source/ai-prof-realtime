// main.js
import { initAvatar3D, resizeAvatar, setTalkingIntensity } from "./avatar.js";

let avatarInitialized = false;

// URL backend (locale vs produzione)
const BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:8000"
    : "https://www.aiprofrealtime.com";

window.addEventListener("load", () => {
  initChat();
});

window.addEventListener("resize", () => {
  if (avatarInitialized) {
    resizeAvatar();
  }
});

// --- Gestione voce maschile TTS ---

// Pulisce il testo per la sintesi vocale
function cleanTextForSpeech(text) {
  if (!text) return "";

  let t = String(text);

  // 1) Rimuove blocchi ```json ... ``` o ``` ... ```
  t = t.replace(/```json[\s\S]*?```/gi, "");
  t = t.replace(/```[\s\S]*?```/g, "");

  // 2) Prova a estrarre solo il valore di "testo" se c'è JSON
  const matchTesto = String(text).match(/"testo"\s*:\s*"([\s\S]*?)"/i);
  if (matchTesto && matchTesto[1]) {
    t = matchTesto[1];
  }

  // 3) Rimuove oggetti JSON inline residui e campi di controllo
  t = t.replace(/\{[^}]*"tipo"[^}]*\}/gi, "");
  t = t.replace(/\{[^}]*"score_delta"[^}]*\}/gi, "");
  t = t.replace(/"score_delta"\s*:\s*\d+/gi, "");
  t = t.replace(/score_delta/gi, "");

  // 4) Emoji / shortcode / markdown
  t = t
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
    .replace(/:\w+:/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return t;
}

// --- TTS con ElevenLabs API ---
async function speakText(text) {
  if (!text) return;

  try {
    setTalkingIntensity(1.0);

    // Chiama l'endpoint /tts del backend, passando text come query param
    const response = await fetch(
      `${BASE_URL}/tts?text=${encodeURIComponent(text)}`,
      { method: "POST" }
    );

    if (!response.ok) {
      console.error("Errore TTS:", response.status);
      setTalkingIntensity(0.0);
      return;
    }

    // Ottieni l'audio come blob
    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);

    // Crea e riproduci l'audio
    const audio = new Audio(audioUrl);

    audio.onended = () => {
      setTalkingIntensity(0.0);
      URL.revokeObjectURL(audioUrl);
    };

    audio.onerror = () => {
      console.error("Errore riproduzione audio");
      setTalkingIntensity(0.0);
      URL.revokeObjectURL(audioUrl);
    };

    await audio.play();
  } catch (error) {
    console.error("Errore TTS ElevenLabs:", error);
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

  // nuovi campi scuola/materia
  const schoolInput = document.getElementById("school-input");
  const subjectInput = document.getElementById("subject-input");

  // preview modalità ascolto
  const listenPreview = document.getElementById("listen-preview");
  const listenPreviewText = document.getElementById("listen-preview-text");

  // SpeechRecognition
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let micTimeoutId = null;

  // stato modalità ascolto
  let listenModeActive = false;
  let listeningBuffer = "";

  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = "it-IT";
    recognition.continuous = true;
    recognition.interimResults = false;
  }

  // ripristina scuola/materia se salvate
  if (schoolInput && savedState.school) schoolInput.value = savedState.school;
  if (subjectInput && savedState.subject) subjectInput.value = savedState.subject;

  // --- Gestione utenti multipli (localStorage) ---
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
  } else {
    showLogin();
  }

  // Registrazione nuovo utente
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

  // Login utente esistente
  if (loginExistingBtn && loginUserSelect) {
    loginExistingBtn.addEventListener("click", () => {
      const selectedId = loginUserSelect.value;
      if (!selectedId) return;
      setCurrentUserId(selectedId);
      showAppForUserId(selectedId);
      if (inputEl) inputEl.focus();
    });
  }

  // Login via email/password
  if (loginEmailBtn && loginEmailInput && loginPasswordInput) {
    loginEmailBtn.addEventListener("click", () => {
      const email = loginEmailInput.value.trim();
      const password = loginPasswordInput.value.trim();
      if (!email || !password) return;

      const user = getUserByEmailAndPassword(email, password);
      if (!user) {
        alert("Email o password non corretti.");
        return;
      }

      setCurrentUserId(user.id);
      showAppForUserId(user.id);
      if (inputEl) inputEl.focus();
    });

    loginPasswordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        loginEmailBtn.click();
      }
    });
  }

  // Reset password
  if (
    forgotPasswordLink &&
    forgotPasswordPanel &&
    forgotEmailInput &&
    forgotPasswordInput &&
    forgotPasswordBtn
  ) {
    forgotPasswordLink.addEventListener("click", () => {
      const visible = forgotPasswordPanel.style.display === "block";
      forgotPasswordPanel.style.display = visible ? "none" : "block";
      if (!visible) {
        forgotEmailInput.focus();
      }
    });

    forgotPasswordBtn.addEventListener("click", () => {
      const email = forgotEmailInput.value.trim();
      const newPass = forgotPasswordInput.value.trim();
      if (!email || !newPass) {
        alert("Inserisci email e nuova password.");
        return;
      }

      const ok = resetUserPasswordByEmail(email, newPass);
      if (!ok) {
        alert("Nessun profilo trovato con questa email.");
        return;
      }

      alert("Password aggiornata! Ora puoi accedere con la nuova password.");
      forgotPasswordPanel.style.display = "none";
      forgotPasswordInput.value = "";
    });

    forgotPasswordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        forgotPasswordBtn.click();
      }
    });
  }

  // Logout
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      if (
        !confirm(
          "Vuoi uscire dal prof AI su questo dispositivo? I punti e la cronologia resteranno salvati."
        )
      ) {
        return;
      }
      clearCurrentUserId();
      showLogin();
    });
  }

  // --- Utility date / streak ---
  function getTodayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function loadStreak() {
    try {
      const raw = localStorage.getItem(STREAK_KEY);
      if (!raw) return { streak: 0, lastDate: null };
      const data = JSON.parse(raw);
      return { streak: data.streak || 0, lastDate: data.lastDate || null };
    } catch {
      return { streak: 0, lastDate: null };
    }
  }

  function saveStreak(streak, lastDate) {
    localStorage.setItem(
      STREAK_KEY,
      JSON.stringify({ streak, lastDate: lastDate || getTodayISO() })
    );
  }

  function updateStreakOnActivity() {
    const { streak, lastDate } = loadStreak();
    const today = getTodayISO();

    if (!lastDate) {
      saveStreak(1, today);
      return 1;
    }

    if (lastDate === today) {
      saveStreak(streak, today);
      return streak;
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayISO = yesterday.toISOString().slice(0, 10);

    if (lastDate === yesterdayISO) {
      const newStreak = streak + 1;
      saveStreak(newStreak, today);
      return newStreak;
    }

    saveStreak(1, today);
    return 1;
  }

  function getStreakLabel() {
    const { streak } = loadStreak();
    if (streak <= 0) return "Nessuna streak";
    if (streak === 1) return "Streak: 1 giorno";
    return `Streak: ${streak} giorni`;
  }

  // --- Missioni + gamification per argomento ---
  function loadMissions() {
    try {
      const raw = localStorage.getItem(MISSIONS_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      if (data.date !== getTodayISO()) return [];
      return data.missions || [];
    } catch {
      return [];
    }
  }

  function saveMissions(missions) {
    localStorage.setItem(
      MISSIONS_KEY,
      JSON.stringify({ date: getTodayISO(), missions })
    );
  }

  function detectTopicFromMessage(text) {
    const t = (text || "").toLowerCase();

    const subjects = [
      "matematica",
      "italiano",
      "inglese",
      "storia",
      "geografia",
      "scienze",
      "fisica",
      "chimica",
      "biologia",
    ];

    const subject = subjects.find((s) => t.includes(s)) || "materia";

    let topic = "";
    if (subject !== "materia") {
      const idx = t.indexOf(subject);
      topic = t.slice(idx + subject.length).trim();
    }
    if (!topic) {
      topic = t;
    }

    return {
      subject: subject.charAt(0).toUpperCase() + subject.slice(1),
      topic: topic || "argomento generale",
    };
  }

  function startTopicGamificationFromText(text) {
    const existing = loadMissions();
    if (existing && existing.length > 0) return;

    const { subject, topic } = detectTopicFromMessage(text);

    const shortTopic = topic.length > 50 ? topic.slice(0, 47) + "..." : topic;

    const missions = [
      {
        id: "m1",
        label: `Spiega al prof cosa sai già su ${shortTopic} (${subject})`,
        completed: false,
      },
      {
        id: "m2",
        label: `Fai almeno 3 domande su ${shortTopic}`,
        completed: false,
      },
      {
        id: "m3",
        label: `Prova un esercizio o un esempio pratico su ${shortTopic}`,
        completed: false,
      },
    ];

    saveMissions(missions);
    renderMissions();
  }

  function renderMissions() {
    if (!missionsListEl) return;
    const missions = loadMissions();
    missionsListEl.innerHTML = "";
    if (missionsStreakLabel) missionsStreakLabel.textContent = getStreakLabel();

    if (missions.length === 0) {
      missionsListEl.innerHTML =
        '<div style="color:#9ca3af;font-size:12px;">Le missioni appariranno quando comunichi l\'argomento al prof.</div>';
      return;
    }

    missions.forEach((m) => {
      const row = document.createElement("div");
      row.className = "mission-item";

      const dot = document.createElement("div");
      dot.className = "mission-dot" + (m.completed ? " completed" : "");

      const text = document.createElement("div");
      text.innerHTML = `${m.label}<br><span class="mission-progress">${
        m.completed ? "Completata!" : "In corso..."
      }</span>`;

      row.appendChild(dot);
      row.appendChild(text);
      missionsListEl.appendChild(row);
    });
  }

  // --- Stato XP / history ---
  function saveState() {
    const school = schoolInput ? schoolInput.value : "";
    const subject = subjectInput ? subjectInput.value : "";
    localStorage.setItem(
      "tutorState",
      JSON.stringify({ points, level, school, subject })
    );
  }

  function getHistory() {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    try {
      return JSON.parse(raw) || [];
    } catch {
      return [];
    }
  }

  function saveMessageToHistory(who, text) {
    try {
      const history = getHistory();
      history.push({ who, text, ts: Date.now() });
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) {
      console.error("Errore salvataggio history:", e);
    }
  }

  function computeTodaySummary(history) {
    if (!history.length) return { msgs: 0, userMsgs: 0, profMsgs: 0 };
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    let msgs = 0,
      userMsgs = 0,
      profMsgs = 0;
    history.forEach((m) => {
      const d = new Date(m.ts || 0);
      const dStr = d.toISOString().slice(0, 10);
      if (dStr === todayStr) {
        msgs++;
        if (m.who === "user") userMsgs++;
        if (m.who === "prof") profMsgs++;
      }
    });
    return { msgs, userMsgs, profMsgs };
  }

  function computeLastSessionSummary(history) {
    if (!history.length) return "";
    const lastTs = history[history.length - 1].ts || Date.now();
    const lastDate = new Date(lastTs);
    const dateStr = lastDate.toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    let msgs = 0,
      userMsgs = 0,
      profMsgs = 0;
    history.forEach((m) => {
      const d = new Date(m.ts || 0);
      const sameDay = d.toDateString() === lastDate.toDateString();
      if (sameDay) {
        msgs++;
        if (m.who === "user") userMsgs++;
        if (m.who === "prof") profMsgs++;
      }
    });

    return `Ultima sessione: ${dateStr} • Messaggi: ${msgs} (Tu: ${userMsgs}, Prof: ${profMsgs})`;
  }

  function renderHistory() {
    if (!historyPanel || !historySummaryText) return;
    const history = getHistory();
    if (!lastSessionSummaryEl || !historyContent) return;

    if (history.length === 0) {
      historySummaryText.textContent = "Nessuna cronologia disponibile.";
      lastSessionSummaryEl.textContent = "";
      historyContent.innerHTML = "";
      return;
    }

    const summary = computeTodaySummary(history);
    const streakLabel = getStreakLabel();

    if (summary.msgs > 0) {
      historySummaryText.textContent = `Oggi: ${summary.msgs} messaggi (Tu: ${summary.userMsgs}, Prof: ${summary.profMsgs}) • ${streakLabel}`;
    } else {
      historySummaryText.textContent = `Nessun messaggio per oggi • ${streakLabel}`;
    }

    lastSessionSummaryEl.textContent = computeLastSessionSummary(history);

    const lines = history.map((m) => {
      const date = new Date(m.ts);
      const hh = String(date.getHours()).padStart(2, "0");
      const mm = String(date.getMinutes()).padStart(2, "0");
      const whoLabel = m.who === "prof" ? "Prof" : "Tu";
      const safeText = (m.text || "")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<div style="margin-bottom:4px;"><strong>[${hh}:${mm}] ${whoLabel}:</strong> ${safeText}</div>`;
    });
    historyContent.innerHTML = lines.join("");
  }

  function getLevelTitle(level) {
    if (level >= 7) return "Maestro";
    if (level >= 5) return "Esperto";
    if (level >= 3) return "Apprendista";
    return "Novizio";
  }

  function updateUI() {
    if (scoreLabel) scoreLabel.textContent = `XP: ${points}`;
    if (levelLabel) {
      const title = getLevelTitle(level);
      levelLabel.textContent = `Livello ${level} • ${title}`;
    }
    if (xpBar) {
      const progress = ((points % 100) / 100) * 100;
      xpBar.style.width = `${progress}%`;
    }
    if (missionsStreakLabel) missionsStreakLabel.textContent = getStreakLabel();
    saveState();
  }

  function linkify(text) {
    if (!text) return "";
    const urlRegex = /https?:\/\/[^\s]+/g;
    return text.replace(urlRegex, (url) => {
      const safe = url.replace(/"/g, "&quot;");
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });
  }

  function addMessage(text, who = "prof", save = true) {
    if (!messagesEl) return;
    const row = document.createElement("div");
    row.className = who === "user" ? "msg user" : "msg prof";
    row.innerHTML = linkify(text);
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (save) saveMessageToHistory(who, text);
  }

  let firstUserMessageSent = false;

  async function sendMessage() {
    if (!inputEl) return;
    const raw = inputEl.value.trim();
    if (!raw) return;
    inputEl.value = "";

    const school = schoolInput ? schoolInput.value.trim() : "";
    const subject = subjectInput ? subjectInput.value.trim() : "";

    let textForModel = raw;
    if (!firstUserMessageSent && (school || subject)) {
      const header = `Scuola: ${school || "non specificata"}, Materia: ${
        subject || "non specificata"
      }.\n`;
      textForModel = header + raw;
      firstUserMessageSent = true;
    }

    addMessage(raw, "user", true);

    startTopicGamificationFromText(raw);

    const newStreak = updateStreakOnActivity();
    console.log("Streak aggiornata:", newStreak);

    try {
      const res = await fetch(`${BASE_URL}/tutor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: textForModel, points, level }),
      });
      if (!res.ok) {
        addMessage(
          "C'è stato un problema nel parlare con il prof AI.",
          "prof",
          true
        );
        return;
      }
      const data = await res.json();
      const rispostaTesto = data.testo || "";
      const scoreDelta = data.score_delta || 0;

      points += scoreDelta;
      if (points >= level * 100) {
        level += 1;
      }
      updateUI();

      addMessage(rispostaTesto, "prof", true);

      const speakTextClean = cleanTextForSpeech(rispostaTesto);
      speakText(speakTextClean);
    } catch (e) {
      console.error("Errore chiamata /tutor:", e);
      addMessage("Errore di connessione con il server.", "prof", true);
    }
  }

  // --- Modalità ascolto ---

  function enterListenMode() {
    if (!recognition) return;
    listenModeActive = true;
    listeningBuffer = "";
    recognition.lang = "it-IT";
    recognition.continuous = true;
    recognition.interimResults = true;
    try {
      recognition.start();
    } catch {}
    if (listenModeBtn) {
      listenModeBtn.textContent = "👂 ON";
      listenModeBtn.style.background = "#16a34a";
    }
    if (listenPreview) {
      listenPreview.style.display = "block";
    }
    if (listenPreviewText) {
      listenPreviewText.textContent = "";
    }
  }

  function exitListenMode(sendToProf = true) {
    listenModeActive = false;
    if (recognition && recognition.running) {
      try {
        recognition.stop();
      } catch {}
    }
    if (listenModeBtn) {
      listenModeBtn.textContent = "👂";
      listenModeBtn.style.background = "#020617";
    }
    if (listenPreview) {
      listenPreview.style.display = "none";
    }

    const text = listeningBuffer.trim();
    listeningBuffer = "";
    if (!sendToProf || !text) return;

    const message = `Modalità ascolto: lo studente ha letto o esposto questo testo:\n\n"${text}"\n\nValuta la sua esposizione (chiarezza, pronuncia, lessico) e poi chiedigli di ripetere con suggerimenti pratici.`;
    if (inputEl) inputEl.value = message;
    sendMessage();
  }

  // --- Eventi chat ---
  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      sendMessage();
    });
  }

  if (inputEl) {
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  // --- Cronologia ---
  if (historyBtn && historyPanel) {
    historyBtn.addEventListener("click", () => {
      const vis = historyPanel.style.display === "block";
      historyPanel.style.display = vis ? "none" : "block";
      if (!vis) renderHistory();
    });
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("click", () => {
      if (!confirm("Vuoi cancellare tutta la cronologia su questo dispositivo?"))
        return;
      localStorage.removeItem(HISTORY_KEY);
      if (historySummaryText)
        historySummaryText.textContent = "Nessuna cronologia disponibile.";
      if (historyContent) historyContent.innerHTML = "";
      if (lastSessionSummaryEl) lastSessionSummaryEl.textContent = "";
    });
  }

  // --- Voce: bottoni controllo TTS e microfono / ascolto ---
  if (recognition) {
    // mic normale
    if (micBtn) {
      micBtn.addEventListener("click", () => {
        if (listenModeActive) {
          exitListenMode(false);
        }
        try {
          const synth = window.speechSynthesis;
          if (synth) synth.cancel();

          if (recognition.running) {
            recognition.stop();
            if (micTimeoutId) clearTimeout(micTimeoutId);
          } else {
            recognition.lang = "it-IT";
            recognition.continuous = true;
            recognition.interimResults = false;
            recognition.start();
            micTimeoutId = setTimeout(() => {
              if (recognition.running) recognition.stop();
            }, 60000);
          }
        } catch (e) {
          console.error("Errore avvio SpeechRecognition:", e);
        }
      });
    }

    // bottone modalità ascolto
    if (listenModeBtn) {
      listenModeBtn.addEventListener("click", () => {
        if (!listenModeActive) {
          enterListenMode();
        } else {
          exitListenMode(true);
        }
      });
    }

    recognition.onstart = () => {
      recognition.running = true;
    };

    recognition.onend = () => {
      recognition.running = false;
      if (micTimeoutId) clearTimeout(micTimeoutId);

      if (listenModeActive) {
        try {
          recognition.start();
        } catch {}
      }
    };

    recognition.onresult = (event) => {
      // accumula solo i pezzi finali nuovi
      let finalChunk = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0].transcript;
        if (res.isFinal) {
          finalChunk += " " + transcript;
        }
      }

      finalChunk = finalChunk.trim();

      if (listenModeActive) {
        if (finalChunk) {
          listeningBuffer += (listeningBuffer ? " " : "") + finalChunk;
          if (listenPreviewText) {
            listenPreviewText.textContent = listeningBuffer;
          }
        }
      } else if (inputEl) {
        const lastRes = event.results[event.results.length - 1];
        const lastTranscript = lastRes[0].transcript;
        inputEl.value = lastTranscript;
      }
    };

    recognition.onerror = (event) => {
      console.error("Errore SpeechRecognition:", event.error);
      recognition.running = false;
      if (micTimeoutId) clearTimeout(micTimeoutId);
      if (listenModeActive) {
        exitListenMode(false);
      }
    };
  }

  if (playVoiceBtn) {
    playVoiceBtn.addEventListener("click", () => {
      if (!("speechSynthesis" in window)) return;
      const history = getHistory();
      const lastProf = [...history].reverse().find((m) => m.who === "prof");
      if (!lastProf) return;
      const speakTextClean = cleanTextForSpeech(lastProf.text || "");
      speakText(speakTextClean);
    });
  }

  if (pauseVoiceBtn) {
    pauseVoiceBtn.addEventListener("click", () => {
      if (!("speechSynthesis" in window)) return;
      window.speechSynthesis.pause();
      setTalkingIntensity(0.5);
    });
  }

  if (stopVoiceBtn) {
    stopVoiceBtn.addEventListener("click", () => {
      if (!("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      setTalkingIntensity(0.0);
    });
  }

  // salva quando cambi scuola/materia
  if (schoolInput) {
    schoolInput.addEventListener("change", saveState);
  }
  if (subjectInput) {
    subjectInput.addEventListener("change", saveState);
  }

  // --- Init finale ---
  updateUI();
  renderMissions();
}
