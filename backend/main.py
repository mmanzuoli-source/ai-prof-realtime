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
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, RedirectResponse
from pydantic import BaseModel
from passlib.context import CryptContext
from openai import OpenAI

load_dotenv()

PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

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
#                     UTENTI
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
- Usa un linguaggio semplice, con esempi concreti e vicini alla vita quotidiana.
- Non dare la soluzione finale subito: porta lo studente a ragionare, facendogli fare lui i passaggi logici.
- Dai feedback positivi quando fa un passo corretto, correggi con calma quando sbaglia.

Struttura del dialogo:
1. Saluta in modo cordiale e chiedi che materia/argomento sta studiando.
2. Fagli spiegare brevemente cosa ha capito finora.
3. In base alla risposta, proponi una domanda guidata molto semplice.
4. Dopo ogni risposta:
   - se è corretta, conferma e vai al passo successivo;
   - se è sbagliata o incompleta, spiega l’errore in modo gentile e proponi un esempio più facile.
5. Mantieni ogni messaggio breve (1–2 frasi) e termina quasi sempre con una domanda, così il dialogo continua.

Tono:
- Sempre incoraggiante e motivante.
- Niente termini troppo tecnici senza spiegarli.
- Evita frasi lunghe; meglio frasi corte e chiare.

Obiettivo finale:
- Fare in modo che il ragazzo capisca davvero l’argomento, non solo che copi la risposta.
- Se ti chiede “dimmi solo il risultato”, tu comunque cerca di fargli fare almeno un passaggio di ragionamento.
"""


# qui sotto aggiungerai (o hai già) gli endpoint che usano SYSTEM_PROMPT,
# il client OpenAI/Perplexity e il WebSocket per la chat/voce.
