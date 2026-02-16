import os
import json
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, RedirectResponse
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY")
ELEVEN_API_KEY = os.getenv("ELEVENLABS_API_KEY")

# ID di una voce ElevenLabs (puoi cambiarla dalla dashboard Eleven)
VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "nPczCjzI2devNBz1zQrb")  # Brian - Deep, Resonant
print(f"🎤 DEBUG: VOICE_ID configurato = {VOICE_ID}")

app = FastAPI()

# ====== CORS ======
origins = [
    "https://www.aiprofrealtime.com",
    "https://aiprofrealtime.com",  # anche senza www se lo usi
    "http://localhost:5501",      # sviluppo locale static server
    "http://localhost:3000",      # eventuale frontend locale
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


# ====== ElevenLabs TTS ======
@app.get("/tts")
@app.post("/tts")
async def tts(text: str = Query(..., min_length=1)):
    """
    Converte il testo in audio usando ElevenLabs e restituisce un MP3.
    Accetta sia GET (/tts?text=...) che POST.
    """
    if not ELEVEN_API_KEY:
        return {"error": "ELEVENLABS_API_KEY non configurata"}

    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"

    headers = {
        "xi-api-key": ELEVEN_API_KEY,
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
    }

    payload = {
        "text": text,
        "model_id": "eleven_multilingual_v2",
        "voice_settings": {
            "stability": 0.4,
            "similarity_boost": 0.8,
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, headers=headers, json=payload)
        print("DEBUG TTS STATUS:", r.status_code)
        if not r.is_success:
            print("DEBUG TTS TEXT:", r.text[:1000])
        r.raise_for_status()
        audio_bytes = r.content

    return StreamingResponse(
        iter([audio_bytes]),
        media_type="audio/mpeg",
    )


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
