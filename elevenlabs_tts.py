# elevenlabs_tts.py
import os
import requests
import logging

logger = logging.getLogger(__name__)

class ElevenLabsTTS:
    def __init__(self):
        self.api_key = os.getenv("ELEVENLABS_API_KEY")
        self.voice_id = os.getenv("ELEVENLABS_VOICE_ID", "tomkxGQGz4b1kE0EM722")
        
        if not self.api_key:
            raise ValueError("ELEVENLABS_API_KEY non trovata nelle variabili d'ambiente")
        
        logger.info(f"ElevenLabs TTS inizializzato con voice_id: {self.voice_id}")
    
    def text_to_speech(self, text: str, output_path: str = "output.mp3") -> str:
        """
        Converte testo in audio usando ElevenLabs con API REST diretta
        """
        try:
            logger.info(f"Generazione audio per testo: {text[:50]}...")
            
            url = f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}"
            
            headers = {
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
                "xi-api-key": self.api_key
            }
            
            data = {
                "text": text,
                "model_id": "eleven_multilingual_v2",
                "voice_settings": {
                    "stability": 0.5,
                    "similarity_boost": 0.75,
                    "style": 0.0,
                    "use_speaker_boost": True
                }
            }
            
            response = requests.post(url, json=data, headers=headers)
            
            if response.status_code == 200:
                with open(output_path, "wb") as f:
                    f.write(response.content)
                logger.info(f"Audio salvato in: {output_path}")
                return output_path
            else:
                error_msg = f"Errore API: {response.status_code} - {response.text}"
                logger.error(error_msg)
                raise Exception(error_msg)
            
        except Exception as e:
            logger.error(f"Errore nella generazione audio: {str(e)}")
            raise

if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    
    tts = ElevenLabsTTS()
    test_text = "Ciao, sono il tuo prof AI. Benvenuto nella lezione di oggi!"
    result = tts.text_to_speech(test_text, "test_mario_voice.mp3")
    print(f"✅ Test completato! Audio salvato in: {result}")
