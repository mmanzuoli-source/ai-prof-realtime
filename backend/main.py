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
from jose import JWTError, jwt

load_dotenv()

PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ADMIN_SECRET = os.getenv("ADMIN_SECRET", "changeme-admin-secret")

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

SECRET_KEY = os.getenv("ADMIN_JWT_SECRET", "CAMBIA_QUESTA_CHIAVE_SUPER_SEGRETA")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

ADMIN_USERNAME = "Admin"
ADMIN_PASSWORD = "Firenze.1926!"


class Token(BaseModel):
    access_token: str
    token_type: str


class TokenData(BaseModel):
    username: Optional[str] = None


class AdminUser(BaseModel):
    username: str
    disabled: Optional[bool] = None


def get_admin_user(username: str) -> Optional[AdminUser]:
    if username == ADMIN_USERNAME:
        return AdminUser(username=ADMIN_USERNAME, disabled=False)
    return None


def authenticate_admin(username: str, password: str) -> Optional[AdminUser]:
    user = get_admin_user(username)
    if not user:
        return None
    if password != ADMIN_PASSWORD:
        return None
    return user


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/admin/login")


@app.post("/auth/admin/login", response_model=Token)
async def admin_login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = authenticate_admin(form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenziali non valide",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token = create_access_token(
        data={"sub": user.username},
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
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


async def require_admin_header(
    x_admin_secret: str = Header(..., alias="X-Admin-Secret"),
):
    if x_admin_secret != ADMIN_SECRET:
        raise HTTPException(status_code=403, detail="Non autorizzato")


# =====================================================
#              ENDPOINT ADMIN — GESTIONE UTENTI
# =====================================================

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
async def update_user(
    user_id: int,
    body: UpdateUserRequest,
    current_admin: AdminUser = Depends(get_current_admin),
):
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


class CreateUserRequest(BaseModel):
    name: str
    email: str
    password: str


class ResetPasswordRequest(BaseModel):
    new_password: str


@app.post("/admin/users", response_model=UserPublic)
async def admin_create_user(
    body: CreateUserRequest,
    current_admin: AdminUser = Depends(get_current_admin),
):
    conn = get_db()
    cur = conn.cursor()
    try:
        cur.execute(
            """
            INSERT INTO users (name, email, password_hash, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                body.name.strip(),
                body.email.strip().lower(),
                hash_password(body.password),
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


@app.delete("/admin/users/{user_id}")
async def admin_delete_user(
    user_id: int,
    current_admin: AdminUser = Depends(get_current_admin),
):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cur.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Utente non trovato")
    cur.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return {"ok": True, "deleted_id": user_id}


@app.patch("/admin/users/{user_id}/password")
async def admin_reset_password(
    user_id: int,
    body: ResetPasswordRequest,
    current_admin: AdminUser = Depends(get_current_admin),
):
    if not body.new_password or len(body.new_password) < 4:
        raise HTTPException(
            status_code=400, detail="Password troppo corta (min 4 caratteri)"
        )
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cur.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Utente non trovato")
    cur.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (hash_password(body.new_password), user_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "user_id": user_id}


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

