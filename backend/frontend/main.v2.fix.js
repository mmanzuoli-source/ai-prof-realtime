// main.v2.fix.js
import { initAvatar3D, resizeAvatar, setTalkingIntensity } from "./avatar.js";

let avatarInitialized = false;

const BASE_URL =
  window.location.hostname === "localhost"
    ? "http://localhost:8000"
    : "https://www.aiprofrealtime.com";

// === AUTH ADMIN (solo per overlay admin) ===
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

async function loginAdminWithPassword(password) {
  const formData = new FormData();
  formData.append("username", "Admin");
  formData.append("password", password);
  formData.append("grant_type", "password");

  const res = await fetch(`${BASE_URL}/auth/admin/login`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    throw new Error("Login admin fallito");
  }

  const data = await res.json();
  setAdminToken(data.access_token);
}

// === TTS ===

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

    utter.onerror = () => {
      setTalkingIntensity(0.0);
    };

    window.speechSynthesis.speak(utter);
  } catch (error) {
    console.error("Errore TTS browser:", error);
    setTalkingIntensity(0.0);
  }
}

// === CHAT ===

initChat();

window.addEventListener("resize", () => {
  if (avatarInitialized) {
    resizeAvatar();
  }
});

function initChat() {
  let points = 0;
  let level = 1;

  const savedState = JSON.parse(localStorage.getItem("tutorState") || "{}");
  if (typeof savedState.points === "number") points = savedState.points;
  if (typeof savedState.level === "number") level = savedState.level;

  const HISTORY_KEY = "tutorHistory";
  const STREAK_KEY = "tutorStreak";
  const MISSIONS_KEY = "tutorMissions";

  const loginPanel = document.getElementById("login-panel");
  const appPanel = document.getElementById("app-panel");

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

  // Mostra subito app (no login)
  function showApp() {
    if (loginPanel) loginPanel.style.display = "none";
    if (appPanel) appPanel.style.display = "block";

    if (statusLabel) {
      statusLabel.textContent = "Online • Ciao, Studente!";
    }

    if (!avatarInitialized) {
      initAvatar3D();
      resizeAvatar();
      avatarInitialized = true;
    }
  }

  showApp();

  // Helpers UI

  function addMessage(text, role) {
    if (!messagesEl) return;
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "prof");
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function updateXP(delta) {
    points += delta;
    if (points < 0) points = 0;
    // livello fittizio: ogni 100 XP
    level = 1 + Math.floor(points / 100);
    const levelProgress = (points % 100) / 100;

    if (scoreLabel) scoreLabel.textContent = `XP: ${points}`;
    if (levelLabel)
      levelLabel.textContent = `Livello ${level} • ${
        level === 1 ? "Novizio" : "Studente"
      }`;
    if (xpBar) xpBar.style.width = `${levelProgress * 100}%`;

    localStorage.setItem(
      "tutorState",
      JSON.stringify({
        ...(savedState || {}),
        points,
        level,
        school: schoolInput ? schoolInput.value : "",
        subject: subjectInput ? subjectInput.value : "",
      })
    );
  }

  async function sendMessage(text) {
    const trimmed = (text || "").trim();
    if (!trimmed || !messagesEl || !inputEl) return;

    addMessage(trimmed, "user");
    inputEl.value = "";
    inputEl.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    if (statusLabel) statusLabel.textContent = "Sto pensando...";

    try {
      const payload = {
        message: trimmed,
        school: schoolInput ? schoolInput.value || "" : "",
        subject: subjectInput ? subjectInput.value || "" : "",
      };

      const res = await fetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const textErr = await res.text();
        console.error("Errore /api/chat:", textErr);
        addMessage("C'è stato un errore, riprova tra poco.", "prof");
        if (statusLabel) statusLabel.textContent = "Errore";
        return;
      }

      const data = await res.json();
      const reply = data.reply || data.answer || JSON.stringify(data);
      addMessage(reply, "prof");
      speakText(reply);
      updateXP(10);
      if (statusLabel) statusLabel.textContent = "Online";
    } catch (err) {
      console.error("Errore rete /api/chat:", err);
      addMessage("Problemi di rete, controlla la connessione.", "prof");
      if (statusLabel) statusLabel.textContent = "Offline";
    } finally {
      if (inputEl) inputEl.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  // Eventi input testo

  if (sendBtn && inputEl) {
    sendBtn.addEventListener("click", () => {
      sendMessage(inputEl.value);
    });

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputEl.value);
      }
    });
  }

  // Microfono / SpeechRecognition (se supportato)

  if (recognition && micBtn && inputEl) {
    let isRecording = false;

    recognition.onresult = (event) => {
      const last = event.results[event.results.length - 1];
      if (last && last.isFinal) {
        const transcript = last[0].transcript.trim();
        if (transcript) {
          inputEl.value = transcript;
          sendMessage(transcript);
        }
      }
    };

    recognition.onend = () => {
      isRecording = false;
      if (micBtn) micBtn.textContent = "🎤";
      if (statusLabel) statusLabel.textContent = "Online";
      if (micTimeoutId) {
        clearTimeout(micTimeoutId);
        micTimeoutId = null;
      }
    };

    micBtn.addEventListener("click", () => {
      if (!isRecording) {
        try {
          recognition.start();
          isRecording = true;
          micBtn.textContent = "🛑";
          if (statusLabel) statusLabel.textContent = "Sto ascoltando...";
          micTimeoutId = setTimeout(() => {
            if (isRecording) {
              recognition.stop();
            }
          }, 15000);
        } catch (e) {
          console.error("Errore start recognition", e);
        }
      } else {
        recognition.stop();
      }
    });
  } else if (micBtn) {
    micBtn.disabled = true;
    micBtn.title = "Microfono non supportato su questo browser";
  }

  // Modalità ascolto (usa solo TTS sul testo inserito)

  if (listenModeBtn && listenPreview && listenPreviewText && inputEl) {
    listenModeBtn.addEventListener("click", () => {
      const text = (inputEl.value || "").trim();
      if (!text) return;

      listenModeActive = !listenModeActive;

      if (listenModeActive) {
        listenPreview.style.display = "block";
        listenPreviewText.textContent = text;
        speakText(text);
        listenModeBtn.textContent = "🔁";
      } else {
        listenPreview.style.display = "none";
        listenPreviewText.textContent = "";
        window.speechSynthesis.cancel();
        setTalkingIntensity(0);
        listenModeBtn.textContent = "👂";
      }
    });
  }

  // Controlli riproduzione voce

  if (playVoiceBtn) {
    playVoiceBtn.addEventListener("click", () => {
      window.speechSynthesis.resume();
    });
  }
  if (pauseVoiceBtn) {
    pauseVoiceBtn.addEventListener("click", () => {
      window.speechSynthesis.pause();
    });
  }
  if (stopVoiceBtn) {
    stopVoiceBtn.addEventListener("click", () => {
      window.speechSynthesis.cancel();
      setTalkingIntensity(0);
    });
  }

  // Cronologia (semplificata: TODO se vuoi riattivarla bene)

  if (historyBtn && historyPanel) {
    historyBtn.addEventListener("click", () => {
      historyPanel.style.display =
        historyPanel.style.display === "none" || !historyPanel.style.display
          ? "block"
          : "none";
    });
  }

  if (clearHistoryBtn && historyContent) {
    clearHistoryBtn.addEventListener("click", () => {
      historyContent.innerHTML = "";
      localStorage.removeItem(HISTORY_KEY);
    });
  }

  // Logout = reset stato locale (ma non login vero, visto che non c'è)
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem(STREAK_KEY);
      localStorage.removeItem(MISSIONS_KEY);
      localStorage.removeItem("tutorState");
      window.location.reload();
    });
  }
}

// Overlay login admin

document.addEventListener("DOMContentLoaded", () => {
  const openAdminBtn = document.getElementById("open-admin-login-btn");
  const adminOverlay = document.getElementById("admin-login-overlay");
  const adminLoginBtn = document.getElementById("admin-login-btn");
  const adminPasswordInput = document.getElementById("admin-password");
  const adminError = document.getElementById("admin-login-error");

  if (openAdminBtn && adminOverlay) {
    openAdminBtn.addEventListener("click", () => {
      adminOverlay.style.display = "flex";
      if (adminPasswordInput) adminPasswordInput.focus();
    });
  }

  if (adminOverlay) {
    adminOverlay.addEventListener("click", (e) => {
      if (e.target === adminOverlay) {
        adminOverlay.style.display = "none";
      }
    });
  }

  if (adminLoginBtn && adminPasswordInput) {
    adminLoginBtn.addEventListener("click", async () => {
      const pwd = adminPasswordInput.value.trim();
      if (!pwd) return;

      try {
        if (adminError) {
          adminError.style.display = "none";
          adminError.textContent = "";
        }
        await loginAdminWithPassword(pwd);
        if (adminOverlay) adminOverlay.style.display = "none";
        window.location.href = "/app/admin.html";
      } catch (err) {
        console.error(err);
        if (adminError) {
          adminError.textContent = "Credenziali admin non valide.";
          adminError.style.display = "block";
        }
      }
    });

    adminPasswordInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        adminLoginBtn.click();
      }
    });
  }
});
