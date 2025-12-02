const express = require('express');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Groq Client (KI)
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Ordner erstellen
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const TEMP_DIR = path.join(__dirname, 'temp');
[DOWNLOADS_DIR, TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ============================================
// API ENDPOINTS
// ============================================

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'online',
        ai: process.env.GROQ_API_KEY ? 'enabled' : 'disabled',
        timestamp: new Date().toISOString()
    });
});

// Video Info abrufen
app.post('/api/video-info', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL fehlt' });
    }

    try {
        const command = `yt-dlp --dump-json --no-warnings "${url}"`;
        
        exec(command, { timeout: 60000 }, (error, stdout) => {
            if (error) {
                return res.status(500).json({ error: 'Video nicht gefunden' });
            }
            
            const info = JSON.parse(stdout);
            res.json({
                success: true,
                title: info.title,
                duration: info.duration,
                thumbnail: info.thumbnail,
                author: info.uploader || info.channel,
                videoId: info.id
            });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 🤖 KI: Audio extrahieren und transkribieren
// ============================================

app.post('/api/analyze-video', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL fehlt' });
    }

    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: 'GROQ_API_KEY nicht konfiguriert' });
    }

    const audioFile = path.join(TEMP_DIR, `audio-${Date.now()}.mp3`);
    
    try {
        console.log('🎵 Extrahiere Audio...');
        
        // 1. Audio extrahieren (max 10 Min für kostenlose Limits)
        await new Promise((resolve, reject) => {
            const cmd = `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${audioFile}" --download-sections "*0:00-10:00" "${url}"`;
            
            exec(cmd, { timeout: 300000 }, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        console.log('🎤 Transkribiere mit Whisper...');
        
        // 2. Mit Groq Whisper transkribieren
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(audioFile),
            model: 'whisper-large-v3',
            response_format: 'verbose_json',
            timestamp_granularities: ['segment']
        });

        console.log('🧠 Analysiere mit KI...');
        
        // 3. KI findet Highlights
        const highlights = await findHighlights(transcription);

        // 4. Aufräumen
        fs.unlinkSync(audioFile);

        res.json({
            success: true,
            transcription: transcription.text,
            segments: transcription.segments,
            highlights: highlights
        });

    } catch (error) {
        console.error('Analyse-Fehler:', error);
        
        // Aufräumen bei Fehler
        if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile);
        
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// 🧠 KI: Highlights finden
// ============================================

async function findHighlights(transcription) {
    const segments = transcription.segments || [];
    
    if (segments.length === 0) {
        return [];
    }

    // Segmente für KI formatieren
    const segmentText = segments.map((s, i) => 
        `[${formatTime(s.start)} - ${formatTime(s.end)}]: ${s.text}`
    ).join('\n');

    const prompt = `Du bist ein Video-Editor-Experte. Analysiere dieses Transkript und finde die 3-5 besten Clip-Momente.

Suche nach:
- Spannenden oder lustigen Momenten
- Wichtigen Aussagen
- Emotionalen Höhepunkten
- Überraschenden Wendungen
- Quotable Moments (Zitate die viral gehen könnten)

Transkript:
${segmentText}

Antworte NUR im JSON-Format:
[
  {
    "start": 0,
    "end": 30,
    "title": "Kurzer Clip-Titel",
    "reason": "Warum ist das interessant",
    "score": 95
  }
]

Regeln:
- start/end in Sekunden (Ganzzahlen)
- Clips sollten 15-60 Sekunden lang sein
- score von 1-100 (wie gut ist der Clip)
- Maximal 5 Clips
- NUR valides JSON, kein anderer Text`;

    try {
        const completion = await groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'llama-3.1-70b-versatile',
            temperature: 0.3,
            max_tokens: 1000
        });

        const response = completion.choices[0]?.message?.content || '[]';
        
        // JSON extrahieren
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            const highlights = JSON.parse(jsonMatch[0]);
            return highlights.sort((a, b) => b.score - a.score);
        }
        
        return [];
    } catch (error) {
        console.error('KI-Fehler:', error);
        return [];
    }
}

// ============================================
// ✂️ Clip erstellen
// ============================================

app.post('/api/create-clip', async (req, res) => {
    const { url, startTime, duration, clipName } = req.body;
    
    if (!url || startTime === undefined || !duration) {
        return res.status(400).json({ error: 'Parameter fehlen' });
    }

    const safeName = (clipName || 'clip').replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
    const outputFile = `${safeName}-${Date.now()}.mp4`;
    const outputPath = path.join(DOWNLOADS_DIR, outputFile);

    console.log(`✂️ Erstelle Clip: ${safeName}`);
    console.log(`   Start: ${startTime}s, Dauer: ${duration}s`);

    try {
        const command = `yt-dlp -f "best[height<=720]/best" --no-warnings -o - "${url}" | ffmpeg -ss ${startTime} -i pipe:0 -t ${duration} -c:v libx264 -preset ultrafast -c:a aac -movflags +faststart -y "${outputPath}"`;

        await new Promise((resolve, reject) => {
            exec(command, { timeout: 300000, maxBuffer: 200 * 1024 * 1024 }, (error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            console.log(`✅ Clip erstellt: ${outputFile} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
            
            res.json({
                success: true,
                downloadUrl: `/downloads/${outputFile}`,
                filename: outputFile,
                size: stats.size
            });
        } else {
            throw new Error('Datei nicht erstellt');
        }
    } catch (error) {
        console.error('Clip-Fehler:', error);
        res.status(500).json({ error: 'Clip-Erstellung fehlgeschlagen' });
    }
});

// ============================================
// Hilfsfunktionen
// ============================================

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Cleanup alle 30 Minuten
setInterval(() => {
    const oneHourAgo = Date.now() - 3600000;
    
    [DOWNLOADS_DIR, TEMP_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(file => {
            const filePath = path.join(dir, file);
            try {
                if (fs.statSync(filePath).mtimeMs < oneHourAgo) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Gelöscht: ${file}`);
                }
            } catch (e) {}
        });
    });
}, 1800000);

// Server starten
app.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log(`🚀 YouTube Clipper AI Server`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`🤖 KI: ${process.env.GROQ_API_KEY ? '✅ Aktiviert' : '❌ Kein API Key'}`);
    console.log('=========================================');
});
