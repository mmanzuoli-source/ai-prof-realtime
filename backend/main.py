import os
import json
import sqlite3
from datetime import datetime, timedelta
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    Query,
    HTTPException,
    Depends,
    Header,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, RedirectResponse
from fastapi.security import OAuth2PasswordRequestForm, OAuth2PasswordBearer
from pydantic import BaseModel
from passlib.context import CryptContext
from openai import OpenAI
from jose import JWTError, jwt  # JWT

load_dotenv()

PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ADMIN_SECRET = os.getenv("ADMIN_SECRET", "changeme-admin-secret")  # rimane per compatibilità se ti serve ancora

print("DEBUG OPENAI_API_KEY prefix:", (OPENAI_API_KEY or "")[:8])

app = FastAPI()

# ====== CORS ======
origins = [
    "https://www.aiprofrealtime.com",
    "https://aiprofrealtime.com",
    "http://localhost:5501",
    "http://localhost:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ====== STATICI FRONTEND ======
BASE_DIR = os.path.dirname(__file__)
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

if os.path.exists(FRONTEND_DIR):
    app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
    print(f"✅ Frontend montato da: {FRONTEND_DIR}")

    @app.get("/")
    async def root():
        return RedirectResponse(url="/app/")
else:
    print(f"⚠️  Frontend non trovato in: {FRONTEND_DIR}")

    @app.get("/")
    async def root():
        return {
            "message": "AI Prof Realtime API - Backend only. Vai a /docs per la documentazione."
        }

# =====================================================
#                     UTENTI / ADMIN
# =====================================================

DB_PATH = os.path.join(BASE_DIR, "users.db")
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            last_login TEXT
        )
        """
    )
    conn.commit()
    conn.close()

init_db()

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)

class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str

class LoginRequest(BaseModel):
    email: str
    password: str

class UserPublic(BaseModel):
    id: int
    name: str
    email: str
    is_admin: bool
    created_at: str
    last_login: str | None = None

@app.post("/api/register", response_model=UserPublic)
async def register_user(req: RegisterRequest):
    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute(
            """
            INSERT INTO users (name, email, password_hash, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                req.name.strip(),
                req.email.strip().lower(),
                hash_password(req.password),
                datetime.utcnow().isoformat(),
            ),
        )
        conn.commit()
        user_id = cur.lastrowid
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Email già registrata")

    cur.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = cur.fetchone()
    conn.close()
    return UserPublic(
        id=row["id"],
        name=row["name"],
        email=row["email"],
        is_admin=bool(row["is_admin"]),
        created_at=row["created_at"],
        last_login=row["last_login"],
    )

@app.post("/api/login", response_model=UserPublic)
async def login_user(req: LoginRequest):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "SELECT * FROM users WHERE email = ?", (req.email.strip().lower(),)
    )
    row = cur.fetchone()
    if not row or not verify_password(req.password, row["password_hash"]):
        conn.close()
        raise HTTPException(status_code=401, detail="Credenziali non valide")

    cur.execute(
        "UPDATE users SET last_login = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), row["id"]),
    )
    conn.commit()
    conn.close()

    return UserPublic(
        id=row["id"],
        name=row["name"],
        email=row["email"],
        is_admin=bool(row["is_admin"]),
        created_at=row["created_at"],
        last_login=row["last_login"],
    )

# =========================
#   ADMIN LOGIN via JWT
# =========================

# Config JWT
SECRET_KEY = os.getenv("ADMIN_JWT_SECRET", "CAMBIA_QUESTA_CHIAVE_SUPER_SEGRETA")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60  # durata token admin

class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    username: Optional[str] = None

class AdminUser(BaseModel):
    username: str
    disabled: Optional[bool] = None

# Admin hardcoded come richiesto
ADMIN_USERNAME = "Admin"
ADMIN_PASSWORD = "Firenze.1926!"

def get_admin_user(username: str) -> Optional[AdminUser]:
    if username == ADMIN_USERNAME:
        return AdminUser(username=ADMIN_USERNAME, disabled=False)
    return None

def authenticate_admin(username: str, password: str) -> Optional[AdminUser]:
    user = get_admin_user(username)
    if not user:
        return None
    # confronto semplice, niente hash (solo per questo admin)
    if password != ADMIN_PASSWORD:
        return None
    return user

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/admin/login")

@app.post("/auth/admin/login", response_model=Token)
async def admin_login(form_data: OAuth2PasswordRequestForm = Depends()):
    """
    Login admin:
    - username: Admin
    - password: Firenze.1926!
    Restituisce un JWT Bearer.
    """
    user = authenticate_admin(form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenziali non valide",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username},
        expires_delta=access_token_expires,
    )
    return {"access_token": access_token, "token_type": "bearer"}

async def get_current_admin(token: str = Depends(oauth2_scheme)) -> AdminUser:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Token non valido o scaduto",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
        token_data = TokenData(username=username)
    except JWTError:
        raise credentials_exception

    user = get_admin_user(username=token_data.username)
    if user is None or user.username != ADMIN_USERNAME:
        raise credentials_exception

    return user

# Vecchio require_admin via header X-Admin-Secret lo lasciamo se ti serve ancora altrove
async def require_admin_header(
    x_admin_secret: str = Header(..., alias="X-Admin-Secret"),
):
    if x_admin_secret != ADMIN_SECRET:
        raise HTTPException(status_code=403, detail="Non autorizzato")

# Endpoint admin protetti ora via JWT
@app.get("/admin/users", response_model=list[UserPublic])
async def list_users(current_admin: AdminUser = Depends(get_current_admin)):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM users ORDER BY created_at DESC")
    rows = cur.fetchall()
    conn.close()
    return [
        UserPublic(
            id=r["id"],
            name=r["name"],
            email=r["email"],
            is_admin=bool(r["is_admin"]),
            created_at=r["created_at"],
            last_login=r["last_login"],
        )
        for r in rows
    ]

class UpdateUserRequest(BaseModel):
    is_admin: bool | None = None

@app.patch("/admin/users/{user_id}", response_model=UserPublic)
async def update_user(user_id: int, body: UpdateUserRequest, current_admin: AdminUser = Depends(get_current_admin)):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Utente non trovato")

    if body.is_admin is not None:
        cur.execute(
            "UPDATE users SET is_admin = ? WHERE id = ?",
            (1 if body.is_admin else 0, user_id),
        )
        conn.commit()

    cur.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = cur.fetchone()
    conn.close()
    return UserPublic(
        id=row["id"],
        name=row["name"],
        email=row["email"],
        is_admin=bool(row["is_admin"]),
        created_at=row["created_at"],
        last_login=row["last_login"],
    )

# Esempio endpoint admin di test
@app.get("/admin/ping")
async def admin_ping(current_admin: AdminUser = Depends(get_current_admin)):
    return {"status": "ok", "admin": current_admin.username}

# =====================================================
#                  PROF / PERPLEXITY
# =====================================================

class TutorRequest(BaseModel):
    message: str
    points: int = 0
    level: int = 1

class TutorResponse(BaseModel):
    tipo: str
    testo: str
    score_delta: int = 0

SYSTEM_PROMPT = """
Sei un professore privato paziente per un ragazzo di 11 anni (prima media).
Obiettivo: aiutarlo a capire da solo, NON dargli subito la risposta.

Linee guida generali:
- Chiedi sempre prima che materia/argomento sta studiando (es. frazioni, analisi logica, storia, geografia).
- Fai domande guidate a piccoli passi (stile dialogo socratico), massimo 2 frasi per volta.
- Usa un linguaggio semplice, esempi concreti (scuola, sport, videogiochi) e frasi brevi.
- Quando sbaglia, NON dire "sbagliato": spiega cosa non torna e proponi un esempio analogo un po' più facile.
- Non dare il risultato finale a meno che il ragazzo scriva chiaramente "dimmi la soluzione" o "mostrami il risultato".
- Alla fine di ogni spiegazione proponi 1 esercizio simile da provare da solo.
- Adatta la difficoltà al livello stimato: se il ragazzo è in difficoltà, semplifica e fai più esempi.
- Tieni un tono incoraggiante, mai giudicante.

Richieste di IMMAGINI o VIDEO:
- Se il bambino chiede di vedere una IMMAGINE, una FIGURA, un DISEGNO, una FOTO o un VIDEO su un argomento,
  NON usare HTML (niente <img>, niente <iframe>).
- Nell'attributo "testo" DEVI:
  - descrivere brevemente cosa vedrebbe il bambino in quell'immagine o video (2-3 frasi semplici),
  - e aggiungere una o due righe con link esterni completi, ad esempio:
    "Puoi vedere una foto qui: https://example.com/immagine.jpg"
    "Puoi vedere un video qui: https://www.youtube.com/watch?v=VIDEO_ID"
- Scrivi sempre link completi (https://...) così che il frontend possa mostrarli in chat.

Formato di risposta OBBLIGATORIO:
Devi SEMPRE rispondere in JSON valido con i campi:
  tipo: "spiegazione" | "quiz" | "feedback"
  testo: cosa dire allo studente (massimo 3-4 frasi)
  score_delta: punti da aggiungere (es. 0, 5, 10, 20)

Non aggiungere testo fuori dal JSON.
"""

async def call_perplexity(message: str, points: int, level: int) -> TutorResponse:
    if not PERPLEXITY_API_KEY:
        raise RuntimeError("PERPLEXITY_API_KEY non impostata")

    headers = {
        "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
        "Content-Type": "application/json",
    }

    user_content = (
        f"Stato attuale: punti={points}, livello={level}.\n"
        f"Messaggio studente: {message}"
    )

    payload = {
        "model": "sonar-pro",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": 400,
        "temperature": 0.7,
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.perplexity.ai/chat/completions",
                headers=headers,
                json=payload,
            )
            print("DEBUG RAW STATUS:", resp.status_code)
            print("DEBUG RAW TEXT:", resp.text[:1000])
            resp.raise_for_status()
            data = resp.json()
            print("DEBUG PARSED:", json.dumps(data)[:1000])
    except Exception as e:
        print("ERRORE CHIAMATA PERPLEXITY:", repr(e))
        return TutorResponse(
            tipo="spiegazione",
            testo="C'è stato un problema nel parlare con il professore virtuale. Riprova tra poco.",
            score_delta=0,
        )

    content = data["choices"][0]["message"]["content"]

    try:
        parsed = json.loads(content)
        tipo = parsed.get("tipo", "spiegazione")
        testo = parsed.get("testo", "")
        score_delta = int(parsed.get("score_delta", 0))
    except Exception:
        tipo = "spiegazione"
        testo = content
        score_delta = 0

    if score_delta == 0:
        if tipo == "quiz":
            score_delta = 10
        elif tipo == "feedback":
            score_delta = 5
        else:
            score_delta = 5

    return TutorResponse(tipo=tipo, testo=testo, score_delta=score_delta)

@app.post("/tutor", response_model=TutorResponse)
async def tutor_endpoint(req: TutorRequest):
    return await call_perplexity(req.message, req.points, req.level)

# =====================================================
#                     TTS (ancora disponibile)
# =====================================================

@app.get("/tts")
@app.post("/tts")
async def tts(text: str = Query(..., min_length=1)):
    """
    Converte il testo in audio usando OpenAI TTS e restituisce un MP3.
    Accetta sia GET (/tts?text=...) che POST.
    """
    if not OPENAI_API_KEY:
        print("ERRORE TTS: OPENAI_API_KEY non configurata")
        return StreamingResponse(iter([b""]), media_type="audio/mpeg")

    try:
        client = OpenAI(api_key=OPENAI_API_KEY)

        res = client.audio.speech.with_raw_response.create(
            model="gpt-4o-mini-tts",
            voice="onyx",
            input=text,
            format="mp3",
        )

        audio_bytes = res.read()

        return StreamingResponse(
            iter([audio_bytes]),
            media_type="audio/mpeg",
        )
    except Exception as e:
        print("ERRORE TTS OpenAI:", repr(e))
        return StreamingResponse(iter([b""]), media_type="audio/mpeg")

# =====================================================
#                     WS VOICE TEST
# =====================================================

@app.websocket("/ws/voice")
async def ws_voice(websocket: WebSocket):
  await websocket.accept()
  try:
      await websocket.receive_bytes()
      risposta = {
          "testo": "Ho ricevuto la tua voce. Per ora sto solo testando il canale audio.",
          "final": True,
      }
      await websocket.send_text(json.dumps(risposta))
  except WebSocketDisconnect:
      pass
  finally:
      await websocket.close()
