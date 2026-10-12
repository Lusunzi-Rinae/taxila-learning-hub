// Load environment variables from .env file
require('dotenv').config();


const express = require("express");
const sql = require("mssql/msnodesqlv8");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { exec } = require("child_process");
const multer = require("multer");
const axios = require("axios");
const fs = require("fs");
const mammoth = require("mammoth");
const pdfParse = require('pdf-parse');
const officeParser = require("officeparser");
const app = express();
const PORT = process.env.PORT || 3001;
// Current academic year — update in .env when the year rolls over
const CURRENT_YEAR = parseInt(process.env.CURRENT_ACADEMIC_YEAR || new Date().getFullYear(), 10);

// ============================================
// ===== RATE LIMITING =====
// ============================================
const rateLimit = require('express-rate-limit');

// Login limiter — max 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: {
        success: false,
        message: "Too many login attempts from this IP. Please try again in 15 minutes."
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Password reset limiter — max 3 requests per hour per IP
const resetLimiter = rateLimit({
    windowMs: 45 * 60 * 1000,
    max: 3,
    message: {
        success: false,
        message: "Too many password reset attempts. Please try again in 45 minutes."
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// ============================================
// ===== GEMINI INTEGRATION =====
// ============================================
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

const GEMINI_MODEL = 'gemini-3.5-flash-lite';

const chatSessions = new Map();

app.use(express.json());
app.use(express.static("public"));

// ============================================
// ===== DATABASE CONFIGURATION =====
// ============================================
// USE_LOCAL_DB=true  → localhost\SQLEXPRESS (dev on campus Wi-Fi)
// USE_LOCAL_DB=false → Azure SQL (production / off campus)
// Set it in your .env file.


const USE_LOCAL_DB = false;

const DB_SERVER = process.env.DB_SERVER || 'taxila-server-remo.database.windows.net';
const DB_PORT = process.env.DB_PORT || 1433;
const DB_USER = process.env.DB_USER || null;
const DB_PASSWORD = process.env.DB_PASSWORD || null;
const DB_NAME = process.env.DB_NAME || 'TAXILA_LEARNING_HUB';
const DB_ENCRYPT = (process.env.DB_ENCRYPT === 'true');
const DB_TRUST_CERT = (process.env.DB_TRUST_SERVER_CERTIFICATE === 'true');

let connectionString;
let dbLabel;

if (USE_LOCAL_DB) {
    // ---- LOCAL SQL EXPRESS (Windows Trusted) ----
    connectionString =
        "Driver={ODBC Driver 18 for SQL Server};" +
        "Server=localhost\\SQLEXPRESS;" +
        `Database=${DB_NAME};` +
        "Trusted_Connection=Yes;" +
        "TrustServerCertificate=Yes;" +
        "Encrypt=no;";
    dbLabel = `LOCAL (localhost\\SQLEXPRESS → ${DB_NAME})`;

} else if (DB_USER && DB_PASSWORD) {
    // ---- AZURE SQL (SQL Authentication) ----
    connectionString =
        "Driver={ODBC Driver 18 for SQL Server};" +
        `Server=tcp:${DB_SERVER},${DB_PORT};` +
        `Database=${DB_NAME};` +
        `Uid=${DB_USER};` +
        `Pwd=${DB_PASSWORD};` +
        `Encrypt=${DB_ENCRYPT ? 'yes' : 'no'};` +
        `TrustServerCertificate=${DB_TRUST_CERT ? 'yes' : 'no'};` +
        "Connection Timeout=30;";
    dbLabel = `AZURE (${DB_SERVER} → ${DB_NAME})`;

} else {
    // ---- LOCAL fallback ----
    connectionString =
        "Driver={ODBC Driver 18 for SQL Server};" +
        "Server=localhost\\SQLEXPRESS;" +
        `Database=${DB_NAME};` +
        "Trusted_Connection=Yes;" +
        "TrustServerCertificate=Yes;" +
        "Encrypt=no;";
    dbLabel = `LOCAL fallback (localhost\\SQLEXPRESS → ${DB_NAME})`;
}

// ============================================
// ADD THIS LINE RIGHT HERE:
console.log("🚨 CURRENT DATABASE CONNECTION:", dbLabel);

const config = { connectionString };

console.log('🔌 Connecting to SQL Server...');
console.log('   Mode    :', dbLabel);
console.log('   Database:', DB_NAME);

sql.connect(config)
    .then(() => {
        console.log("✅ Connected to SQL Server");
        return sql.query`SELECT DB_NAME() AS db`;
    })
    .then(r => {
        console.log(`📊 Active DB: ${r.recordset[0].db}`);
    })
    .catch(err => {
        console.log("❌ DB Error:", err.message);
        console.log("\n💡 Troubleshooting:");
        console.log("   1. If using LOCAL: make sure SQL Express service is running");
        console.log("   2. If using AZURE: test network to taxila-server-remo.database.windows.net:1433");
        console.log("   3. If Azure fails → switch to mobile hotspot or Windscribe VPN (Johannesburg)");
        console.log("   4. Check .env has DB_USER and DB_PASSWORD set correctly");
    });

// ============================================
// ===== EMAIL =====
// ============================================
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});
const resetCodes = new Map();

// ============================================
// ===== SMS (SMS Messenger — REST API v1) =====
// ============================================
const SMS_EMAIL = process.env.SMS_EMAIL;
const SMS_API_KEY = process.env.SMS_API_KEY;
const SMS_API_URL = 'https://sms1.smsmessenger.co.za/app/api/rest/v1/sms/send.json';

async function sendSms(phoneNumber, message) {
    try {
        // Normalise SA phone: 0821234567 → 27821234567
        let number = String(phoneNumber).replace(/\D/g, '');
        if (number.startsWith('0')) {
            number = '27' + number.slice(1);
        }

        if (!SMS_EMAIL || !SMS_API_KEY) {
            throw new Error('SMS_EMAIL or SMS_API_KEY missing from .env');
        }

        const response = await axios.post(SMS_API_URL, {
            recipientNumber: number,
            message: message
        }, {
            headers: {
                'email': SMS_EMAIL,
                'token': SMS_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        // SMS Messenger returns { messageId: "...", error: null } on success
        if (response.data && response.data.error) {
            throw new Error(response.data.error);
        }

        return {
            success: true,
            messageId: response.data?.messageId || null,
            raw: response.data
        };

    } catch (error) {
        console.error(`❌ SMS failed for ${phoneNumber}:`, error.message);
        throw error;
    }
}


// ============================================
// ===== AUTH MIDDLEWARE =====
// ============================================
// Attach to any route that requires a logged-in user.
// Verifies the JWT sent in the Authorization header.
//
// Usage:
//   app.get("/some-route", requireAuth, async (req, res) => { ... })
//
// After passing through this middleware, `req.user` contains:
//   { email: "user@email.com", role: "Learner" }
//
// You can restrict by role too:
//   app.get("/admin-route", requireAuth, requireRole("admin"), ...)

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: "Not authenticated. Please log in."
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;    // { email, role, iat, exp }
        next();
    } catch (err) {
        console.warn("⚠️ Invalid token:", err.message);
        return res.status(401).json({
            success: false,
            message: "Invalid or expired token. Please log in again."
        });
    }
}

// Optional: require a specific role
function requireRole(...allowedRoles) {
    return function (req, res, next) {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "Not authenticated"
            });
        }
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                message: "You don't have permission to do this."
            });
        }
        next();
    };
}

// ============================================
// ===== INPUT VALIDATION HELPERS =====
// ============================================
function isValidEmail(email) {
    return typeof email === 'string' &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isNonEmptyString(s, minLen = 1, maxLen = 500) {
    if (typeof s !== 'string') return false;
    const trimmed = s.trim();
    return trimmed.length >= minLen && trimmed.length <= maxLen;
}

function isValidPassword(pwd) {
    // At least 8 characters, must contain letters AND numbers
    return typeof pwd === 'string' &&
        pwd.length >= 8 &&
        /[a-zA-Z]/.test(pwd) &&
        /[0-9]/.test(pwd);
}

function isInArray(value, allowedArray) {
    return allowedArray.includes(value);
}

// ============================================
// ===== CHAT HISTORY HELPER =====
// ============================================
async function saveChatMessage(studentEmail, subject, role, message, threadId = null) {
    if (!studentEmail || !message) return;
    try {
        await sql.query`
            INSERT INTO ChatHistory (student_email, subject, role, message, thread_id)
            VALUES (${studentEmail}, ${subject || 'general'}, ${role}, ${message}, ${threadId})
        `;

        if (threadId) {
            await sql.query`
                UPDATE ChatThreads 
                SET last_message_at = GETDATE()
                WHERE thread_id = ${threadId}
            `;
        }
    } catch (err) {
        console.error('❌ Failed to save chat message:', err.message);
    }
}

// ============================================
// ===== RAG: CHUNKING & EMBEDDING HELPERS =====
// ============================================

// Split long text into overlapping chunks (~500 chars, 100 overlap).
// Tries to break on sentence boundaries so chunks don't cut mid-thought.
function chunkText(text, maxLen = 500, overlap = 100) {
    if (!text || text.length <= maxLen) return [text].filter(Boolean);

    const chunks = [];
    let start = 0;

    while (start < text.length) {
        let end = Math.min(start + maxLen, text.length);

        // Try to back up to a sentence boundary so we don't cut mid-sentence
        if (end < text.length) {
            const lookback = text.slice(start + maxLen - 120, end);
            const lastPeriod = Math.max(
                lookback.lastIndexOf('. '),
                lookback.lastIndexOf('! '),
                lookback.lastIndexOf('? '),
                lookback.lastIndexOf('\n')
            );
            if (lastPeriod > 0) {
                end = start + maxLen - 120 + lastPeriod + 1;
            } else {
                const lastSpace = text.lastIndexOf(' ', end);
                if (lastSpace > start + maxLen / 2) end = lastSpace;
            }
        }

        chunks.push(text.slice(start, end).trim());
        start = end - overlap;
        if (start < 0) start = 0;
        if (end >= text.length) break;
    }

    return chunks.filter(c => c.length > 20);   // skip tiny fragments
}

// Get a 768-dim embedding vector from Gemini
async function embedText(text) {
    const result = await ai.models.embedContent({
        model: 'gemini-embedding-001',
        contents: text
    });
    return result.embeddings[0].values;
}

// ============================================
// ===== embedText with retry + backoff =====
// ============================================
// Wraps embedText() to survive rate limits (429) and transient network errors.
// Rate-limit errors wait 60s. Network errors use exponential backoff (2s, 4s, 8s).
// Non-retryable errors (bad input, auth) throw immediately.

async function embedTextWithRetry(text, maxAttempts = 4) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await embedText(text);
        } catch (err) {
            lastErr = err;
            const msg = err.message || String(err);

            const isRateLimit =
                msg.includes('429') ||
                msg.includes('RESOURCE_EXHAUSTED') ||
                msg.includes('Resource exhausted');

            const isNetwork =
                msg.includes('fetch failed') ||
                msg.includes('ETIMEDOUT') ||
                msg.includes('ECONNRESET') ||
                msg.includes('ENOTFOUND');

            if (!isRateLimit && !isNetwork) {
                // Not a transient error — don't retry
                throw err;
            }

            if (attempt === maxAttempts) {
                // Out of attempts — give up on this chunk
                throw err;
            }

            // Rate limit → wait a full minute (free tier resets ~per minute)
            // Network  → short exponential backoff
            const waitMs = isRateLimit
                ? 60_000
                : Math.min(2_000 * Math.pow(2, attempt - 1), 30_000);

            console.warn(
                `   ⏳ Embedding retry ${attempt}/${maxAttempts} in ${waitMs / 1000}s (${msg.slice(0, 60)}…)`
            );
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
    throw lastErr;
}

// Cosine similarity between two vectors
function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ============================================
// ===== RAG: RETRIEVE RELEVANT CHUNKS =====
// ============================================
// Given a query + subject context, find the top-K most similar chunks
// from KnowledgeDocuments that match the subject/grade and are 'indexed'.

async function retrieveRelevantChunks(query, { subject, gradeLevel, stream, topK = 5 }) {
    if (!query || !subject) return [];

    try {
        const queryVec = await embedText(query);

        // Fetch candidate chunks — join to KnowledgeDocuments to filter
        const result = await sql.query`
            SELECT c.chunk_id, c.chunk_text, c.embedding, Ieverybody wanted to be,I thinkwomenspatternI willstart todoit with themobile appso we justscratchit we'll deal with the cometing power we'lldoitlater andI'm sure we candoit when wearealreadyon the system themodel team and thenas welleveryone who applied andenjoyed to apply against apply that is what the vertical superpetualmassivekneeintuitingmeshare tournament cause youbring theside let'sfindwhere yougo whenincase you did somethingmeaningful and let'sfindaway tofix youin competeon ifit'srisk predictionmodel forour knowledgebase can like just can just getanidea we willdo that we willdo like just wantanidea forward with therisk there and from there you canstart workingon therisk thingon themodel well not okay whenever you will be workingon theriskmodel and thenI'll workon theonlygymnaso we just have to uhsoit'swhere youmust just getastructure of how muchare calculated foreach period toresult and how many subjects they will be takingso for example wekeeparesult you have todowriting semester test notsimilar testingsoitmust befinalizing and weare like thoseare how you completeso aftereach seminar that's howit'sgoing to calculate aftereach termit will takeall theresults foreach subjectit's notgoing tostick over foreach subject andeach of those subjects youmust know how much you need to passourwayso that'sidiome andI will bedoing the application creationmodel and then creationmodel will catchurizeways thencurrentlymeans youarehighradical and atrisk for failure to thespecific subjectornolevel and thendoesit tellrememberit'son the teachersidedoesn'tshow thelearner what they're addressed okay yeah letit bea teacher if we catch youa teacher then letit be the teacher let's not overcomputsoit will takeeverythingit will take yourmarksagap and youdo you know that wholealgorithm that we just spoke about justmarks to calculate themarkswhere you think don't forgetas thatSBAmarkschoolbasedassessment that youmust takein consideration and then the test and then theassignments and then exams and your attendants like dateso which is what depends to thefifteen say okay thedomestic like this there they whatmattersare like thisstudentengineer cando withit we cannotspeak togenerate dataall for more than how manystudents can see thespecific number for how theybring the team isgoing to work for time oneusing oneresult and then we'llkeepongenerity we'll just ask togenerate and then you justkeepon testing foreach table until until we get to thefinal example becauseitgenerates one which hasall of the terms thatmeans you want to know how tomove forward youwon't know how to tell thestudents let'sdo this and thisonly for some forwardassessmentit is alsoaround the team ofacodemax thatmust bea somesort of labelling that saysmeaning that we have tokeep to work outlong we will be more comprocessmaximuminhighschool is that you will havemaybean Exceldocument ofall thestudents andresults that they could haveempress and thosemarks namewhereit'smissingmarks they don't consider them themarkinto calculation youstilladministrativeairshare tosort outon the teachers andourschoolsideso what you cando is just createa Cfile that will havealist ofmarks sayit's foreternalhalf this thing isgoing to be complicated butit will havemaybe sayalist ofamarks likestudentswhetherinaspecificrate and then we would have the attributes this is theassignmentmark this is the testmark this is your attends you canimportit there and then that part of the data will comein for the predictionmodeleach of those data that you have there you can categorize them andput them properlymakingput themusingPython which is thebanda and cyclicsoaccording to thismature union was notgoing toroom the prediction was not working was fortyit wasmissinga subjectnoit was notwakened because we wereusing the subject like overallsince you wereusing the subject torisk you canremove the one of predictrisk was that that one is like for overall but you want the one fora subject yeahI cana subject uhare wegoingastudent of the subject that youarefront of the datasitesucha subject subjecting thatonly upload will be uploadingon your various programs like you just talk aboutschoolschoolassignmentso if you'reheavilyassignment you'regoing to uploadall theassignmentsyes wemust just make sure thatour attributes canmatch what we'regoing to makeinourdocumentsour CSso yourmismatchsoitmeans youarestillgoing through attributesgoing to have themark and the attendance is at which themark nowI think whenIuse themit'sa tyes and the attendantso youstill to attributeinto different typesare subject tofunction foritsreduce wewon't makeitintoa database we want to giveitasaCSVmakingit toa database you don't haveaSD byR teachers attached to the subject thestudents thatare taking the subjectdo you want toseparateit like that and createaskin nowI geta how we weredoing anything withouta database is that we have we'd have likealist ofstudentswhetheralist ofstudentsare you don't know what you said andhe saidso youarea musicmeans connected to yeahI did but the problemI saw there said youmustuseajobserver you don't know that you canuse you don't know that particularshe needs the waterbottle there'sno water system before youmeanin themorning if you willeasilyso that you canwrite first first by tooall bedone but somebody said seven and sevenit's eightit's nineepisoderesults to thismatter becauseI know there'sinsertsonit for somebody'sgoing toshow thatholdshewent this isallIdo open this is yourusername this is not just whenI turned offmyhospital is this oneshape there is notagirl connectedsecuringa crossnight
                   d.material_id, d.title AS material_title
            FROM ContentChunks c
            INNER JOIN KnowledgeDocuments d ON d.doc_id = c.doc_id
            WHERE d.status = 'indexed'
              AND d.subject = ${subject}
              AND (d.grade_level = ${gradeLevel} OR d.grade_level = 'All Grades')
             
        `;

        if (result.recordset.length === 0) return [];

        // Score each chunk by cosine similarity
        const scored = result.recordset.map(row => {
            let vec = [];
            try { vec = JSON.parse(row.embedding); } catch (_) { }
            return {
                chunk_id: row.chunk_id,
                chunk_text: row.chunk_text,
                material_id: row.material_id,
                material_title: row.material_title,
                score: cosineSimilarity(queryVec, vec)
            };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    } catch (err) {
        console.error("❌ retrieveRelevantChunks error:", err.message);
        return [];
    }
}


// Compute SHA-256 hash of a file (to skip re-indexing unchanged files)
function fileHash(filePath) {
    const crypto = require('crypto');
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}


// ============================================
// ===== officeparser compatibility wrapper =====
// ============================================
// Different versions of officeparser export their API in different ways.
// This wrapper tries every known shape.

async function runOfficeParser(filePath) {
    const mod = require('officeparser');

    // Shape 1: named export (most common in v5+)
    if (typeof mod.parseOfficeAsync === 'function') {
        return await mod.parseOfficeAsync(filePath);
    }

    // Shape 2: default export object with parseOfficeAsync
    if (mod.default && typeof mod.default.parseOfficeAsync === 'function') {
        return await mod.default.parseOfficeAsync(filePath);
    }

    // Shape 3: callback-based parseOffice
    if (typeof mod.parseOffice === 'function') {
        return await new Promise((resolve, reject) => {
            mod.parseOffice(filePath, (data, err) => {
                if (err) return reject(err);
                resolve(data);
            });
        });
    }

    // Shape 4: default export is itself a callback function
    if (mod.default && typeof mod.default === 'function') {
        return await new Promise((resolve, reject) => {
            mod.default(filePath, (data, err) => {
                if (err) return reject(err);
                resolve(data);
            });
        });
    }

    throw new Error('officeparser: no usable parse function found. Available keys: ' + Object.keys(mod).join(', '));
}

// ============================================
// ===== extractTextFromFile =====
// ============================================
// Extracts plain text from an uploaded file for moderation + RAG indexing.
// Handles .txt/.md/.csv, .docx, .pdf, .pptx, .xlsx. Returns '' for unsupported types.

async function extractTextFromFile(filePath) {
    const lower = filePath.toLowerCase();

    // ---- Plain text ----
    if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')) {
        return fs.readFileSync(filePath, 'utf8');
    }

    // ---- DOCX via mammoth ----
    if (lower.endsWith('.docx')) {
        const r = await mammoth.extractRawText({ path: filePath });
        return r.value || '';
    }

    // ---- PDF: try pdf-parse, fall back to officeparser ----
    if (lower.endsWith('.pdf')) {
        try {
            const pdfMod = require('pdf-parse');
            const pdfParse = pdfMod.default || pdfMod;
            if (typeof pdfParse === 'function') {
                const buf = fs.readFileSync(filePath);
                const r = await pdfParse(buf);
                if (r && r.text && r.text.trim().length > 50) {
                    console.log(`   pdf-parse OK: ${r.text.length} chars`);
                    return r.text;
                }
                console.log(`   pdf-parse returned little text (${r?.text?.length || 0} chars), falling back to officeparser`);
            }
        } catch (e) {
            console.warn('   pdf-parse failed:', e.message);
        }
        return await runOfficeParser(filePath);
    }

    // ---- PPTX / XLSX via officeparser ----
    if (lower.endsWith('.pptx') || lower.endsWith('.xlsx')) {
        return await runOfficeParser(filePath);
    }

    return '';
}

async function logActivity(user_email, user_name, role, action, details = '') {
    try {
        await sql.query`
            INSERT INTO ActivityLogs (user_email, user_name, role, action, details)
            VALUES (${user_email}, ${user_name}, ${role}, ${action}, ${details})
        `;
    } catch (err) {
        console.error('Error logging activity:', err);
    }
}

async function indexStudyMaterial({ materialId, title, subject, gradeLevel, stream, materialType, filePath }) {
    const abs = path.join(__dirname, 'public', filePath);

    if (!fs.existsSync(abs)) {
        throw new Error(`File not found on disk: ${abs}`);
    }

    const hash = fileHash(abs);

    // ---- Check if we already indexed this exact file ----
    const existing = await sql.query`
        SELECT doc_id, file_hash, status 
        FROM KnowledgeDocuments 
        WHERE source = 'material' AND material_id = ${materialId}
    `;

    if (existing.recordset.length > 0) {
        const prev = existing.recordset[0];
        if (prev.status === 'indexed' && prev.file_hash === hash) {
            console.log(`⏭️ Skipping re-index — file unchanged (material #${materialId})`);
            return { skipped: true };
        }
        await sql.query`DELETE FROM ContentChunks WHERE doc_id = ${prev.doc_id}`;
        await sql.query`DELETE FROM KnowledgeDocuments WHERE doc_id = ${prev.doc_id}`;
    }

    // ---- Create the KnowledgeDocuments row ----
    const docResult = await sql.query`
        INSERT INTO KnowledgeDocuments 
            (source, material_id, title, subject, grade_level, material_type, file_path, file_hash, status)
        OUTPUT INSERTED.doc_id
        VALUES 
            ('material', ${materialId}, ${title}, ${subject}, ${gradeLevel}, ${materialType}, ${filePath}, ${hash}, 'pending')
    `;
    const docId = docResult.recordset[0].doc_id;

    try {
        const raw = await extractTextFromFile(abs);
        const rawText = typeof raw === 'string' ? raw : '';
        if (!rawText.trim()) {
            throw new Error('No readable text found in file (may be a scanned image).');
        }
        console.log(`📄 ${title}: extracted ${rawText.length} chars`);

        const chunks = chunkText(rawText, 500, 100);
        console.log(`✂️ ${title}: split into ${chunks.length} chunks`);

        if (chunks.length === 0) {
            throw new Error('Chunking produced 0 chunks.');
        }

        // ---- Rate-limit parameters ----
        // Free tier: ~100 req/min. We pause after every 50 to stay well under.
        // If you upgrade to a paid tier later, raise BATCH_SIZE and lower BATCH_PAUSE_MS.
        const BATCH_SIZE = 50;
        const BATCH_PAUSE_MS = 60_000;

        let inserted = 0;
        let failed = 0;

        for (let i = 0; i < chunks.length; i++) {
            const text = `[${title}] ${chunks[i]}`;
            try {
                const vec = await embedTextWithRetry(text);
                await sql.query`
                    INSERT INTO ContentChunks 
                        (doc_id, chunk_index, chunk_text, embedding, token_count)
                    VALUES 
                        (${docId}, ${i}, ${text}, ${JSON.stringify(vec)}, ${Math.ceil(text.length / 4)})
                `;
                inserted++;

                // Progress report every 25 chunks
                if (inserted % 25 === 0) {
                    console.log(`   ⏳ ${inserted}/${chunks.length} chunks embedded…`);
                }

                // Long pause every BATCH_SIZE chunks to stay under the free-tier rate limit
                if (inserted % BATCH_SIZE === 0 && i < chunks.length - 1) {
                    console.log(`   ⏸️  Pausing ${BATCH_PAUSE_MS / 1000}s to avoid Gemini rate limit…`);
                    await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
                }
            } catch (embErr) {
                failed++;
                console.error(`⚠️ Chunk ${i} failed permanently:`, embErr.message);
            }
        }

        // ---- Set the correct status based on results ----
        let finalStatus;
        if (failed === 0) {
            finalStatus = 'indexed';
        } else if (inserted === 0) {
            finalStatus = 'failed';
        } else {
            finalStatus = 'partial';
        }

        await sql.query`
            UPDATE KnowledgeDocuments 
            SET total_chunks = ${inserted},
                status = ${finalStatus},
                error_message = ${failed > 0 ? `${failed} of ${chunks.length} chunks failed to embed` : null},
                indexed_at = GETDATE()
            WHERE doc_id = ${docId}
        `;

        console.log(`✅ Finished: ${inserted} chunks indexed, ${failed} failed. Status: ${finalStatus}`);
        return { docId, chunks: inserted, failed, status: finalStatus };

    } catch (err) {
        await sql.query`
            UPDATE KnowledgeDocuments 
            SET status = 'failed', error_message = ${err.message}
            WHERE doc_id = ${docId}
        `;
        throw err;
    }
}

// ============================================
// ===== RAG: INDEX A KNOWLEDGE BASE DOC =====
// ============================================
// Indexes a document the teacher uploaded directly for the AI (learners don't see it).
// Writes source='kb' on the KnowledgeDocuments row.
async function indexKnowledgeBaseDoc({ kbId, title, subject, gradeLevel, docType, filePath }) {
    const abs = path.join(__dirname, 'public', filePath);

    if (!fs.existsSync(abs)) {
        throw new Error(`File not found on disk: ${abs}`);
    }

    const hash = fileHash(abs);

    // ---- Check if we already indexed this exact KB doc ----
    const existing = await sql.query`
        SELECT doc_id, file_hash, status 
        FROM KnowledgeDocuments 
        WHERE source = 'kb' AND kb_id = ${kbId}
    `;

    if (existing.recordset.length > 0) {
        const prev = existing.recordset[0];
        if (prev.status === 'indexed' && prev.file_hash === hash) {
            console.log(`⏭️ Skipping re-index — KB doc unchanged (kb #${kbId})`);
            return { skipped: true };
        }
        await sql.query`DELETE FROM ContentChunks WHERE doc_id = ${prev.doc_id}`;
        await sql.query`DELETE FROM KnowledgeDocuments WHERE doc_id = ${prev.doc_id}`;
    }

    // ---- Create the KnowledgeDocuments row ----
    const docResult = await sql.query`
        INSERT INTO KnowledgeDocuments 
            (source, kb_id, title, subject, grade_level, material_type, file_path, file_hash, status)
        OUTPUT INSERTED.doc_id
        VALUES 
            ('kb', ${kbId}, ${title}, ${subject}, ${gradeLevel}, ${docType}, ${filePath}, ${hash}, 'pending')
    `;
    const docId = docResult.recordset[0].doc_id;

    try {
        const raw = await extractTextFromFile(abs);
        const rawText = typeof raw === 'string' ? raw : '';
        if (!rawText.trim()) {
            throw new Error('No readable text found in file (may be a scanned image).');
        }
        console.log(`📄 [KB] ${title}: extracted ${rawText.length} chars`);

        const chunks = chunkText(rawText, 500, 100);
        console.log(`✂️ [KB] ${title}: split into ${chunks.length} chunks`);

        if (chunks.length === 0) {
            throw new Error('Chunking produced 0 chunks.');
        }

        let inserted = 0;
        for (let i = 0; i < chunks.length; i++) {
            const text = `[${title}] ${chunks[i]}`;
            try {
                const vec = await embedText(text);
                await sql.query`
                    INSERT INTO ContentChunks 
                        (doc_id, chunk_index, chunk_text, embedding, token_count)
                    VALUES 
                        (${docId}, ${i}, ${text}, ${JSON.stringify(vec)}, ${Math.ceil(text.length / 4)})
                `;
                inserted++;
            } catch (embErr) {
                console.error(`⚠️ [KB] Embedding failed on chunk ${i}:`, embErr.message);
            }
        }

        await sql.query`
            UPDATE KnowledgeDocuments 
            SET total_chunks = ${inserted}, status = 'indexed', indexed_at = GETDATE()
            WHERE doc_id = ${docId}
        `;

        // ---- Also save the file hash to the KB row for future deduplication ----
        await sql.query`
            UPDATE TeacherKnowledgeBase 
            SET file_hash = ${hash}, doc_id = ${docId}, status = 'indexed', indexed_at = GETDATE()
            WHERE kb_id = ${kbId}
        `;

        console.log(`✅ [KB] Indexed kb #${kbId} ("${title}") → doc #${docId}, ${inserted} chunks`);
        return { docId, chunks: inserted };

    } catch (err) {
        await sql.query`
            UPDATE KnowledgeDocuments 
            SET status = 'failed', error_message = ${err.message}
            WHERE doc_id = ${docId}
        `;
        await sql.query`
            UPDATE TeacherKnowledgeBase 
            SET status = 'failed', error_message = ${err.message}
            WHERE kb_id = ${kbId}
        `;
        throw err;
    }
}


// ============================================
// ===== AUTH ROUTES =====
// ============================================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "Login.html"));
});


app.post("/login", loginLimiter, async (req, res) => {
    const { email, password } = req.body;

    try {
        let user = null;
        let role = '';

        let result = await sql.query`
            SELECT * FROM Learners WHERE email = ${email}
        `;
        if (result.recordset.length > 0) {
            user = result.recordset[0];
            role = 'Learner';
        }

        if (!user) {
            result = await sql.query`
                SELECT * FROM Teachers WHERE email = ${email}
            `;
            if (result.recordset.length > 0) {
                user = result.recordset[0];
                role = 'teacher';
            }
        }

        if (!user) {
            result = await sql.query`
                SELECT * FROM Admins WHERE email = ${email}
            `;
            if (result.recordset.length > 0) {
                user = result.recordset[0];
                role = 'admin';
            }
        }


        if (!user) {
            return res.json({ success: false, message: "User not found" });
        }

        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.json({ success: false, message: "Wrong password" });
        }

        user.role = role;

        // Create a signed JWT for this session
        const token = jwt.sign(
            { email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
        );

        // ---- Remove the password hash before sending to the browser ----
        delete user.password;

        await logActivity(user.email, user.full_name, role, 'Logged in');
        res.json({
            success: true,
            message: "Login successful",
            token,
            user
        });

    } catch (err) {
        console.error("Login error:", err);
        res.json({ success: false, message: "Database error" });
    }
});

// ============================================
// ===== PASSWORD RESET ROUTES =====
// ============================================

app.post("/send-reset-code", resetLimiter, async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.json({ success: false, message: "Please enter your email" });
    }

    try {
        let user = null;

        let result = await sql.query`
            SELECT * FROM Learners WHERE email = ${email}
        `;
        if (result.recordset.length > 0) {
            user = result.recordset[0];
        }

        if (!user) {
            result = await sql.query`
                SELECT * FROM Teachers WHERE email = ${email}
            `;
            if (result.recordset.length > 0) {
                user = result.recordset[0];
            }
        }

        if (!user) {
            result = await sql.query`
                SELECT * FROM Admins WHERE email = ${email}
            `;
            if (result.recordset.length > 0) {
                user = result.recordset[0];
            }
        }

        if (!user) {
            return res.json({ success: false, message: "User not found" });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        resetCodes.set(email, { code, expires: Date.now() + 10 * 60 * 1000 });

        await transporter.sendMail({
            from: "Taxila Learning Hub <lusunzirinae21@gmail.com>",
            to: email,
            subject: "Your password reset code",
            text: `Your verification code is ${code}. It expires in 10 minutes.`
        });

        res.json({ success: true, message: "Verification code sent to your email" });
    } catch (err) {
        console.log(err);
        res.json({ success: false, message: "Failed to send verification code" });
    }
});

app.post("/reset-password", resetLimiter, async (req, res) => {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
        return res.json({ success: false, message: "Fill all fields" });
    }

    const stored = resetCodes.get(email);

    if (!stored || stored.code !== code) {
        return res.json({ success: false, message: "Invalid verification code" });
    }

    if (Date.now() > stored.expires) {
        resetCodes.delete(email);
        return res.json({ success: false, message: "Verification code has expired" });
    }

    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        let updated = false;

        let result = await sql.query`
            UPDATE Learners SET password = ${hashedPassword} WHERE email = ${email}
        `;
        if (result.rowsAffected[0] > 0) updated = true;

        if (!updated) {
            result = await sql.query`
                UPDATE Teachers SET password = ${hashedPassword} WHERE email = ${email}
            `;
            if (result.rowsAffected[0] > 0) updated = true;
        }

        if (!updated) {
            result = await sql.query`
                UPDATE Admins SET password = ${hashedPassword} WHERE email = ${email}
            `;
            if (result.rowsAffected[0] > 0) updated = true;
        }


        if (!updated) {
            return res.json({ success: false, message: "User not found" });
        }

        resetCodes.delete(email);
        res.json({ success: true, message: "Password updated successfully" });

    } catch (err) {
        console.log(err);
        res.json({ success: false, message: "Error resetting password" });
    }
});

// ============================================
// ===== ANNOUNCEMENT ROUTES =====
// ============================================
app.post("/add-announcement", requireAuth, async (req, res) => {
    const { title, message, sendSms, grade, stream, subject, posted_by } = req.body;

    if (!title || !message) {
        return res.json({ success: false, message: "Please fill all fields" });
    }

    try {
        await sql.query`
            INSERT INTO Announcements (title, message, grade_level, stream, subject, posted_by)
            VALUES (${title}, ${message}, ${grade}, ${stream}, ${subject}, ${posted_by})
        `;

        if (sendSms === true || sendSms === 'true') {
            try {
                const result = await sql.query`
                    SELECT full_name, email, phone_number 
                    FROM Parents 
                    WHERE learner_grade = ${grade} 
                    AND phone_number IS NOT NULL
                `;

                const recipients = result.recordset;

                console.log(`📱 Found ${recipients.length} parents in ${grade}`);

                // Build the SMS body once (so it's logged as sent)
                const smsBody = `📢 ${title}\n\n${message}\n\n- Taxila Learning Hub`;

                // Insert the log row FIRST with 'pending' status
                const logResult = await sql.query`
                    INSERT INTO SmsLogs 
                        (announcement_title, message, grade, recipients_count, failed_count, status, created_by)
                    OUTPUT INSERTED.sms_id
                    VALUES 
                        (${title}, ${smsBody}, ${grade}, ${recipients.length}, 0, 'pending', ${posted_by || 'Admin'})
                `;
                const smsId = logResult.recordset[0].sms_id;

                let sentCount = 0;
                let failedCount = 0;

                for (const parent of recipients) {
                    if (!parent.phone_number) {
                        failedCount++;
                        continue;
                    }
                    try {
                        await sendSms(parent.phone_number, smsBody);
                        sentCount++;
                        console.log(`✅ SMS sent to ${parent.phone_number}`);
                    } catch (err) {
                        failedCount++;
                        console.error(`❌ Failed to send SMS to ${parent.phone_number}:`, err.message);
                    }
                }

                // Decide final status
                let finalStatus;
                if (failedCount === 0) finalStatus = 'sent';
                else if (sentCount === 0) finalStatus = 'failed';
                else finalStatus = 'partial';

                // Update the same row by sms_id — reliable, no fragile WHERE clause
                await sql.query`
                    UPDATE SmsLogs 
                    SET status = ${finalStatus},
                        failed_count = ${failedCount}
                    WHERE sms_id = ${smsId}
                `;

                console.log(`📝 SmsLogs #${smsId}: status=${finalStatus}, sent=${sentCount}, failed=${failedCount}`);

            } catch (smsError) {
                console.error("❌ SMS notification error:", smsError);
            }
        }

        await logActivity(posted_by, posted_by, 'teacher', 'Posted announcement', `Title: ${title}, Grade: ${grade}`);

        res.json({ success: true, message: "Announcement posted successfully" });

    } catch (err) {
        console.log(err);
        res.json({ success: false, message: "Failed to post announcement" });
    }
});

app.get("/announcements", async (req, res) => {
    try {
        const grade = req.query.grade;
        const stream = req.query.stream;
        const subject = req.query.subject;

        let query;
        if (grade && stream && subject && subject !== 'All Subjects') {
            query = sql.query`
                SELECT * FROM Announcements 
                WHERE (grade_level = ${grade} 
                AND (stream = ${stream} OR stream = 'All Streams' OR stream IS NULL OR stream = '')
                AND (subject = ${subject} OR subject = 'All Subjects' OR subject IS NULL OR subject = ''))
                OR grade_level = 'All Grades'
                ORDER BY announcement_id DESC
            `;
        } else if (grade && stream) {
            query = sql.query`
                SELECT * FROM Announcements 
                WHERE (grade_level = ${grade} 
                AND (stream = ${stream} OR stream = 'All Streams' OR stream IS NULL OR stream = ''))
                OR grade_level = 'All Grades'
                ORDER BY announcement_id DESC
            `;
        } else if (grade) {
            query = sql.query`
                SELECT * FROM Announcements 
                WHERE grade_level = ${grade} OR grade_level = 'All Grades'
                ORDER BY announcement_id DESC
            `;
        } else {
            query = sql.query`
                SELECT * FROM Announcements 
                ORDER BY announcement_id DESC
            `;
        }

        const result = await query;
        res.json(result.recordset);
    } catch (err) {
        console.log(err);
        res.json([]);
    }
});

app.delete("/delete-announcement/:id", async (req, res) => {
    const id = req.params.id;

    try {
        await sql.query`
            DELETE FROM Announcements WHERE announcement_id = ${id}
        `;

        res.json({ success: true, message: "Announcement deleted successfully" });
    } catch (err) {
        console.log(err);
        res.json({ success: false, message: "Failed to delete announcement" });
    }
});

// ============================================
// ===== HOMEWORK ROUTES =====
// ============================================

const storage = multer.diskStorage({
    destination: "public/uploads/",
    filename: function (req, file, cb) {
        cb(null, Date.now() + "-" + file.originalname);
    }
});

const upload = multer({ storage: storage });

app.post("/upload-homework", requireAuth, upload.single("file"), async (req, res) => {
    try {
        console.log("📝 Request body:", req.body);
        console.log("📎 File:", req.file);

        const { title, description, grade_level, stream, subject, uploaded_by } = req.body;

        if (!title || !grade_level) {
            console.log("❌ Missing fields:", { title, grade_level });
            return res.json({ success: false, message: "Please fill all required fields" });
        }

        const file_path = "/uploads/" + req.file.filename;


        console.log("📝 Inserting into database:", { title, description, grade_level, stream, subject, file_path, uploaded_by });

        await sql.query`
            INSERT INTO Homework (title, description, grade_level, stream, subject, file_path, uploaded_by)
            VALUES (${title}, ${description}, ${grade_level}, ${stream}, ${subject}, ${file_path}, ${uploaded_by})
        `;

        await logActivity(uploaded_by, uploaded_by, 'teacher', 'Uploaded homework', `Title: ${title}, Grade: ${grade_level}`);


        res.json({
            success: true,
            message: "Homework uploaded successfully"
        });
    } catch (err) {
        console.error("❌ Upload error:", err);
        res.json({ success: false, message: "Upload failed: " + err.message });
    }
});

app.get("/homework", async (req, res) => {
    try {
        const grade = req.query.grade;
        const stream = req.query.stream;
        const subject = req.query.subject;

        let query;
        if (grade && stream && subject && subject !== 'All Subjects') {
            query = sql.query`
                SELECT * FROM Homework 
                WHERE (grade_level = ${grade} 
                AND (stream = ${stream} OR stream = 'All Streams' OR stream IS NULL OR stream = '')
                AND (subject = ${subject} OR subject = 'All Subjects' OR subject IS NULL OR subject = ''))
                OR grade_level = 'All Grades'
                ORDER BY homework_id DESC
            `;
        } else if (grade && stream) {
            query = sql.query`
                SELECT * FROM Homework 
                WHERE (grade_level = ${grade} 
                AND (stream = ${stream} OR stream = 'All Streams' OR stream IS NULL OR stream = ''))
                OR grade_level = 'All Grades'
                ORDER BY homework_id DESC
            `;
        } else if (grade) {
            query = sql.query`
                SELECT * FROM Homework 
                WHERE grade_level = ${grade} OR grade_level = 'All Grades'
                ORDER BY homework_id DESC
            `;
        } else {
            query = sql.query`
                SELECT * FROM Homework 
                ORDER BY homework_id DESC
            `;
        }

        const result = await query;
        res.json(result.recordset);
    } catch (err) {
        res.json([]);
    }
});

app.delete("/delete-homework/:id", async (req, res) => {
    const id = req.params.id;

    try {
        await sql.query`
            DELETE FROM Homework WHERE homework_id = ${id}
        `;

        res.json({ success: true, message: "Homework deleted successfully" });
    } catch (err) {
        console.log(err);
        res.json({ success: false, message: "Failed to delete homework" });
    }
});

// ============================================
// ===== STUDY MATERIAL ROUTES =====
// ============================================

const studyStorage = multer.diskStorage({
    destination: "public/uploads/",
    filename: function (req, file, cb) {
        cb(null, Date.now() + "-" + file.originalname);
    }
});

const uploadStudy = multer({ storage: studyStorage });

app.post("/upload-study-material", uploadStudy.single("file"), async (req, res) => {
    try {
        console.log("📝 Study Material Request body:", req.body);
        console.log("📎 File:", req.file);

        const { title, description, grade_level, stream, subject, material_type, uploaded_by } = req.body;

        if (!title || !grade_level) {
            console.log("❌ Missing fields:", { title, grade_level });
            return res.json({ success: false, message: "Please fill all required fields" });
        }

        let file_path = null;
        if (req.file) {
            file_path = "/uploads/" + req.file.filename;
        }


        // ---- Insert into StudyMaterials AND capture the new material_id ----
        const insertResult = await sql.query`
            INSERT INTO StudyMaterials (title, description, grade_level, stream, subject, material_type, file_path, uploaded_by)
            OUTPUT INSERTED.material_id
            VALUES (${title}, ${description}, ${grade_level}, ${stream}, ${subject}, ${material_type}, ${file_path}, ${uploaded_by})
        `;

        const materialId = insertResult.recordset[0].material_id;
        console.log(`📚 Study material #${materialId} saved.`);

        await logActivity(uploaded_by, uploaded_by, 'teacher', 'Uploaded study material', `Title: ${title}, Grade: ${grade_level}`);


        // ---- RAG: index this material's text into KnowledgeDocuments + ContentChunks ----
        if (file_path) {
            try {
                await indexStudyMaterial({
                    materialId,
                    title,
                    subject,
                    gradeLevel: grade_level,
                    stream,
                    materialType: material_type,
                    filePath: file_path
                });
            } catch (idxErr) {
                console.error("⚠️ RAG indexing failed (non-fatal):", idxErr.message);
                try {
                    await sql.query`
                        INSERT INTO KnowledgeDocuments 
                            (material_id, title, subject, grade_level, stream, material_type, file_path, status, error_message)
                        VALUES 
                            (${materialId}, ${title}, ${subject}, ${grade_level}, ${stream}, ${material_type}, ${file_path}, 'failed', ${idxErr.message})
                    `;
                } catch (_) { /* swallow */ }
            }
        }

        res.json({
            success: true,
            message: "Study material uploaded successfully"
        });
    } catch (err) {
        console.error("❌ Upload error:", err);
        res.json({ success: false, message: "Upload failed: " + err.message });
    }
});

// ============================================
// ===== TEACHER KNOWLEDGE BASE: UPLOAD =====
// ============================================
// Teachers upload files here that only the AI will read (textbooks, CAPS docs, guides).
// Learners never see these. Files get indexed into the RAG pipeline.

app.post("/upload-knowledge-base", uploadStudy.single("file"), async (req, res) => {
    try {
        console.log("📚 KB upload request body:", req.body);
        console.log("📎 File:", req.file);

        const { teacher_email, title, description, subject, grade_level, doc_type } = req.body;

        // ---- Basic validation ----
        if (!teacher_email) {
            return res.json({ success: false, message: "teacher_email is required" });
        }
        if (!title) {
            return res.json({ success: false, message: "Title is required" });
        }
        if (!req.file) {
            return res.json({ success: false, message: "Please attach a file" });
        }

        const file_path = "/uploads/" + req.file.filename;

        // ---- Insert the KB record ----
        const insertResult = await sql.query`
            INSERT INTO TeacherKnowledgeBase 
                (teacher_email, title, description, subject, grade_level, doc_type, file_path, status)
            OUTPUT INSERTED.kb_id
            VALUES 
                (${teacher_email}, ${title}, ${description || null}, ${subject || null}, 
                 ${grade_level || null}, ${doc_type || 'other'}, ${file_path}, 'pending')
        `;

        const kbId = insertResult.recordset[0].kb_id;
        console.log(`📚 KB doc #${kbId} saved by ${teacher_email}.`);

        // ---- Log activity (non-fatal if it fails) ----
        try {
            await logActivity(
                teacher_email, teacher_email, 'teacher',
                'Uploaded knowledge base doc',
                `Title: ${title}, Doc #${kbId}`
            );
        } catch (logErr) {
            console.warn("⚠️ Activity log failed (non-fatal):", logErr.message);
        }

        // ---- Index into the RAG pipeline ----
        try {
            const result = await indexKnowledgeBaseDoc({
                kbId,
                title,
                subject,
                gradeLevel: grade_level,
                docType: doc_type || 'other',
                filePath: file_path
            });

            // ---- Update KB row with the doc_id link ----
            if (result.docId) {
                await sql.query`
                    UPDATE TeacherKnowledgeBase 
                    SET doc_id = ${result.docId}, 
                        status = 'indexed', 
                        indexed_at = GETDATE()
                    WHERE kb_id = ${kbId}
                `;
            }

            res.json({
                success: true,
                message: `Knowledge base document uploaded and indexed (${result.chunks || 0} chunks).`,
                kb_id: kbId,
                chunks: result.chunks || 0
            });

        } catch (idxErr) {
            console.error("⚠️ RAG indexing failed (non-fatal):", idxErr.message);

            await sql.query`
                UPDATE TeacherKnowledgeBase 
                SET status = 'failed', error_message = ${idxErr.message}
                WHERE kb_id = ${kbId}
            `;

            res.json({
                success: true,
                message: "File uploaded but AI indexing failed: " + idxErr.message,
                kb_id: kbId,
                warning: true
            });
        }

    } catch (err) {
        console.error("❌ KB upload error:", err);
        res.json({ success: false, message: "Upload failed: " + err.message });
    }
});

// ============================================
// ===== TEACHER KNOWLEDGE BASE: LIST =====
// ============================================
// Returns all KB documents uploaded by a specific teacher.

app.get("/knowledge-base/:teacherEmail", async (req, res) => {
    const teacherEmail = req.params.teacherEmail;

    if (!teacherEmail) {
        return res.json({ success: false, message: "teacherEmail is required" });
    }

    try {
        const result = await sql.query`
            SELECT 
                kb_id, title, description, subject, grade_level,
                doc_type, file_path, doc_id, status, error_message,
                indexed_at, created_at,
                (SELECT COUNT(*) FROM ContentChunks WHERE doc_id = k.doc_id) AS chunk_count
            FROM TeacherKnowledgeBase k
            WHERE teacher_email = ${teacherEmail}
            ORDER BY created_at DESC
        `;

        res.json({ success: true, docs: result.recordset });
    } catch (err) {
        console.error("❌ KB list error:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== TEACHER KNOWLEDGE BASE: DELETE =====
// ============================================
// Removes a KB doc and its RAG index entries.
// Only the teacher who uploaded it can delete it.

app.delete("/delete-knowledge-base/:kbId", async (req, res) => {
    const kbId = req.params.kbId;
    const teacherEmail = req.query.teacher_email;

    if (!teacherEmail) {
        return res.json({ success: false, message: "teacher_email is required" });
    }

    try {
        // ---- Verify ownership ----
        const check = await sql.query`
            SELECT kb_id, doc_id, file_path 
            FROM TeacherKnowledgeBase 
            WHERE kb_id = ${kbId} AND teacher_email = ${teacherEmail}
        `;

        if (check.recordset.length === 0) {
            return res.json({
                success: false,
                message: "Not found, or you don't have permission to delete this."
            });
        }

        const { doc_id, file_path } = check.recordset[0];

        // ---- Delete chunks (if doc_id exists) ----
        if (doc_id) {
            await sql.query`DELETE FROM ContentChunks WHERE doc_id = ${doc_id}`;
        }

        // ---- Delete the KnowledgeDocuments row ----
        if (doc_id) {
            await sql.query`DELETE FROM KnowledgeDocuments WHERE doc_id = ${doc_id}`;
        }

        // ---- Delete the KB row ----
        await sql.query`DELETE FROM TeacherKnowledgeBase WHERE kb_id = ${kbId}`;

        // ---- Delete the physical file (best effort) ----
        if (file_path) {
            try {
                const abs = path.join(__dirname, 'public', file_path);
                if (fs.existsSync(abs)) {
                    fs.unlinkSync(abs);
                    console.log(`🗑️ Removed file: ${abs}`);
                }
            } catch (fileErr) {
                console.warn("⚠️ Could not delete file (non-fatal):", fileErr.message);
            }
        }

        console.log(`✅ KB doc #${kbId} deleted by ${teacherEmail}`);
        res.json({ success: true, message: "Knowledge base document deleted." });

    } catch (err) {
        console.error("❌ KB delete error:", err);
        res.json({ success: false, message: err.message });
    }
});

app.get("/study-materials", async (req, res) => {
    try {
        const grade = req.query.grade;
        const stream = req.query.stream;
        const subject = req.query.subject;

        let query;
        if (grade && stream && subject && subject !== 'All Subjects') {
            query = sql.query`
                SELECT * FROM StudyMaterials 
                WHERE (grade_level = ${grade} 
                AND (stream = ${stream} OR stream = 'All Streams' OR stream IS NULL OR stream = '')
                AND (subject = ${subject} OR subject = 'All Subjects' OR subject IS NULL OR subject = ''))
                OR grade_level = 'All Grades'
                ORDER BY created_at DESC
            `;
        } else if (grade && stream) {
            query = sql.query`
                SELECT * FROM StudyMaterials 
                WHERE (grade_level = ${grade} 
                AND (stream = ${stream} OR stream = 'All Streams' OR stream IS NULL OR stream = ''))
                OR grade_level = 'All Grades'
                ORDER BY created_at DESC
            `;
        } else if (grade) {
            query = sql.query`
                SELECT * FROM StudyMaterials 
                WHERE grade_level = ${grade} OR grade_level = 'All Grades'
                ORDER BY created_at DESC
            `;
        } else {
            query = sql.query`
                SELECT * FROM StudyMaterials 
                ORDER BY created_at DESC
            `;
        }

        const result = await query;
        res.json(result.recordset);
    } catch (err) {
        console.error("Error fetching study materials:", err);
        res.json([]);
    }
});

app.delete("/delete-study-material/:id", async (req, res) => {
    const id = req.params.id;

    try {
        await sql.query`
            DELETE FROM StudyMaterials WHERE material_id = ${id}
        `;
        res.json({ success: true, message: "Study material deleted successfully" });
    } catch (err) {
        console.error("Error deleting study material:", err);
        res.json({ success: false, message: "Failed to delete study material" });
    }
});

// ============================================
// ===== USER MANAGEMENT ROUTES =====
// ============================================

app.get("/users", requireAuth, async (req, res) => {
    try {
        const learners = await sql.query`
            SELECT learner_id as id, full_name, email, 'Learner' as role, grade_level, stream 
            FROM Learners
        `;

        const teachers = await sql.query`
            SELECT teacher_id as id, full_name, email, 'teacher' as role, NULL as grade_level, NULL as stream
            FROM Teachers
        `;

        const admins = await sql.query`
            SELECT admin_id as id, full_name, email, 'admin' as role, NULL as grade_level, NULL as stream
            FROM Admins
        `;

        const parents = await sql.query`
            SELECT parent_id as id, full_name, email, 'parent' as role, learner_grade as grade_level, NULL as stream
            FROM Parents
        `;

        const allUsers = [...learners.recordset, ...teachers.recordset, ...admins.recordset, ...parents.recordset];

        res.json(allUsers);
    } catch (err) {
        console.error("Error fetching users:", err);
        res.json([]);
    }
});

app.delete("/users/:id", requireAuth, async (req, res) => {
    const id = req.params.id;
    const { role } = req.body;

    try {
        if (role === 'Learner') {
            await sql.query`DELETE FROM Learners WHERE learner_id = ${id}`;
        } else if (role === 'teacher') {
            await sql.query`DELETE FROM Teachers WHERE teacher_id = ${id}`;
        } else if (role === 'admin') {
            await sql.query`DELETE FROM Admins WHERE admin_id = ${id}`;
        } else if (role === 'parent') {
            await sql.query`DELETE FROM Parents WHERE parent_id = ${id}`;
        } else {
            return res.json({ success: false, message: "Invalid role" });
        }
        res.json({ success: true, message: "User deleted successfully" });
    } catch (err) {
        console.error("Error deleting user:", err);
        res.json({ success: false, message: "Failed to delete user" });
    }
});

// ============================================
// ===== PENDING USERS — ADMIN MANAGEMENT =====
// ============================================
// Admins pre-add learners and teachers to PendingUsers.
// Users later "activate" their accounts from PendingUsers.

// ---- Add one pending user ----
app.post("/admin/add-pending-user", requireAuth, requireRole("admin"), async (req, res) => {
    const {
        role,               // 'Learner' or 'teacher'
        full_name,
        email,
        date_of_birth,
        gender,             // 'M' or 'F' (learners only)
        grade_level,        // learners only
        stream              // learners only, Grade 10-12
    } = req.body;

    // ---- Validation ----
    if (!isInArray(role, ['Learner', 'teacher'])) {
        return res.json({ success: false, message: "Invalid role. Must be 'Learner' or 'teacher'." });
    }
    if (!isNonEmptyString(full_name, 2, 100)) {
        return res.json({ success: false, message: "Full name is required (2-100 characters)." });
    }
    if (!isValidEmail(email)) {
        return res.json({ success: false, message: "Please provide a valid email address." });
    }
    if (!date_of_birth || !/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth)) {
        return res.json({ success: false, message: "Date of birth must be in YYYY-MM-DD format." });
    }

    if (role === 'Learner') {
        if (!isInArray(gender, ['M', 'F'])) {
            return res.json({ success: false, message: "Gender must be 'M' or 'F' for learners." });
        }
        if (!isInArray(grade_level, ['Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'])) {
            return res.json({ success: false, message: "Please select a valid grade." });
        }
        if (['Grade 10', 'Grade 11', 'Grade 12'].includes(grade_level)) {
            if (!isInArray(stream, ['Science', 'Commerce', 'Humanities'])) {
                return res.json({ success: false, message: "Please select a valid stream for Grade 10-12." });
            }
        }
    }

    try {
        // Check for duplicates in PendingUsers (email already pending)
        const existingPending = await sql.query`
            SELECT pending_id FROM PendingUsers 
            WHERE email = ${email} AND activated = 0
        `;
        if (existingPending.recordset.length > 0) {
            return res.json({ success: false, message: "This email is already in the pending list." });
        }

        // Check if the email already exists as a real user
        const existingLearner = await sql.query`SELECT learner_id FROM Learners WHERE email = ${email}`;
        const existingTeacher = await sql.query`SELECT teacher_id FROM Teachers WHERE email = ${email}`;
        const existingAdmin = await sql.query`SELECT admin_id FROM Admins WHERE email = ${email}`;

        if (existingLearner.recordset.length > 0 ||
            existingTeacher.recordset.length > 0 ||
            existingAdmin.recordset.length > 0) {
            return res.json({ success: false, message: "This email is already registered in the system." });
        }

        // Insert the pending record
        const result = await sql.query`
            INSERT INTO PendingUsers 
                (role, full_name, email, date_of_birth, gender, grade_level, stream, created_by)
            OUTPUT INSERTED.pending_id
            VALUES 
                (${role}, ${full_name.trim()}, ${email.trim().toLowerCase()}, ${date_of_birth}, 
                 ${gender || null}, ${grade_level || null}, ${stream || null}, ${req.user.email})
        `;

        const pendingId = result.recordset[0].pending_id;
        console.log(`📝 Pending user #${pendingId} added: ${full_name} (${role}) by ${req.user.email}`);

        res.json({
            success: true,
            message: `${full_name} added to the pending list.`,
            pending_id: pendingId
        });
    } catch (err) {
        console.error("Error adding pending user:", err);
        res.json({ success: false, message: "Failed to add pending user: " + err.message });
    }
});

// ---- Upload many pending users from a CSV-ish JSON array ----
// The admin page parses the CSV client-side and sends an array of objects.
app.post("/admin/upload-pending-users", requireAuth, requireRole("admin"), async (req, res) => {
    const { users } = req.body;   // array of objects

    if (!Array.isArray(users) || users.length === 0) {
        return res.json({ success: false, message: "No users provided." });
    }

    if (users.length > 500) {
        return res.json({ success: false, message: "Please upload at most 500 users at a time." });
    }

    const results = {
        added: 0,
        skipped: 0,
        errors: []
    };

    for (let i = 0; i < users.length; i++) {
        const u = users[i];
        const rowLabel = `Row ${i + 1}`;

        try {
            // Validate each row
            if (!isInArray(u.role, ['Learner', 'teacher'])) {
                results.errors.push(`${rowLabel}: invalid role`);
                continue;
            }
            if (!isNonEmptyString(u.full_name, 2, 100)) {
                results.errors.push(`${rowLabel}: invalid name`);
                continue;
            }
            if (!isValidEmail(u.email)) {
                results.errors.push(`${rowLabel}: invalid email`);
                continue;
            }
            if (!u.date_of_birth) {
                results.errors.push(`${rowLabel}: missing date of birth`);
                continue;
            }
            if (u.role === 'Learner') {
                if (!isInArray(u.gender, ['M', 'F'])) {
                    results.errors.push(`${rowLabel}: invalid gender`);
                    continue;
                }
                if (!isInArray(u.grade_level, ['Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'])) {
                    results.errors.push(`${rowLabel}: invalid grade`);
                    continue;
                }
            }

            // Skip duplicates (email already pending or existing)
            const dup = await sql.query`
                SELECT 'pending' AS src FROM PendingUsers WHERE email = ${u.email} AND activated = 0
                UNION
                SELECT 'learner' AS src FROM Learners WHERE email = ${u.email}
                UNION
                SELECT 'teacher' AS src FROM Teachers WHERE email = ${u.email}
                UNION
                SELECT 'admin' AS src FROM Admins WHERE email = ${u.email}
            `;
            if (dup.recordset.length > 0) {
                results.skipped++;
                continue;
            }

            // Insert
            await sql.query`
                INSERT INTO PendingUsers 
                    (role, full_name, email, date_of_birth, gender, grade_level, stream, created_by)
                VALUES 
                    (${u.role}, ${u.full_name.trim()}, ${u.email.trim().toLowerCase()}, ${u.date_of_birth}, 
                     ${u.gender || null}, ${u.grade_level || null}, ${u.stream || null}, ${req.user.email})
            `;
            results.added++;
        } catch (rowErr) {
            results.errors.push(`${rowLabel}: ${rowErr.message}`);
        }
    }

    console.log(`📤 Bulk upload by ${req.user.email}: ${results.added} added, ${results.skipped} skipped, ${results.errors.length} errors`);

    res.json({
        success: true,
        added: results.added,
        skipped: results.skipped,
        errors: results.errors
    });
});

// ---- List pending users ----
app.get("/admin/pending-users", requireAuth, requireRole("admin"), async (req, res) => {
    try {
        const role = req.query.role;               // 'Learner' | 'teacher' | undefined
        const showActivated = req.query.activated === 'true';   // default: only pending

        let query = 'SELECT * FROM PendingUsers WHERE 1=1';
        const request = new sql.Request();

        if (role && role !== 'all') {
            query += ' AND role = @role';
            request.input('role', sql.NVarChar, role);
        }

        if (!showActivated) {
            query += ' AND activated = 0';
        }

        query += ' ORDER BY created_at DESC';

        const result = await request.query(query);
        res.json({ success: true, users: result.recordset });
    } catch (err) {
        console.error("Error listing pending users:", err);
        res.json({ success: false, message: err.message });
    }
});

// ---- Edit a pending user ----
app.put("/admin/pending-user/:id", requireAuth, requireRole("admin"), async (req, res) => {
    const id = req.params.id;
    const { full_name, email, date_of_birth, gender, grade_level, stream } = req.body;

    try {
        // Verify the row exists and is still pending
        const check = await sql.query`
            SELECT pending_id, role, activated FROM PendingUsers WHERE pending_id = ${id}
        `;
        if (check.recordset.length === 0) {
            return res.json({ success: false, message: "Pending user not found." });
        }
        if (check.recordset[0].activated) {
            return res.json({ success: false, message: "This user has already activated. Edit their real account instead." });
        }

        const role = check.recordset[0].role;

        // Build update
        const fields = [];
        const request = new sql.Request();
        request.input('id', sql.Int, id);

        if (isNonEmptyString(full_name, 2, 100)) {
            fields.push('full_name = @full_name');
            request.input('full_name', sql.NVarChar, full_name.trim());
        }
        if (isValidEmail(email)) {
            fields.push('email = @email');
            request.input('email', sql.NVarChar, email.trim().toLowerCase());
        }
        if (date_of_birth && /^\d{4}-\d{2}-\d{2}$/.test(date_of_birth)) {
            fields.push('date_of_birth = @dob');
            request.input('dob', sql.Date, date_of_birth);
        }
        if (role === 'Learner') {
            if (isInArray(gender, ['M', 'F'])) {
                fields.push('gender = @gender');
                request.input('gender', sql.VarChar, gender);
            }
            if (isInArray(grade_level, ['Grade 8', 'Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'])) {
                fields.push('grade_level = @grade');
                request.input('grade', sql.NVarChar, grade_level);
            }
            if (isInArray(stream, ['Science', 'Commerce', 'Humanities'])) {
                fields.push('stream = @stream');
                request.input('stream', sql.VarChar, stream);
            }
        }

        if (fields.length === 0) {
            return res.json({ success: false, message: "Nothing to update." });
        }

        await request.query(`UPDATE PendingUsers SET ${fields.join(', ')} WHERE pending_id = @id`);

        console.log(`✏️ Pending user #${id} updated by ${req.user.email}`);
        res.json({ success: true, message: "Pending user updated." });
    } catch (err) {
        console.error("Error updating pending user:", err);
        res.json({ success: false, message: err.message });
    }
});

// ---- Delete a pending user ----
app.delete("/admin/pending-user/:id", requireAuth, requireRole("admin"), async (req, res) => {
    const id = req.params.id;

    try {
        const result = await sql.query`
            DELETE FROM PendingUsers WHERE pending_id = ${id} AND activated = 0
        `;

        if (result.rowsAffected[0] === 0) {
            return res.json({ success: false, message: "Not found, or already activated (cannot delete)." });
        }

        console.log(`🗑️ Pending user #${id} deleted by ${req.user.email}`);
        res.json({ success: true, message: "Pending user deleted." });
    } catch (err) {
        console.error("Error deleting pending user:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== PENDING USERS — PUBLIC ACTIVATION =====
// ============================================
// These routes are used by the registration flow.
// A learner or teacher activates their pre-approved account.

// ---- Step 1: Verify full name + email ----
app.post("/check-pending", async (req, res) => {
    const { full_name, email } = req.body;

    if (!isNonEmptyString(full_name, 2, 100)) {
        return res.json({ success: false, message: "Please enter your full name." });
    }
    if (!isValidEmail(email)) {
        return res.json({ success: false, message: "Please enter a valid email address." });
    }

    try {
        const cleanName = full_name.trim().toLowerCase();
        const cleanEmail = email.trim().toLowerCase();

        const result = await sql.query`
            SELECT pending_id, role, full_name, email
            FROM PendingUsers
            WHERE LOWER(LTRIM(RTRIM(full_name))) = ${cleanName}
              AND LOWER(LTRIM(RTRIM(email))) = ${cleanEmail}
              AND activated = 0
        `;

        if (result.recordset.length === 0) {
            // Check if this person already has an account
            const existing = await sql.query`
                SELECT 'Learner' AS src FROM Learners WHERE email = ${cleanEmail}
                UNION
                SELECT 'teacher' AS src FROM Teachers WHERE email = ${cleanEmail}
                UNION
                SELECT 'admin' AS src FROM Admins WHERE email = ${cleanEmail}
            `;

            if (existing.recordset.length > 0) {
                return res.json({
                    success: false,
                    message: "You already have an account. Please log in instead."
                });
            }

            return res.json({
                success: false,
                message: "We couldn't find a matching record. Please check your details or contact your admin."
            });
        }

        res.json({
            success: true,
            step: 2,
            message: "We found your record. Please confirm your date of birth."
        });
    } catch (err) {
        console.error("Error in /check-pending:", err);
        res.json({ success: false, message: "Server error. Please try again." });
    }
});

// ---- Step 2: Verify date of birth ----
app.post("/verify-dob", async (req, res) => {
    const { full_name, email, date_of_birth } = req.body;

    if (!date_of_birth || !/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth)) {
        return res.json({ success: false, message: "Please enter your date of birth (YYYY-MM-DD)." });
    }

    try {
        const cleanName = (full_name || '').trim().toLowerCase();
        const cleanEmail = (email || '').trim().toLowerCase();

        const result = await sql.query`
            SELECT pending_id, role, full_name, email, date_of_birth, 
                   gender, grade_level, stream
            FROM PendingUsers
            WHERE LOWER(LTRIM(RTRIM(full_name))) = ${cleanName}
              AND LOWER(LTRIM(RTRIM(email))) = ${cleanEmail}
              AND activated = 0
        `;

        if (result.recordset.length === 0) {
            return res.json({ success: false, message: "Record not found. Please start again." });
        }

        const pending = result.recordset[0];

        // Compare DOBs — the DB returns a Date object, we sent a string
        const dbDob = new Date(pending.date_of_birth).toISOString().slice(0, 10);
        if (dbDob !== date_of_birth) {
            return res.json({
                success: false,
                message: "Date of birth doesn't match our records. Contact the admin if this is wrong."
            });
        }

        res.json({
            success: true,
            step: 3,
            prefilled: {
                full_name: pending.full_name,
                email: pending.email,
                role: pending.role,
                grade_level: pending.grade_level,
                stream: pending.stream,
                gender: pending.gender
            }
        });
    } catch (err) {
        console.error("Error in /verify-dob:", err);
        res.json({ success: false, message: "Server error. Please try again." });
    }
});


// ---- Step 2.5: Send verification code to the email on file ----
app.post("/send-code", async (req, res) => {
    const { full_name, email, date_of_birth } = req.body;

    if (!full_name || !email) {
        return res.json({ success: false, message: "Name and email are required." });
    }

    try {
        const cleanName = full_name.trim().toLowerCase();
        const cleanEmail = email.trim().toLowerCase();

        const result = await sql.query`
            SELECT pending_id, role, full_name, email, date_of_birth,
                   verification_code, code_expires_at, code_attempts
            FROM PendingUsers
            WHERE LOWER(LTRIM(RTRIM(full_name))) = ${cleanName}
              AND LOWER(LTRIM(RTRIM(email)))     = ${cleanEmail}
              AND activated = 0
        `;

        if (result.recordset.length === 0) {
            return res.json({ success: false, message: "Record not found. Please start again." });
        }

        const pending = result.recordset[0];

        // Rate limit — one code per 60 seconds
        if (pending.code_expires_at) {
            const lastSent = new Date(pending.code_expires_at).getTime() - (10 * 60 * 1000);
            const secondsSince = (Date.now() - lastSent) / 1000;
            if (secondsSince < 60) {
                return res.json({
                    success: false,
                    message: `Please wait ${Math.ceil(60 - secondsSince)} seconds before requesting another code.`
                });
            }
        }

        // Generate 6-digit code
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);   // 10 minutes

        await sql.query`
            UPDATE PendingUsers
            SET verification_code = ${code},
                code_expires_at   = ${expiresAt},
                code_attempts     = 0
            WHERE pending_id = ${pending.pending_id}
        `;

        // Email the code
        await transporter.sendMail({
            from: "Taxila Learning Hub <lusunzirinae21@gmail.com>",
            to: pending.email,
            subject: "Your Taxila Learning Hub verification code",
            text: `Your verification code is ${code}. It expires in 10 minutes.`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: white; border-radius: 10px;">
                    <div style="text-align: center; padding-bottom: 20px; border-bottom: 2px solid #06d3f7;">
                        <h1 style="color: #06d3f7;">🎓 Taxila Learning Hub</h1>
                    </div>
                    <div style="padding: 20px 0;">
                        <p style="font-size: 16px;">Hi <strong>${pending.full_name}</strong>,</p>
                        <p style="color: #ccc;">Your verification code is:</p>
                        <div style="text-align:center; margin: 24px 0;">
                            <span style="font-size:32px; letter-spacing:6px; font-weight:bold; color:#06d3f7; background:rgba(6,211,247,0.1); padding: 14px 28px; border-radius: 10px; display:inline-block;">${code}</span>
                        </div>
                        <p style="color:#ccc; font-size:14px;">This code expires in 10 minutes.</p>
                        <p style="color:#888; font-size:13px;">If you didn't request this, you can ignore this email.</p>
                    </div>
                </div>
            `
        });

        // Testing convenience — remove this line before production delivery
        console.log(`🔐 Code for ${pending.email}: ${code}`);

        res.json({
            success: true,
            step: 3,
            message: "Verification code sent to your email."
        });

    } catch (err) {
        console.error("Error in /send-code:", err);
        res.json({ success: false, message: "Could not send verification code. Try again." });
    }
});

// ---- Step 3: Verify the code ----
app.post("/verify-code", async (req, res) => {
    const { full_name, email, code } = req.body;

    if (!full_name || !email || !code) {
        return res.json({ success: false, message: "Missing information." });
    }

    try {
        const cleanName = full_name.trim().toLowerCase();
        const cleanEmail = email.trim().toLowerCase();

        const result = await sql.query`
            SELECT pending_id, role, full_name, email, date_of_birth,
                   gender, grade_level, stream,
                   verification_code, code_expires_at, code_attempts
            FROM PendingUsers
            WHERE LOWER(LTRIM(RTRIM(full_name))) = ${cleanName}
              AND LOWER(LTRIM(RTRIM(email)))     = ${cleanEmail}
              AND activated = 0
        `;

        if (result.recordset.length === 0) {
            return res.json({ success: false, message: "Record not found. Please start again." });
        }

        const pending = result.recordset[0];

        // Too many wrong attempts?
        if (pending.code_attempts >= 5) {
            return res.json({
                success: false,
                message: "Too many incorrect attempts. Please request a new code."
            });
        }

        // Expired?
        if (!pending.code_expires_at || new Date(pending.code_expires_at) < new Date()) {
            return res.json({
                success: false,
                message: "Code has expired. Please request a new one."
            });
        }

        // Wrong code?
        if (pending.verification_code !== code.trim()) {
            await sql.query`
                UPDATE PendingUsers
                SET code_attempts = code_attempts + 1
                WHERE pending_id = ${pending.pending_id}
            `;
            const remaining = 4 - pending.code_attempts;
            return res.json({
                success: false,
                message: `Incorrect code. ${remaining > 0 ? remaining + ' attempts remaining.' : 'Please request a new code.'}`
            });
        }

        // Success — clear the code so it can't be reused, and reveal prefilled data
        await sql.query`
            UPDATE PendingUsers
            SET code_attempts = 0
            WHERE pending_id = ${pending.pending_id}
        `;

        res.json({
            success: true,
            step: 4,
            prefilled: {
                full_name: pending.full_name,
                email: pending.email,
                role: pending.role,
                grade_level: pending.grade_level,
                stream: pending.stream,
                gender: pending.gender
            }
        });

    } catch (err) {
        console.error("Error in /verify-code:", err);
        res.json({ success: false, message: "Server error. Please try again." });
    }
});

// ---- Step 3: Activate the account ----
app.post("/activate-account", async (req, res) => {
    const { full_name, email, date_of_birth, password, code } = req.body;

    // Validate password
    if (!isValidPassword(password)) {
        return res.json({
            success: false,
            message: "Password must be at least 8 characters and contain letters and numbers."
        });
    }

    try {
        const cleanName = (full_name || '').trim().toLowerCase();
        const cleanEmail = (email || '').trim().toLowerCase();

        // Re-verify the pending record
        const result = await sql.query`
            SELECT * FROM PendingUsers
            WHERE LOWER(LTRIM(RTRIM(full_name))) = ${cleanName}
              AND LOWER(LTRIM(RTRIM(email))) = ${cleanEmail}
              AND activated = 0
        `;

        if (result.recordset.length === 0) {
            return res.json({ success: false, message: "Record not found. Please start again." });
        }

        const pending = result.recordset[0];
        // ---- Require a valid verification code ----
        if (!code) {
            return res.json({ success: false, message: "Verification code is required." });
        }
        if (pending.verification_code !== code.trim()) {
            return res.json({ success: false, message: "Invalid verification code." });
        }
        if (!pending.code_expires_at || new Date(pending.code_expires_at) < new Date()) {
            return res.json({ success: false, message: "Verification code has expired." });
        }

        // Verify DOB
        const dbDob = new Date(pending.date_of_birth).toISOString().slice(0, 10);
        if (dbDob !== date_of_birth) {
            return res.json({ success: false, message: "Date of birth mismatch." });
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create the account based on role
        if (pending.role === 'Learner') {
            // Double-check the email isn't already a learner
            const dup = await sql.query`SELECT learner_id FROM Learners WHERE email = ${pending.email}`;
            if (dup.recordset.length > 0) {
                return res.json({ success: false, message: "An account with this email already exists." });
            }

            await sql.query`
                INSERT INTO Learners (full_name, email, password, grade_level, stream, gender)
                VALUES (
                    ${pending.full_name}, 
                    ${pending.email}, 
                    ${hashedPassword}, 
                    ${pending.grade_level}, 
                    ${pending.stream}, 
                    ${pending.gender}
                )
            `;
        } else if (pending.role === 'teacher') {
            const dup = await sql.query`SELECT teacher_id FROM Teachers WHERE email = ${pending.email}`;
            if (dup.recordset.length > 0) {
                return res.json({ success: false, message: "An account with this email already exists." });
            }

            await sql.query`
                INSERT INTO Teachers (full_name, email, password)
                VALUES (${pending.full_name}, ${pending.email}, ${hashedPassword})
            `;
        } else {
            return res.json({ success: false, message: "Invalid role in pending record." });
        }

        // Mark the pending row as activated
        await sql.query`
    UPDATE PendingUsers 
    SET activated = 1, 
        activated_at = GETDATE(),
        verification_code = NULL,
        code_expires_at   = NULL
    WHERE pending_id = ${pending.pending_id}
`;

        // Log the activity
        try {
            await logActivity(
                pending.email, pending.full_name, pending.role,
                'Activated account',
                `Via pre-approved activation`
            );
        } catch (_) { /* silent */ }

        console.log(`✅ Account activated: ${pending.full_name} (${pending.role})`);

        res.json({
            success: true,
            message: "Account activated successfully. You can now log in."
        });
    } catch (err) {
        console.error("Error in /activate-account:", err);
        res.json({ success: false, message: "Server error. Please try again." });
    }
});

// ============================================
// ===== UPDATE STREAM ROUTE =====
// ============================================

app.post("/update-stream", requireAuth, async (req, res) => {
    const { email, stream } = req.body;

    if (!email) {
        return res.json({ success: false, message: "Email is required" });
    }

    try {
        await sql.query`
            UPDATE Learners 
            SET stream = ${stream || null}
            WHERE email = ${email}
        `;

        res.json({ success: true, message: `Stream updated successfully for ${email}` });
    } catch (err) {
        console.error("Error updating stream:", err);
        res.json({ success: false, message: "Failed to update stream" });
    }
});

// ============================================
// ===== MARKS ROUTES =====
// ============================================
app.post("/add-mark", requireAuth, async (req, res) => {
    const { student_email, subject, score, term, assessment_type, assessment_title, grade_level, stream, uploaded_by } = req.body;

    if (!assessment_type) {
        return res.json({ success: false, message: "Assessment type is required." });
    }

    const allowed = ['class_test', 'assignment', 'practical', 'term_exam', 'final_exam'];
    if (!allowed.includes(assessment_type)) {
        return res.json({ success: false, message: "Invalid assessment type." });
    }

    if (!assessment_title || !assessment_title.trim()) {
        return res.json({ success: false, message: "Assessment title is required." });
    }

    try {
        // Look up learner_name / stream if missing
        let finalName = req.body.learner_name;
        let finalStream = stream;

        if (!finalName || !finalStream) {
            const lookup = await sql.query`
                SELECT full_name, stream FROM Learners WHERE email = ${student_email}
            `;
            if (lookup.recordset.length > 0) {
                if (!finalName) finalName = lookup.recordset[0].full_name;
                if (!finalStream) finalStream = lookup.recordset[0].stream;
            }
        }

        // ← NEW: include academic_year in the insert
        await sql.query`
            INSERT INTO Marks 
                (student_email, learner_name, subject, score, term, assessment_type, assessment_title, grade_level, stream, uploaded_by, academic_year)
            VALUES 
                (${student_email}, ${finalName}, ${subject}, ${score}, ${term}, ${assessment_type}, ${assessment_title.trim()}, ${grade_level}, ${finalStream}, ${uploaded_by}, ${CURRENT_YEAR})
        `;

        const teacherName = uploaded_by || 'Unknown';
        await logActivity(teacherName, teacherName, 'teacher', 'Added marks',
            `Student: ${student_email}, Subject: ${subject}, Score: ${score}, Type: ${assessment_type}, Year: ${CURRENT_YEAR}`);

        res.json({ success: true, message: "Mark added" });
    } catch (err) {
        console.error("❌ Error adding mark:", err);
        res.json({ success: false, message: "Failed to add mark" });
    }
});
app.get("/marks/:email", requireAuth, async (req, res) => {
    try {
        const email = req.params.email;
        console.log("🔍 Searching marks for email:", email);

        const result = await sql.query`
            SELECT 
                mark_id,
                student_email,
                learner_name,
                subject,
                score,
                term,
                assessment_type,
                assessment_title,
                grade_level,
                stream,
                academic_year
            FROM Marks 
            WHERE student_email = ${email}
              AND academic_year = ${CURRENT_YEAR}
            ORDER BY term, mark_id
        `;

        console.log(`📊 Marks found: ${result.recordset.length} (year ${CURRENT_YEAR})`);
        res.json(result.recordset);
    } catch (err) {
        console.error("Error fetching marks:", err);
        res.json([]);
    }
});

app.get("/all-marks", async (req, res) => {
    try {
        const result = await sql.query`
            SELECT 
                m.mark_id,
                m.student_email,
                m.learner_name,
                m.subject,
                m.score,
                m.term,
                m.assessment_type,
                m.assessment_title,
                m.grade_level,
                m.stream,
                m.uploaded_by,
                m.academic_year
            FROM Marks m
            WHERE m.academic_year = ${CURRENT_YEAR}
            ORDER BY m.mark_id DESC
        `;

        res.json(result.recordset);
    } catch (err) {
        console.error("❌ Error fetching marks:", err);
        res.json([]);
    }
});

app.put("/update-mark/:id", async (req, res) => {
    const markId = req.params.id;
    const { subject, score, term } = req.body;

    if (!subject || !score || !term) {
        return res.json({ success: false, message: "Please fill all fields" });
    }

    try {
        const result = await sql.query`
            UPDATE Marks 
            SET subject = ${subject}, 
                score = ${score}, 
                term = ${term}
            WHERE mark_id = ${markId}
        `;

        if (result.rowsAffected[0] === 0) {
            return res.json({ success: false, message: "Mark not found" });
        }

        res.json({ success: true, message: "Mark updated successfully" });
    } catch (err) {
        console.error("❌ Error updating mark:", err);
        res.json({ success: false, message: "Failed to update mark" });
    }
});

// ============================================
// ===== ATTENDANCE ROUTES =====
// ============================================

app.get("/attendance/:email", requireAuth, async (req, res) => {
    try {
        const email = req.params.email;
        console.log("🔍 Fetching attendance for:", email, "(year", CURRENT_YEAR + ")");

        const result = await sql.query`
            SELECT 
                attendance_id,
                date_recorded,
                status,
                grade_level,
                recorded_by,
                academic_year
            FROM Attendance 
            WHERE student_email = ${email}
              AND academic_year = ${CURRENT_YEAR}
            ORDER BY date_recorded DESC
        `;

        console.log(`📊 Attendance records found: ${result.recordset.length} (year ${CURRENT_YEAR})`);
        res.json(result.recordset);
    } catch (err) {
        console.error("Error fetching attendance:", err);
        res.json([]);
    }
});

// ============================================
// ===== STUDENT PERFORMANCE ROUTES =====
// ============================================

app.get("/student-performance/:email", requireAuth, async (req, res) => {
    try {
        const email = req.params.email;
        console.log("🔍 Getting performance for:", email, "(year", CURRENT_YEAR + ")");

        const result = await sql.query`
            SELECT 
                subject,
                AVG(CAST(score AS FLOAT)) as average,
                MAX(CAST(score AS FLOAT)) as highest,
                MIN(CAST(score AS FLOAT)) as lowest,
                COUNT(*) as total_marks
            FROM Marks 
            WHERE student_email = ${email}
              AND academic_year = ${CURRENT_YEAR}
            GROUP BY subject
            ORDER BY subject
        `;

        console.log(`📊 Performance data: ${result.recordset.length} subjects`);
        res.json(result.recordset);
    } catch (err) {
        console.error("❌ Performance error:", err);
        res.json([]);
    }
});

// ============================================
// ===== AI CONTEXT BUNDLE (for grounding) =====
// ============================================
app.get("/api/ai-context", requireAuth, async (req, res) => {
    const { email, subject } = req.query;

    console.log("📚 /api/ai-context called with:", { email, subject, year: CURRENT_YEAR });

    if (!email || !subject) {
        return res.json({ success: false, message: "email and subject are required" });
    }

    try {
        const studentResult = await sql.query`
            SELECT full_name, grade_level, stream 
            FROM Learners WHERE email = ${email}
        `;

        if (studentResult.recordset.length === 0) {
            return res.json({ success: false, message: "Student not found" });
        }

        const { full_name, grade_level, stream } = studentResult.recordset[0];
        const streamValue = stream || '';

        const homeworkResult = await sql.query`
            SELECT title, description, file_path
            FROM Homework
            WHERE subject = ${subject}
              AND (grade_level = ${grade_level} OR grade_level = 'All Grades')
              AND (stream = ${streamValue} OR stream IS NULL OR stream = '' OR stream = 'All Streams')
            ORDER BY homework_id DESC
        `;

        const studyResult = await sql.query`
            SELECT title, description, file_path, material_type
            FROM StudyMaterials
            WHERE subject = ${subject}
              AND (grade_level = ${grade_level} OR grade_level = 'All Grades')
              AND (stream = ${streamValue} OR stream IS NULL OR stream = '' OR stream = 'All Streams')
            ORDER BY created_at DESC
        `;

        const annResult = await sql.query`
            SELECT title, message, posted_by
            FROM Announcements
            WHERE (subject = ${subject} OR subject = 'All Subjects' OR subject IS NULL)
              AND (grade_level = ${grade_level} OR grade_level = 'All Grades')
              AND (stream = ${streamValue} OR stream IS NULL OR stream = '' OR stream = 'All Streams')
            ORDER BY created_at DESC
        `;

        // ← Year filter added here
        const marksResult = await sql.query`
            SELECT subject, score, term, assessment_type, assessment_title
            FROM Marks
            WHERE student_email = ${email} 
              AND subject = ${subject}
              AND academic_year = ${CURRENT_YEAR}
            ORDER BY mark_id DESC
        `;

        let fileText = "";
        const EXTRACTABLE = [".txt", ".md", ".csv"];
        const MAX_TOTAL_CHARS = 20000;

        for (const m of studyResult.recordset) {
            if (fileText.length > MAX_TOTAL_CHARS) break;
            if (!m.file_path) continue;

            const lower = m.file_path.toLowerCase();
            if (!EXTRACTABLE.some(ext => lower.endsWith(ext))) continue;

            try {
                const abs = path.join(__dirname, "public", m.file_path);
                const raw = fs.readFileSync(abs, "utf8");
                const trimmed = raw.slice(0, 5000);
                fileText += `\n\n--- FILE: ${m.title} (${m.file_path}) ---\n${trimmed}`;
            } catch (readErr) {
                console.warn(`Could not read ${m.file_path}:`, readErr.message);
            }
        }

        console.log("✅ /api/ai-context returning:",
            homeworkResult.recordset.length, "homework,",
            studyResult.recordset.length, "materials,",
            annResult.recordset.length, "announcements,",
            marksResult.recordset.length, "marks,",
            fileText.length, "file chars");

        res.json({
            success: true,
            student: { full_name, grade_level, stream },
            subject,
            homework: homeworkResult.recordset,
            study_materials: studyResult.recordset,
            announcements: annResult.recordset,
            marks: marksResult.recordset,
            file_text: fileText.trim()
        });

    } catch (err) {
        console.error("❌ /api/ai-context error:", err);
        res.json({ success: false, message: err.message });
    }
});


// ============================================
// ===== AI CHATBOT/TUTOR ROUTES =====
// ============================================

app.post("/api/chat", requireAuth, async (req, res) => {
    const { message, studentEmail, mode, subject, context, threadId } = req.body;

    if (!message) {
        return res.json({ error: "Please enter a message" });
    }

    const chatMode = mode === 'basic' ? 'basic' : 'advanced';

    console.log(`💬 Gemini Chat (${chatMode}) from ${studentEmail || 'Guest'}: ${message}`);

    try {
        let studentName = "Student";
        let studentContext = "";

        if (studentEmail) {
            const userResult = await sql.query`
                SELECT full_name, grade_level, stream FROM Learners WHERE email = ${studentEmail}
            `;
            if (userResult.recordset.length > 0) {
                studentName = userResult.recordset[0].full_name;
                const grade = userResult.recordset[0].grade_level;
                const stream = userResult.recordset[0].stream;
                if (grade) studentContext += `This student is in ${grade}. `;
                if (stream) studentContext += `They are in the ${stream} stream. `;
            }

            const marksResult = await sql.query`
                SELECT DISTINCT subject FROM Marks WHERE student_email = ${studentEmail}
            `;
            const subjects = marksResult.recordset.map(m => m.subject);
            if (subjects.length > 0) {
                studentContext += `This student is studying: ${subjects.join(', ')}. `;
            }
        }

        let groundingBlock = "";
        if (context && context.success) {
            const parts = [];

            parts.push(`The learner is currently studying: ${subject || context.subject || 'unknown subject'}.`);
            parts.push(`Name: ${context.student?.full_name || studentName}. Grade: ${context.student?.grade_level || 'unknown'}.`);

            if (context.homework?.length) {
                parts.push(
                    "\n=== HOMEWORK THE LEARNER CAN SEE ===\n" +
                    context.homework.map(h =>
                        `• ${h.title} — ${h.description || '(no description)'}${h.file_path ? ` [file: ${h.file_path}]` : ''}`
                    ).join("\n")
                );
            }

            if (context.study_materials?.length) {
                parts.push(
                    "\n=== STUDY MATERIALS AVAILABLE ===\n" +
                    context.study_materials.map(m =>
                        `• ${m.title} — ${m.description || '(no description)'}${m.file_path ? ` [file: ${m.file_path}]` : ''}`
                    ).join("\n")
                );
            }

            if (context.announcements?.length) {
                parts.push(
                    "\n=== RECENT ANNOUNCEMENTS ===\n" +
                    context.announcements.map(a =>
                        `• "${a.title}" by ${a.posted_by || 'staff'}: ${a.message}`
                    ).join("\n")
                );
            }

            if (context.marks?.length) {
                parts.push(
                    "\n=== THIS LEARNER'S MARKS IN THIS SUBJECT ===\n" +
                    context.marks.map(m => `• ${m.term}: ${m.score}%`).join("\n")
                );
            }

            if (context.file_text) {
                parts.push(
                    "\n=== RAW TEXT FROM UPLOADED TEXT FILES ===\n" +
                    context.file_text
                );
            }

            groundingBlock = `
IMPORTANT — COURSE MATERIAL CONTEXT
The following is the ACTUAL material this learner has been given. Use it as your primary source of truth.
If the learner asks about a specific worksheet, homework, or study guide, refer to the titles and content below.
If the answer is not present in this material, say: "That specific item isn't in your uploaded material, but..." and then answer generally.

${parts.join("\n")}

=== END OF COURSE MATERIAL CONTEXT ===
`;
        } else {
            console.log("⚠️ /api/chat received NO context — answering ungrounded.");
        }

        // ============================================
        // ===== RAG RETRIEVAL (top 5 relevant chunks) =====
        // ============================================
        let ragBlock = "";
        try {
            if (studentEmail && subject) {
                const studentRow = await sql.query`
                    SELECT grade_level, stream FROM Learners WHERE email = ${studentEmail}
                `;
                if (studentRow.recordset.length > 0) {
                    const { grade_level, stream } = studentRow.recordset[0];
                    const chunks = await retrieveRelevantChunks(message, {
                        subject,
                        gradeLevel: grade_level,
                        topK: 5
                    });

                    if (chunks.length > 0) {
                        ragBlock = `
=== RELEVANT EXCERPTS FROM THE LEARNER'S TEXTBOOK / STUDY GUIDES ===
Use these as your PRIMARY source of truth when answering. If the learner's question
is answered in these excerpts, base your answer on them.
If the excerpts don't contain the answer, say: "That specific detail isn't in your
uploaded study material, but..." and then answer generally.

${chunks.map((c, i) =>
                            `[Excerpt ${i + 1} — from "${c.material_title}"]\n${c.chunk_text}`
                        ).join("\n\n")}
=== END OF EXCERPTS ===
`;
                        console.log(`📚 RAG: retrieved ${chunks.length} chunks (top score: ${chunks[0].score.toFixed(3)})`);
                    } else {
                        console.log("📭 RAG: no chunks found for this query.");
                    }
                }
            }
        } catch (ragErr) {
            console.warn("⚠️ RAG retrieval failed:", ragErr.message);
        }

        const basePrompt = `You are a friendly AI Tutor for Taxila Learning Hub.
Your name is Gemini. You teach high school learners in South Africa.

You are a mathematics and science homework assistant.

ALWAYS format mathematical expressions using LaTeX.

Use proper mathematical symbols and notation, including:
- Fractions: \\frac{a}{b}
- Square roots: \\sqrt{x}
- Powers: x^2
- Subscripts: x_1
- Multiplication: \\times or implicit multiplication
- Plus/minus: \\pm
- Greater/less than: \\geq, \\leq
- Greek letters: \\alpha, \\beta, \\theta
- Integrals: \\int
- Summation: \\sum
- Matrices using LaTeX matrix notation.

Put inline mathematics between \\( and \\).

Put equations that should appear on their own line between \\[ and \\].

Show calculations step-by-step and explain what each step means.

Do not replace mathematical symbols with words when a standard mathematical symbol exists.

Example:

Instead of:
"The quadratic formula is x equals negative b plus or minus..."

Write:

\\[
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
\\]

When solving a problem, clearly show:
1. Given information
2. Formula
3. Substitution
4. Calculation
5. Final answer

GENERAL TUTORING STYLE:
- Explain like the learner is seeing this for the FIRST time.
- Use simple everyday words. Avoid textbook jargon.
- After each step, ask: "Does that make sense so far?"
- Use small steps, not big paragraphs.
- Give a real-life example when possible.
- Keep sentences short. One idea per sentence.
- Use emojis to make it friendly. 😊

When course material is provided above, ALWAYS prefer it over general knowledge.
If the learner asks "what homework do I have?" or "what study materials do I have?", list the real titles from the context block.`;

        const systemPrompt = chatMode === 'basic'
            ? `${groundingBlock}${ragBlock}${basePrompt}
Keep answers SHORT and SIMPLE — 1-2 short paragraphs max, plain language, minimal jargon.`
            : `${groundingBlock}${ragBlock}${basePrompt}
Give clear, detailed, well-structured explanations with examples where useful.
Keep responses educational and thorough — 2-4 paragraphs with examples.
Include formulas, definitions, and step-by-step explanations when relevant.
Make it engaging but comprehensive.`;

        const sessionKey = `${studentEmail || 'guest'}:${chatMode}:${subject || 'general'}`;
        let chat = chatSessions.get(sessionKey);

        if (!chat) {
            chat = ai.chats.create({
                model: GEMINI_MODEL,
                config: {
                    systemInstruction: systemPrompt,
                    temperature: chatMode === 'basic' ? 0.6 : 0.8,
                }
            });
            chatSessions.set(sessionKey, chat);
            console.log(`🆕 New chat session created: ${sessionKey} (grounded: ${!!groundingBlock})`);
        }

        await saveChatMessage(studentEmail, subject, 'user', message, threadId);
        // ---- Auto-title the thread from the first user message ----
        if (threadId) {
            try {
                const threadCheck = await sql.query`
            SELECT title FROM ChatThreads WHERE thread_id = ${threadId}
        `;
                if (threadCheck.recordset.length > 0 &&
                    threadCheck.recordset[0].title === 'New chat') {
                    // Truncate to 60 chars for a tidy sidebar
                    const newTitle = message.length > 60
                        ? message.substring(0, 57).trim() + '...'
                        : message;
                    await sql.query`
                UPDATE ChatThreads SET title = ${newTitle}
                WHERE thread_id = ${threadId}
            `;
                    console.log(`📝 Thread #${threadId} titled: "${newTitle}"`);
                }
            } catch (titleErr) {
                console.warn("Could not auto-title thread:", titleErr.message);
            }
        }
        const completion = await chat.sendMessage({ message: message });

        await saveChatMessage(studentEmail, subject, 'bot', completion.text, threadId);

        res.json({
            success: true,
            response: completion.text,
            mode: chatMode,
            model: GEMINI_MODEL,
            grounded: !!groundingBlock,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error("❌ Gemini API Error:", err);
        res.json({
            success: false,
            error: "AI service unavailable",
            response: "I'm having a little trouble connecting right now. Please try asking again! 🙏"
        });
    }
});

app.get("/api/chat/status", async (req, res) => {
    try {
        const hasKey = !!process.env.GEMINI_API_KEY;
        res.json({
            success: true,
            hasKey: hasKey,
            gemini: {
                status: hasKey ? "available" : "unavailable",
                model: GEMINI_MODEL
            }
        });
    } catch (err) {
        res.json({ success: false, hasKey: false, error: err.message });
    }
});

app.post("/api/chat/reset", requireAuth, async (req, res) => {
    const { studentEmail, subject } = req.body;
    let cleared = 0;
    for (const key of [...chatSessions.keys()]) {
        if (key.startsWith(`${studentEmail}:`) && key.endsWith(`:${subject}`)) {
            chatSessions.delete(key);
            cleared++;
        }
    }
    console.log(`🔄 /api/chat/reset cleared ${cleared} session(s) for ${studentEmail} / ${subject}`);
    res.json({ success: true, cleared });
});

// ============================================
// ===== GET CHAT HISTORY =====
// ============================================
app.get("/api/chat-history", requireAuth, async (req, res) => {
    const { email, subject, limit } = req.query;

    if (!email) {
        return res.json({ success: false, message: "email is required" });
    }

    const max = Math.min(Math.max(parseInt(limit) || 50, 5), 200);

    try {
        const result = await sql.query`
            SELECT TOP (${max}) chat_id, role, message, created_at
            FROM ChatHistory
            WHERE student_email = ${email}
              AND (subject = ${subject || 'general'} OR (subject IS NULL AND ${subject || 'general'} = 'general'))
            ORDER BY chat_id DESC
        `;

        const messages = result.recordset.reverse();

        res.json({ success: true, messages });
    } catch (err) {
        console.error("❌ /api/chat-history error:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== CHAT: CREATE NEW THREAD =====
// ============================================
app.post("/api/chat/new-thread", requireAuth, async (req, res) => {
    const { email, subject } = req.body;

    if (!email || !subject) {
        return res.json({ success: false, message: "email and subject are required" });
    }

    try {
        const result = await sql.query`
            INSERT INTO ChatThreads (student_email, subject, title)
            OUTPUT INSERTED.thread_id, INSERTED.created_at
            VALUES (${email}, ${subject}, 'New chat')
        `;

        const thread = result.recordset[0];
        console.log(`🆕 New chat thread #${thread.thread_id} for ${email} / ${subject}`);

        res.json({
            success: true,
            thread_id: thread.thread_id,
            created_at: thread.created_at
        });
    } catch (err) {
        console.error("❌ /api/chat/new-thread error:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== CHAT: LIST THREADS =====
// ============================================
// Returns all threads for a learner + subject, sorted by most recent activity.
// The sidebar uses this to render the conversation list.

app.get("/api/chat/threads", requireAuth, async (req, res) => {
    const { email, subject } = req.query;

    if (!email || !subject) {
        return res.json({ success: false, message: "email and subject are required" });
    }

    try {
        const result = await sql.query`
            SELECT 
                thread_id,
                title,
                created_at,
                last_message_at,
                (
                    SELECT COUNT(*) 
                    FROM ChatHistory 
                    WHERE thread_id = t.thread_id
                ) AS message_count
            FROM ChatThreads t
            WHERE student_email = ${email} 
              AND subject = ${subject}
            ORDER BY last_message_at DESC
        `;

        res.json({ success: true, threads: result.recordset });
    } catch (err) {
        console.error("❌ /api/chat/threads error:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== CHAT: LOAD ONE THREAD =====
// ============================================
// Returns the thread's metadata plus all its messages, in order.

app.get("/api/chat/thread/:threadId", requireAuth, async (req, res) => {
    const threadId = req.params.threadId;
    const { email } = req.query;

    if (!threadId || !email) {
        return res.json({ success: false, message: "threadId and email are required" });
    }

    try {
        // Verify thread ownership
        const threadResult = await sql.query`
            SELECT thread_id, student_email, subject, title, created_at, last_message_at
            FROM ChatThreads
            WHERE thread_id = ${threadId} AND student_email = ${email}
        `;

        if (threadResult.recordset.length === 0) {
            return res.json({ success: false, message: "Thread not found" });
        }

        const thread = threadResult.recordset[0];

        // Load all messages in this thread, oldest first
        const messagesResult = await sql.query`
            SELECT chat_id, role, message, created_at
            FROM ChatHistory
            WHERE thread_id = ${threadId}
            ORDER BY chat_id ASC
        `;

        res.json({
            success: true,
            thread: thread,
            messages: messagesResult.recordset
        });

    } catch (err) {
        console.error("❌ /api/chat/thread/:id error:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== CLEAR CHAT HISTORY =====
// ============================================
app.delete("/api/chat-history", requireAuth, async (req, res) => {
    const { email, subject } = req.query;

    if (!email) {
        return res.json({ success: false, message: "email is required" });
    }

    try {
        const sessionKeyLike = `${email}:advanced:${subject || 'general'}`;
        const sessionKeyBasic = `${email}:basic:${subject || 'general'}`;
        chatSessions.delete(sessionKeyLike);
        chatSessions.delete(sessionKeyBasic);

        await sql.query`
            DELETE FROM ChatHistory
            WHERE student_email = ${email}
              AND (subject = ${subject || 'general'} OR (subject IS NULL AND ${subject || 'general'} = 'general'))
        `;

        console.log(`🗑️ Chat history cleared for ${email} / ${subject || 'general'}`);
        res.json({ success: true, message: "Chat history cleared" });
    } catch (err) {
        console.error("❌ DELETE /api/chat-history error:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== CHAT UPLOAD (image / pdf / docx / pptx) =====
// ============================================
const chatStorage = multer.diskStorage({
    destination: "public/uploads/chat/",
    filename: function (req, file, cb) {
        cb(null, Date.now() + "-" + file.originalname);
    }
});

const uploadChat = multer({
    storage: chatStorage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        const ok = [
            "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/plain", "text/csv", "text/markdown"
        ];
        if (ok.includes(file.mimetype)) return cb(null, true);
        cb(new Error("Unsupported file type: " + file.mimetype));
    }
});

app.post("/api/chat-with-file", uploadChat.single("file"), requireAuth, async (req, res) => {
    const { message, studentEmail, mode, subject, threadId } = req.body;

    if (!req.file) {
        return res.json({ success: false, response: "No file was uploaded." });
    }

    const file = req.file;
    const chatMode = mode === 'basic' ? 'basic' : 'advanced';

    console.log(`📎 Chat file upload from ${studentEmail || 'Guest'}:`, {
        name: file.originalname,
        mime: file.mimetype,
        size: (file.size / 1024).toFixed(1) + " KB"
    });

    try {
        const basePrompt = `You are a friendly AI Tutor for Taxila Learning Hub.
Your name is Gemini. You teach high school learners in South Africa.

You are a mathematics and science homework assistant.

ALWAYS format mathematical expressions using LaTeX:
- Fractions: \\frac{a}{b}
- Square roots: \\sqrt{x}
- Powers: x^2
- Subscripts: x_1
- Plus/minus: \\pm
- Greater/less than: \\geq, \\leq
- Greek letters: \\alpha, \\beta, \\theta
- Integrals: \\int
- Summation: \\sum

Put inline mathematics between \\( and \\).
Put equations that should appear on their own line between \\[ and \\].

Show calculations step-by-step and explain what each step means.
Do not replace mathematical symbols with words when a standard mathematical symbol exists.

The learner has uploaded a file or picture. Please help them with it.
If it is a homework sheet or exam paper, work through the question(s) step by step.
If it is a study guide, summarise or explain the key points.
If it is a screenshot of a textbook page, explain what is shown.
Always ask what specifically they would like help with if it is unclear.

Explain like the learner is seeing this for the FIRST time.
Use simple everyday words. Use small steps. Use emojis to make it friendly. 😊`;

        const systemPrompt = chatMode === 'basic'
            ? `${basePrompt}
Keep answers SHORT and SIMPLE — 1-2 short paragraphs max.`
            : `${basePrompt}
Give clear, detailed, well-structured explanations with examples.`;

        let contents;

        const isImage = file.mimetype.startsWith("image/");
        const isPdf = file.mimetype === "application/pdf";

        if (isImage || isPdf) {
            const fileBytes = fs.readFileSync(file.path);
            const base64 = fileBytes.toString("base64");

            contents = [
                {
                    role: "user",
                    parts: [
                        { text: message || "Please help me with this." },
                        {
                            inlineData: {
                                mimeType: file.mimetype,
                                data: base64
                            }
                        }
                    ]
                }
            ];

            console.log(`🖼️ Sending ${isImage ? "image" : "PDF"} bytes to Gemini (${base64.length} base64 chars)`);

        } else {
            let extractedText = "";

            try {
                if (file.mimetype === "text/plain" || file.mimetype === "text/csv" || file.mimetype === "text/markdown") {
                    extractedText = fs.readFileSync(file.path, "utf8");
                } else if (file.mimetype.includes("wordprocessingml")) {
                    const result = await mammoth.extractRawText({ path: file.path });
                    extractedText = result.value;
                } else {
                    extractedText = await officeParser.parseOfficeAsync(file.path);
                }
            } catch (extractErr) {
                console.error("❌ Text extraction failed:", extractErr);
                return res.json({
                    success: false,
                    response: "I couldn't read the text from that file. Try uploading it as a PDF or a picture instead. 🙏"
                });
            }

            const MAX = 30000;
            const trimmed = extractedText.length > MAX
                ? extractedText.slice(0, MAX) + "\n\n[...truncated — file was longer...]"
                : extractedText;

            contents = [
                {
                    role: "user",
                    parts: [
                        {
                            text: `The learner uploaded a file named "${file.originalname}".

CONTENT OF THE FILE:
${trimmed}

Learner's question: ${message || "Please help me understand this file."}`
                        }
                    ]
                }
            ];

            console.log(`📄 Extracted ${extractedText.length} chars from ${file.originalname}`);
        }

        // Save learner's message (with file mention) BEFORE the call
        const userLine = message
            ? `📎 [uploaded "${file.originalname}"] ${message}`
            : `📎 [uploaded "${file.originalname}"]`;
        await saveChatMessage(studentEmail, subject, 'user', userLine, threadId);
        // ---- Auto-title the thread from the first user message ----
        if (threadId) {
            try {
                const threadCheck = await sql.query`
            SELECT title FROM ChatThreads WHERE thread_id = ${threadId}
        `;
                if (threadCheck.recordset.length > 0 &&
                    threadCheck.recordset[0].title === 'New chat') {
                    // For file uploads, use the file name as the title
                    const newTitle = (message || `📎 ${file.originalname}`).substring(0, 60).trim();
                    await sql.query`
                UPDATE ChatThreads SET title = ${newTitle}
                WHERE thread_id = ${threadId}
            `;
                    console.log(`📝 Thread #${threadId} titled: "${newTitle}"`);
                }
            } catch (titleErr) {
                console.warn("Could not auto-title thread:", titleErr.message);
            }
        }

        const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: contents,
            config: {
                systemInstruction: systemPrompt,
                temperature: chatMode === 'basic' ? 0.6 : 0.8
            }
        });

        // Save bot reply
        await saveChatMessage(studentEmail, subject, 'bot', response.text, threadId);

        res.json({
            success: true,
            response: response.text,
            mode: chatMode,
            model: GEMINI_MODEL,
            file: {
                name: file.originalname,
                path: "/uploads/chat/" + file.filename,
                mime: file.mimetype
            }
        });

    } catch (err) {
        console.error("❌ /api/chat-with-file error:", err);
        res.json({
            success: false,
            response: "I had trouble reading that file. Please try again, or try a different format (PDF or photo). 🙏"
        });
    }
});

// ============================================
// ===== AI QUIZ GENERATION =====
// ============================================

const quizStorage = multer.diskStorage({
    destination: "public/uploads/chat/",
    filename: function (req, file, cb) {
        cb(null, "quiz-" + Date.now() + "-" + file.originalname);
    }
});

const uploadQuiz = multer({
    storage: quizStorage,
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        const ok = [
            "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/plain", "text/csv", "text/markdown"
        ];
        if (ok.includes(file.mimetype)) return cb(null, true);
        cb(new Error("Unsupported file type: " + file.mimetype));
    }
});

app.post("/api/generate-quiz-from-file", uploadQuiz.single("file"), requireAuth, async (req, res) => {
    const { email, subject, numQuestions, topicHint } = req.body;

    if (!email || !subject) {
        return res.json({ success: false, message: "email and subject are required" });
    }

    if (!req.file) {
        return res.json({ success: false, message: "No file was uploaded." });
    }

    const file = req.file;
    const questionCount = Math.min(Math.max(parseInt(numQuestions) || 5, 3), 10);

    console.log(`🧠 Generating ${questionCount}-question quiz from FILE for ${email} / ${subject}`);
    console.log(`📎 File: ${file.originalname} (${file.mimetype}, ${(file.size / 1024).toFixed(1)} KB)`);

    try {
        const studentResult = await sql.query`
            SELECT full_name, grade_level, stream FROM Learners WHERE email = ${email}
        `;
        if (studentResult.recordset.length === 0) {
            return res.json({ success: false, message: "Student not found" });
        }
        const { full_name, grade_level, stream } = studentResult.recordset[0];
        const streamValue = stream || '';

        const parts = [];
        const hint = topicHint && topicHint.trim()
            ? `\nFocus especially on this topic from the file: "${topicHint}".\n`
            : "";

        parts.push({
            text: `You are creating a quiz for a high school learner in South Africa.

Learner: ${full_name}
Subject: ${subject}
Grade: ${grade_level}
${hint}
Create exactly ${questionCount} multiple-choice questions BASED ONLY ON THE ATTACHED MATERIAL.
Each question must have:
- A clear question text
- Exactly 4 options labeled A, B, C, D
- The correct answer (A, B, C, or D)
- A one-sentence explanation of why that is the correct answer
- A difficulty tag: "Easy", "Medium", or "Hard"

Do NOT invent facts not present in the material.
Do NOT use LaTeX — write math in plain text like "2x + 2 = 0".
Do NOT use $ or $$ symbols.

Return ONLY valid JSON in exactly this format (no extra text before or after):

{
  "title": "Short descriptive title for the quiz",
  "questions": [
    {
      "question": "The question text?",
      "options": {
        "A": "First option",
        "B": "Second option",
        "C": "Third option",
        "D": "Fourth option"
      },
      "correct": "A",
      "explanation": "Why A is correct.",
      "difficulty": "Easy"
    }
  ]
}`
        });

        const isImage = file.mimetype.startsWith("image/");
        const isPdf = file.mimetype === "application/pdf";

        if (isImage || isPdf) {
            const base64 = fs.readFileSync(file.path).toString("base64");
            parts.push({
                inlineData: {
                    mimeType: file.mimetype,
                    data: base64
                }
            });
            console.log(`📎 Sending ${isImage ? "image" : "PDF"} bytes (${base64.length} base64 chars)`);
        } else {
            let text = "";
            try {
                if (file.mimetype === "text/plain" || file.mimetype === "text/csv" || file.mimetype === "text/markdown") {
                    text = fs.readFileSync(file.path, "utf8");
                } else if (file.mimetype.includes("wordprocessingml")) {
                    text = (await mammoth.extractRawText({ path: file.path })).value;
                } else {
                    text = await officeParser.parseOfficeAsync(file.path);
                }
            } catch (e) {
                console.error("❌ Extract failed:", e);
                return res.json({
                    success: false,
                    message: "I couldn't read that file. Try a PDF or a photo instead."
                });
            }

            if (!text || !text.trim()) {
                return res.json({
                    success: false,
                    message: "That file had no readable text. Try a PDF or a photo instead."
                });
            }

            const MAX = 30000;
            const trimmed = text.length > MAX
                ? text.slice(0, MAX) + "\n\n[...truncated...]"
                : text;

            parts.push({
                text: `\n=== CONTENT OF UPLOADED FILE ("${file.originalname}") ===\n${trimmed}\n\n=== END OF FILE ===\n\nNow generate the quiz as JSON, based only on the content above.`
            });

            console.log(`📄 Extracted ${text.length} chars from ${file.originalname}`);
        }

        const completion = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [{ role: "user", parts }],
            config: {
                temperature: 0.7,
                responseMimeType: "application/json"
            }
        });

        let quizText = completion.text.trim();
        quizText = quizText.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

        let quizData;
        try {
            quizData = JSON.parse(quizText);
        } catch (parseErr) {
            console.error("❌ Quiz JSON parse failed. Raw output:", quizText.slice(0, 500));
            return res.json({ success: false, message: "AI returned invalid JSON. Try again." });
        }

        if (!quizData.questions || quizData.questions.length === 0) {
            return res.json({ success: false, message: "AI generated no questions. Try again." });
        }

        const sourceTag = `file:${file.originalname}`;

        const saved = await sql.query`
            INSERT INTO Quizzes (student_email, subject, grade_level, stream, quiz_json, source_material_ids)
            OUTPUT INSERTED.quiz_id
            VALUES (
                ${email}, ${subject}, ${grade_level}, ${streamValue},
                ${JSON.stringify(quizData)},
                ${sourceTag}
            )
        `;

        const quizId = saved.recordset[0].quiz_id;

        console.log(`✅ Quiz #${quizId} created from file "${file.originalname}" with ${quizData.questions.length} questions`);

        res.json({
            success: true,
            quiz_id: quizId,
            quiz: quizData,
            source_file: file.originalname
        });

    } catch (err) {
        console.error("❌ /api/generate-quiz-from-file error:", err);
        res.json({ success: false, message: "Could not generate quiz: " + err.message });
    }
});

// ---- Legacy quiz endpoint (from teacher materials) ----
app.post("/api/generate-quiz", requireAuth, async (req, res) => {
    const { email, subject, numQuestions } = req.body;

    if (!email || !subject) {
        return res.json({ success: false, message: "email and subject are required" });
    }

    const questionCount = Math.min(Math.max(parseInt(numQuestions) || 5, 3), 10);

    console.log(`🧠 Generating ${questionCount}-question quiz for ${email} / ${subject}`);

    try {
        const studentResult = await sql.query`
            SELECT full_name, grade_level, stream FROM Learners WHERE email = ${email}
        `;
        if (studentResult.recordset.length === 0) {
            return res.json({ success: false, message: "Student not found" });
        }
        const { full_name, grade_level, stream } = studentResult.recordset[0];
        const streamValue = stream || '';

        const materialsResult = await sql.query`
            SELECT material_id, title, description, file_path, material_type
            FROM StudyMaterials
            WHERE subject = ${subject}
              AND (grade_level = ${grade_level} OR grade_level = 'All Grades')
              AND (stream = ${streamValue} OR stream IS NULL OR stream = '' OR stream = 'All Streams')
            ORDER BY created_at DESC
        `;

        if (materialsResult.recordset.length === 0) {
            return res.json({
                success: false,
                message: "No study materials available for this subject yet. Try uploading your own file instead."
            });
        }

        let materialText = "";
        const usedIds = [];
        const MAX_TOTAL = 40000;

        for (const m of materialsResult.recordset) {
            if (materialText.length > MAX_TOTAL) break;
            if (!m.file_path) continue;

            const abs = path.join(__dirname, "public", m.file_path);
            const lower = m.file_path.toLowerCase();
            let text = "";

            try {
                if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv")) {
                    text = fs.readFileSync(abs, "utf8");
                } else if (lower.endsWith(".docx")) {
                    const r = await mammoth.extractRawText({ path: abs });
                    text = r.value;
                } else if (lower.endsWith(".pptx") || lower.endsWith(".xlsx")) {
                    text = await officeParser.parseOfficeAsync(abs);
                } else if (lower.endsWith(".pdf")) {
                    text = await officeParser.parseOfficeAsync(abs);
                }
            } catch (e) {
                console.warn(`⚠️ Skipping ${m.file_path}: ${e.message}`);
                continue;
            }

            if (text && text.trim()) {
                text = text.slice(0, 8000);
                materialText += `\n\n--- MATERIAL: ${m.title} (id=${m.material_id}) ---\n${text}`;
                usedIds.push(m.material_id);
            }
        }

        if (!materialText.trim()) {
            return res.json({
                success: false,
                message: "I couldn't extract text from your teacher's materials. Try uploading your own PDF or photo instead."
            });
        }

        const prompt = `You are creating a quiz for a high school learner in South Africa.

Learner: ${full_name}
Subject: ${subject}
Grade: ${grade_level}

Here is the actual study material you must use:

${materialText}

---

Create exactly ${questionCount} multiple-choice questions BASED ONLY ON THE MATERIAL ABOVE.
Each question must have:
- A clear question text
- Exactly 4 options labeled A, B, C, D
- The correct answer (A, B, C, or D)
- A one-sentence explanation of why that is the correct answer
- A difficulty tag: "Easy", "Medium", or "Hard"

Do NOT invent facts not present in the material.
Do NOT use LaTeX — write math in plain text like "2x + 2 = 0".
Do NOT use $ or $$ symbols.

Return ONLY valid JSON in exactly this format (no extra text before or after):

{
  "title": "Short descriptive title for the quiz",
  "questions": [
    {
      "question": "The question text?",
      "options": {
        "A": "First option",
        "B": "Second option",
        "C": "Third option",
        "D": "Fourth option"
      },
      "correct": "A",
      "explanation": "Why A is correct.",
      "difficulty": "Easy"
    }
  ]
}`;

        const completion = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
                temperature: 0.7,
                responseMimeType: "application/json"
            }
        });

        let quizText = completion.text.trim();
        quizText = quizText.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

        let quizData;
        try {
            quizData = JSON.parse(quizText);
        } catch (parseErr) {
            console.error("❌ Quiz JSON parse failed. Raw output:", quizText.slice(0, 500));
            return res.json({ success: false, message: "AI returned invalid JSON. Try again." });
        }

        if (!quizData.questions || quizData.questions.length === 0) {
            return res.json({ success: false, message: "AI generated no questions. Try again." });
        }

        const saved = await sql.query`
            INSERT INTO Quizzes (student_email, subject, grade_level, stream, quiz_json, source_material_ids)
            OUTPUT INSERTED.quiz_id
            VALUES (
                ${email}, ${subject}, ${grade_level}, ${streamValue},
                ${JSON.stringify(quizData)},
                ${usedIds.join(",")}
            )
        `;

        const quizId = saved.recordset[0].quiz_id;

        console.log(`✅ Quiz #${quizId} created with ${quizData.questions.length} questions from ${usedIds.length} materials`);

        res.json({
            success: true,
            quiz_id: quizId,
            quiz: quizData,
            source_material_ids: usedIds
        });

    } catch (err) {
        console.error("❌ /api/generate-quiz error:", err);
        res.json({ success: false, message: "Could not generate quiz: " + err.message });
    }
});

// ---- Submit quiz answers ----
app.post("/api/submit-quiz", requireAuth, async (req, res) => {
    const { quiz_id, student_email, answers } = req.body;

    if (!quiz_id || !student_email || !answers) {
        return res.json({ success: false, message: "quiz_id, student_email, and answers are required" });
    }

    try {
        const quizResult = await sql.query`
            SELECT quiz_json, subject FROM Quizzes WHERE quiz_id = ${quiz_id}
        `;
        if (quizResult.recordset.length === 0) {
            return res.json({ success: false, message: "Quiz not found" });
        }

        const quizData = JSON.parse(quizResult.recordset[0].quiz_json);
        const questions = quizData.questions || [];

        let correct = 0;
        const detailed = [];

        questions.forEach((q, i) => {
            const given = (answers[i] || "").toUpperCase();
            const isCorrect = given === q.correct.toUpperCase();
            if (isCorrect) correct++;

            detailed.push({
                index: i,
                question: q.question,
                given,
                correct: q.correct,
                isCorrect,
                explanation: q.explanation
            });
        });

        const total = questions.length;
        const percentage = total > 0 ? (correct / total) * 100 : 0;

        const attemptResult = await sql.query`
            INSERT INTO QuizAttempts (quiz_id, student_email, score, total_questions, percentage, answers_json)
            OUTPUT INSERTED.attempt_id
            VALUES (
                ${quiz_id}, ${student_email},
                ${correct}, ${total}, ${percentage.toFixed(2)},
                ${JSON.stringify(detailed)}
            )
        `;

        console.log(`📝 Quiz #${quiz_id} attempt: ${correct}/${total} (${percentage.toFixed(1)}%)`);

        res.json({
            success: true,
            attempt_id: attemptResult.recordset[0].attempt_id,
            score: correct,
            total,
            percentage: parseFloat(percentage.toFixed(1)),
            detailed
        });

    } catch (err) {
        console.error("❌ /api/submit-quiz error:", err);
        res.json({ success: false, message: "Could not save attempt: " + err.message });
    }
});

// ---- Quiz history ----
app.get("/api/quiz-history", requireAuth, async (req, res) => {
    const { email, subject } = req.query;

    if (!email) {
        return res.json({ success: false, message: "email is required" });
    }

    try {
        let query;
        if (subject) {
            query = sql.query`
                SELECT 
                    q.quiz_id,
                    q.subject,
                    q.created_at,
                    q.source_material_ids,
                    a.attempt_id,
                    a.score,
                    a.total_questions,
                    a.percentage,
                    a.completed_at
                FROM QuizAttempts a
                INNER JOIN Quizzes q ON q.quiz_id = a.quiz_id
                WHERE a.student_email = ${email} AND q.subject = ${subject}
                ORDER BY a.completed_at DESC
            `;
        } else {
            query = sql.query`
                SELECT 
                    q.quiz_id,
                    q.subject,
                    q.created_at,
                    q.source_material_ids,
                    a.attempt_id,
                    a.score,
                    a.total_questions,
                    a.percentage,
                    a.completed_at
                FROM QuizAttempts a
                INNER JOIN Quizzes q ON q.quiz_id = a.quiz_id
                WHERE a.student_email = ${email}
                ORDER BY a.completed_at DESC
            `;
        }

        const result = await query;
        res.json({ success: true, attempts: result.recordset });

    } catch (err) {
        console.error("❌ /api/quiz-history error:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== ADMIN SMS ROUTES =====
// ============================================

app.post("/admin/preview-sms", requireAuth, async (req, res) => {
    const { message, grade } = req.body;

    if (!message) {
        return res.json({ success: false, message: "Please enter a message" });
    }

    try {
        let query;
        if (grade === 'All Grades') {
            query = sql.query`
                SELECT full_name, phone_number, learner_name, learner_grade
                FROM Parents 
                WHERE phone_number IS NOT NULL
            
            `;
        } else {
            query = sql.query`
                SELECT full_name, phone_number, learner_name, learner_grade
                FROM Parents 
                WHERE learner_grade = ${grade} 
                AND phone_number IS NOT NULL
            `;
        }

        const result = await query;
        const recipients = result.recordset;

        res.json({
            success: true,
            recipients_count: recipients.length,
            recipients: recipients
        });

    } catch (err) {
        console.error("Error previewing SMS:", err);
        res.json({ success: false, message: "Failed to preview SMS" });
    }
});

app.post("/admin/send-sms", requireAuth, async (req, res) => {
    const { title, message, grade, recipients } = req.body;

    if (!message || recipients.length === 0) {
        return res.json({ success: false, message: "No recipients or message" });
    }

    try {
        let sentCount = 0;
        let failedCount = 0;

        await sql.query`
            INSERT INTO SmsLogs (announcement_title, grade, recipients_count, status)
            VALUES (${title}, ${grade}, ${recipients.length}, 'sending')
        `;

        for (const parent of recipients) {
            if (parent.phone_number) {
                try {
                    await sendSms(parent.phone_number, `📢 ${title}\n\n${message}\n\n- Taxila Learning Hub`);
                    sentCount++;
                    console.log(`✅ SMS sent to ${parent.phone_number}`);
                } catch (err) {
                    failedCount++;
                    console.error(`Failed to send SMS to ${parent.phone_number}:`, err);
                }
            }
        }

        await sql.query`
            UPDATE SmsLogs 
            SET status = 'sent', 
                recipients_count = ${sentCount}
            WHERE announcement_title = ${title} 
            AND grade = ${grade}
            AND created_at = (SELECT MAX(created_at) FROM SmsLogs WHERE announcement_title = ${title})
        `;

        res.json({
            success: true,
            message: `SMS sent to ${sentCount} parents (${failedCount} failed)`
        });

    } catch (err) {
        console.error("Error sending SMS:", err);
        res.json({ success: false, message: "Failed to send SMS" });
    }
});

// ============================================
// ===== GET ALL LEARNERS =====
// ============================================

app.get("/learners", requireAuth, async (req, res) => {
    try {
        const result = await sql.query`
            SELECT learner_id, full_name, email, grade_level, stream 
            FROM Learners
            ORDER BY full_name
        `;
        res.json(result.recordset);
    } catch (err) {
        console.error("❌ Error fetching learners:", err);
        res.json([]);
    }
});

// ============================================
// ===== DEBUG ROUTES =====
// ============================================

app.get("/sms-test", requireAuth, async (req, res) => {
    try {
        const hasKey = !!process.env.SMS_API_KEY;

        const result = await sql.query`
            SELECT COUNT(*) as count 
            FROM Parents 
            WHERE phone_number IS NOT NULL
        `;

        const parents = await sql.query`
            SELECT full_name, email, phone_number, learner_name, learner_grade
            FROM Parents 
            WHERE phone_number IS NOT NULL
        `;

        res.json({
            success: true,
            sms_configured: hasKey,
            parent_count: result.recordset[0].count,
            parents: parents.recordset,
            message: hasKey ? '✅ SMS is configured' : '❌ SMS API key is missing'
        });
    } catch (err) {
        console.error("❌ SMS test error:", err);
        res.json({ success: false, error: err.message });
    }
});

app.get("/debug-gemini", requireAuth, async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    const hasKey = !!apiKey;
    const keyPreview = apiKey ? apiKey.substring(0, 10) + '...' : 'Not set';

    res.json({
        hasApiKey: hasKey,
        keyPreview: keyPreview,
        keyLength: apiKey ? apiKey.length : 0,
        message: hasKey ? '✅ Gemini API Key is set' : '❌ Gemini API Key is missing!'
    });
});

app.get("/debug-attendance", requireAuth, async (req, res) => {
    try {
        const result = await sql.query`SELECT * FROM Attendance ORDER BY created_at DESC`;
        res.json({
            count: result.recordset.length,
            records: result.recordset
        });
    } catch (err) {
        res.json({ error: err.message });
    }
});

app.get("/simple-test", requireAuth, async (req, res) => {
    try {
        const result = await sql.query`SELECT COUNT(*) as count FROM Attendance`;
        res.json({
            success: true,
            count: result.recordset[0].count,
            message: "Connection working!"
        });
    } catch (err) {
        res.json({
            success: false,
            error: err.message
        });
    }
});

// ============================================
// ===== START SERVER =====
// ============================================

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`\n📋 Available routes:`);
    console.log(`  GET  / - Login page`);
    console.log(`  POST /login - Login user`);
    console.log(`  GET  /announcements - Get all announcements`);
    console.log(`  POST /add-announcement - Add announcement`);
    console.log(`  DELETE /delete-announcement/:id - Delete announcement`);
    console.log(`  GET  /homework - Get all homework`);
    console.log(`  POST /upload-homework - Upload homework`);
    console.log(`  DELETE /delete-homework/:id - Delete homework`);
    console.log(`  GET  /study-materials - Get all study materials`);
    console.log(`  POST /upload-study-material - Upload study material`);
    console.log(`  DELETE /delete-study-material/:id - Delete study material`);
    console.log(`  GET  /users - Get all users`);
    console.log(`  DELETE /users/:id - Delete user`);
    console.log(`  POST /update-stream - Update learner stream`);
    console.log(`  POST /add-mark - Add mark`);
    console.log(`  GET  /marks/:email - Get marks for student`);
    console.log(`  GET  /all-marks - Get all marks`);
    console.log(`  PUT  /update-mark/:id - Update mark`);
    console.log(`  GET  /attendance/:email - Get attendance for student`);
    console.log(`  GET  /student-performance/:email - Get student performance`);
    console.log(`  GET  /learners - Get all learners`);
    console.log(`\n🤖 AI Routes:`);
    console.log(`  POST /api/chat - Dynamic Gemini AI Chat`);
    console.log(`  POST /api/chat-with-file - Chat with uploaded image/PDF/DOCX/PPTX`);
    console.log(`  GET  /api/chat/status - AI Status`);
    console.log(`  POST /api/chat/reset - Reset grounded session`);
    console.log(`  GET  /api/ai-context - Course material for AI grounding`);
    console.log(`  GET  /api/chat-history - Get saved chat history`);
    console.log(`  DELETE /api/chat-history - Clear chat history`);
    console.log(`\n🧠 Quiz Routes:`);
    console.log(`  POST /api/generate-quiz-from-file - Quiz from learner's upload`);
    console.log(`  POST /api/generate-quiz - Quiz from teacher's study materials`);
    console.log(`  POST /api/submit-quiz - Submit answers and get score`);
    console.log(`  GET  /api/quiz-history - Get learner quiz history`);
    console.log(`\n📱 SMS Routes:`);
    console.log(`  POST /admin/preview-sms - Preview SMS recipients`);
    console.log(`  POST /admin/send-sms - Send SMS to parents`);
    console.log(`  GET  /sms-test - Test SMS configuration`);
    console.log(`\n🔍 Test routes:`);
    console.log(`  GET  /simple-test - Simple connection test`);
    console.log(`  GET  /debug-attendance - Debug attendance`);
    console.log(`  GET  /debug-gemini - Check Gemini Key setup`);
    console.log(`\n✅ Server ready!`);
    exec(`start microsoft-edge:http://localhost:${PORT}`);
});

app.get("/test-ai", requireAuth, async (req, res) => {
    try {
        const result = await ai.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }]
        });
        res.json({ success: true, response: result.text });
    } catch (err) {
        console.error("❌ Test AI error:", err);
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// ===== TEACHER CLASSES ROUTE =====
// ============================================

app.get("/teacher-classes/:teacherEmail", requireAuth, async (req, res) => {
    try {
        const teacherEmail = req.params.teacherEmail;

        const classes = await sql.query`
            SELECT subject, grade FROM TeacherSubjects 
            WHERE teacher_email = ${teacherEmail}
            ORDER BY grade, subject
        `;

        res.json({
            success: true,
            classes: classes.recordset
        });
    } catch (err) {
        console.error("Error fetching teacher classes:", err);
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// ===== CLASS STUDENT COUNT =====
// ============================================

app.get("/class-student-count", requireAuth, async (req, res) => {
    try {
        const subject = req.query.subject;
        const grade = req.query.grade;

        console.log("🔍 Counting for:", { subject, grade });

        if (!subject || !grade) {
            return res.json({ success: false, count: 0 });
        }

        const subjectInfo = await sql.query`
            SELECT stream FROM Subjects 
            WHERE subject_name = ${subject} AND grade_level = ${grade}
        `;

        const streams = subjectInfo.recordset.map(s => s.stream);
        console.log("📊 Streams:", streams);

        let result;

        if (streams.length === 0) {
            return res.json({ success: true, count: 0 });
        }

        if (streams.length > 1 || streams.includes('All')) {
            result = await sql.query`
                SELECT COUNT(*) as count
                FROM Learners 
                WHERE grade_level = ${grade}
            `;
        } else {
            const singleStream = streams[0];
            result = await sql.query`
                SELECT COUNT(*) as count
                FROM Learners 
                WHERE grade_level = ${grade}
                AND stream = ${singleStream}
            `;
        }

        console.log("📊 Count:", result.recordset[0].count);

        res.json({
            success: true,
            count: result.recordset[0]?.count || 0
        });
    } catch (err) {
        console.error("Error getting student count:", err);
        res.json({ success: false, count: 0 });
    }
});

// ============================================
// ===== CLASS STUDENTS ROUTE =====
// ============================================

app.get("/class-students", requireAuth, async (req, res) => {
    try {
        const subject = req.query.subject;
        const grade = req.query.grade;

        if (!subject || !grade) {
            return res.json({ success: false, students: [] });
        }

        const result = await sql.query`
            SELECT l.full_name, l.email
            FROM Learners l
            WHERE l.grade_level = ${grade}
            AND l.stream IN (
                SELECT stream FROM Subjects 
                WHERE subject_name = ${subject} 
                AND grade_level = ${grade}
            )
            ORDER BY l.full_name
        `;

        res.json({
            success: true,
            students: result.recordset
        });
    } catch (err) {
        console.error("Error getting class students:", err);
        res.json({ success: false, students: [] });
    }
});

// ============================================
// ===== GET STUDENT SUBJECTS =====
// ============================================

app.get("/student-subjects/:email", requireAuth, async (req, res) => {
    try {
        const email = req.params.email;

        const studentResult = await sql.query`
            SELECT grade_level, stream FROM Learners WHERE email = ${email}
        `;

        if (studentResult.recordset.length === 0) {
            return res.json({ success: false, subjects: [] });
        }

        const student = studentResult.recordset[0];
        const grade = student.grade_level;
        const stream = student.stream;

        let subjects;
        if (grade === 'Grade 8' || grade === 'Grade 9') {
            subjects = await sql.query`
                SELECT subject_name FROM Subjects 
                WHERE grade_level = ${grade} AND stream IS NULL
                ORDER BY subject_name
            `;
        } else {
            subjects = await sql.query`
                SELECT subject_name FROM Subjects 
                WHERE grade_level = ${grade} AND stream = ${stream}
                ORDER BY subject_name
            `;
        }

        res.json({
            success: true,
            subjects: subjects.recordset.map(s => s.subject_name)
        });

    } catch (err) {
        console.error("Error getting student subjects:", err);
        res.json({ success: false, subjects: [] });
    }
});

// ============================================
// ===== GET ACTIVITY LOGS =====
// ============================================

app.get("/activity-logs", requireAuth, requireRole("admin"), async (req, res) => {
    try {
        const role = req.query.role;
        const action = req.query.action;
        const date = req.query.date;

        // Use a prepared request with bound parameters.
        // Values are sent separately from the SQL — injection is impossible.
        const request = new sql.Request();

        let query = 'SELECT * FROM ActivityLogs WHERE 1=1';

        if (role && role !== 'all') {
            query += ' AND role = @role';
            request.input('role', sql.NVarChar, role);
        }
        if (action && action !== 'all') {
            query += ' AND action = @action';
            request.input('action', sql.NVarChar, action);
        }
        if (date) {
            query += ' AND CAST(timestamp AS DATE) = @date';
            request.input('date', sql.Date, date);
        }

        query += ' ORDER BY timestamp DESC';

        const result = await request.query(query);
        res.json({ success: true, logs: result.recordset });
    } catch (err) {
        console.error('Error fetching activity logs:', err);
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// ===== CLEAR ACTIVITY LOGS =====
// ============================================

app.delete("/clear-activity-logs", requireAuth, async (req, res) => {
    try {
        await sql.query`DELETE FROM ActivityLogs`;
        res.json({ success: true, message: "All activity logs cleared" });
    } catch (err) {
        console.error('Error clearing logs:', err);
        res.json({ success: false, message: "Failed to clear logs" });
    }
});

// ============================================
// ===== MANAGE TEACHERS - ADMIN =====
// ============================================

app.get("/manage-teachers", requireAuth, async (req, res) => {
    try {
        const teachers = await sql.query`
            SELECT teacher_id, full_name, email FROM Teachers
        `;

        const subjects = await sql.query`
            SELECT * FROM TeacherSubjects
        `;

        const result = teachers.recordset.map(teacher => {
            const teacherSubjects = subjects.recordset.filter(s => s.teacher_email === teacher.email);
            return {
                ...teacher,
                subjects: teacherSubjects
            };
        });

        res.json({ success: true, teachers: result });
    } catch (err) {
        console.error("Error fetching teachers:", err);
        res.json({ success: false, error: err.message });
    }
});

app.post("/assign-teacher-subject", requireAuth, async (req, res) => {
    const { teacher_email, subject, grade } = req.body;

    if (!teacher_email || !subject || !grade) {
        return res.json({ success: false, message: "Please fill all fields" });
    }

    try {
        const existing = await sql.query`
            SELECT * FROM TeacherSubjects 
            WHERE teacher_email = ${teacher_email} 
            AND subject = ${subject} 
            AND grade = ${grade}
        `;

        if (existing.recordset.length > 0) {
            return res.json({ success: false, message: "This subject is already assigned to this teacher" });
        }

        await sql.query`
            INSERT INTO TeacherSubjects (teacher_email, subject, grade)
            VALUES (${teacher_email}, ${subject}, ${grade})
        `;

        res.json({ success: true, message: "Subject assigned successfully" });
    } catch (err) {
        console.error("Error assigning subject:", err);
        res.json({ success: false, message: "Failed to assign subject" });
    }
});

app.delete("/remove-teacher-subject/:id", requireAuth, async (req, res) => {
    const id = req.params.id;

    try {
        await sql.query`
            DELETE FROM TeacherSubjects WHERE id = ${id}
        `;
        res.json({ success: true, message: "Subject removed successfully" });
    } catch (err) {
        console.error("Error removing subject:", err);
        res.json({ success: false, message: "Failed to remove subject" });
    }
});

app.delete("/delete-teacher/:id", requireAuth, async (req, res) => {
    const id = req.params.id;

    try {
        await sql.query`
            DELETE FROM TeacherSubjects WHERE teacher_email IN (
                SELECT email FROM Teachers WHERE teacher_id = ${id}
            )
        `;
        await sql.query`
            DELETE FROM Teachers WHERE teacher_id = ${id}
        `;
        res.json({ success: true, message: "Teacher deleted successfully" });
    } catch (err) {
        console.error("Error deleting teacher:", err);
        res.json({ success: false, message: "Failed to delete teacher" });
    }
});

// ============================================
// ===== GET SUBJECTS BY GRADE =====
// ============================================

app.get("/subjects-by-grade/:grade", requireAuth, async (req, res) => {
    try {
        const grade = req.params.grade;

        const result = await sql.query`
            SELECT DISTINCT subject_name FROM Subjects 
            WHERE grade_level = ${grade}
            ORDER BY subject_name
        `;

        res.json({ success: true, subjects: result.recordset });
    } catch (err) {
        console.error("Error fetching subjects:", err);
        res.json({ success: false, subjects: [] });
    }
});

// ============================================
// ===== MANAGE STREAMS & SUBJECTS =====
// ============================================

app.get("/streams", requireAuth, async (req, res) => {
    try {
        const result = await sql.query`
            SELECT DISTINCT stream FROM Subjects 
            WHERE stream IS NOT NULL AND stream != ''
            ORDER BY stream
        `;
        const streams = result.recordset.map(s => s.stream);
        streams.push('General');
        res.json({ success: true, streams: streams });
    } catch (err) {
        console.error("Error fetching streams:", err);
        res.json({ success: false, error: err.message });
    }
});

app.post("/add-subject", requireAuth, async (req, res) => {
    const { subject_name, stream, grade_level } = req.body;

    if (!subject_name || !stream || !grade_level) {
        return res.json({ success: false, message: "Please fill all fields" });
    }

    try {
        const streamValue = stream === 'General' ? null : stream;

        const existing = await sql.query`
            SELECT * FROM Subjects 
            WHERE subject_name = ${subject_name} 
            AND (stream = ${streamValue} OR (stream IS NULL AND ${streamValue} IS NULL))
            AND grade_level = ${grade_level}
        `;

        if (existing.recordset.length > 0) {
            return res.json({ success: false, message: "This subject already exists" });
        }

        await sql.query`
            INSERT INTO Subjects (subject_name, stream, grade_level)
            VALUES (${subject_name}, ${streamValue}, ${grade_level})
        `;

        res.json({ success: true, message: "Subject added successfully" });
    } catch (err) {
        console.error("Error adding subject:", err);
        res.json({ success: false, message: "Failed to add subject" });
    }
});

app.delete("/delete-subject/:id", requireAuth, async (req, res) => {
    const id = req.params.id;

    try {
        await sql.query`
            DELETE FROM Subjects WHERE subject_id = ${id}
        `;
        res.json({ success: true, message: "Subject deleted successfully" });
    } catch (err) {
        console.error("Error deleting subject:", err);
        res.json({ success: false, message: "Failed to delete subject" });
    }
});

app.get("/all-subjects", requireAuth, async (req, res) => {
    try {
        const result = await sql.query`
            SELECT subject_id, subject_name, stream, grade_level 
            FROM Subjects 
            ORDER BY subject_name
        `;
        res.json({ success: true, subjects: result.recordset });
    } catch (err) {
        console.error("Error fetching all subjects:", err);
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// ===== AI RISK PREDICTION (SUBJECT-SPECIFIC) =====
// ============================================

const { spawn } = require('child_process');

app.post("/api/predict-risk", requireAuth, async (req, res) => {
    const { student_email, subject } = req.body;

    if (!student_email || !subject) {
        return res.json({ success: false, message: "Student email and subject are required" });
    }

    try {
        const studentResult = await sql.query`
            SELECT full_name, grade_level, stream 
            FROM Learners 
            WHERE email = ${student_email}
        `;

        if (studentResult.recordset.length === 0) {
            return res.json({ success: false, message: "Student not found" });
        }

        const student = studentResult.recordset[0];

        const marksResult = await sql.query`
            SELECT score FROM Marks 
            WHERE student_email = ${student_email} 
            AND subject = ${subject}
        `;

        if (marksResult.recordset.length === 0) {
            return res.json({
                success: false,
                message: `No marks found for ${subject}. Please upload marks first.`
            });
        }

        let totalScore = 0;
        marksResult.recordset.forEach(m => {
            totalScore += parseFloat(m.score) || 0;
        });
        const avgScore = totalScore / marksResult.recordset.length;

        const attendanceResult = await sql.query`
            SELECT COUNT(*) as total, 
                   SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END) as absent
            FROM Attendance 
            WHERE student_email = ${student_email}
        `;

        let absences = 0;
        if (attendanceResult.recordset.length > 0) {
            absences = attendanceResult.recordset[0].absent || 0;
        }

        const studentData = {
            'Age': 16,
            'Gender': 1,
            'StudyTimeWeekly': 10,
            'Absences': absences,
            'GPA': avgScore / 20,
            'ParentalSupport': 1,
            'Tutoring': 0,
            'Extracurricular': 0,
            'Sports': 0,
            'Music': 0,
            'Volunteering': 0
        };

        console.log(`📊 Predicting risk for ${student.full_name} - ${subject}`);
        console.log("📊 Data:", studentData);

        const pythonProcess = spawn('python', ['predict_subject_risk.py', JSON.stringify(studentData)]);
        pythonProcess.on('error', (err) => {
            console.error('❌ Failed to start Python:', err);
            return res.json({ success: false, message: "Python script not found" });
        });
        let resultData = '';
        pythonProcess.stdout.on('data', (data) => {
            resultData += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            console.error('Python error:', data.toString());
        });

        pythonProcess.on('close', (code) => {
            if (code === 0) {
                try {
                    const prediction = JSON.parse(resultData);

                    res.json({
                        success: true,
                        student: student.full_name,
                        grade: student.grade_level,
                        stream: student.stream,
                        subject: subject,
                        average_score: parseFloat(avgScore.toFixed(1)),
                        absences: absences,
                        risk_level: prediction.risk_level,
                        status: prediction.status,
                        confidence: prediction.confidence
                    });
                } catch (parseError) {
                    console.error("Parse error:", parseError);
                    res.json({ success: false, message: "Error parsing prediction" });
                }
            } else {
                res.json({ success: false, message: "Prediction failed" });
            }
        });

    } catch (err) {
        console.error("Error predicting risk:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== ADMIN ATTENDANCE ROUTES =====
// ============================================

app.get("/admin/learners-by-grade/:grade", requireAuth, async (req, res) => {
    try {
        const grade = req.params.grade;
        console.log("🔍 Fetching learners for grade:", grade);

        const result = await sql.query`
            SELECT learner_id, full_name, email, grade_level, stream
            FROM Learners 
            WHERE grade_level = ${grade}
            ORDER BY full_name
        `;

        console.log("📊 Found:", result.recordset.length, "learners");
        res.json({ success: true, learners: result.recordset });
    } catch (err) {
        console.error("❌ Error fetching learners:", err);
        res.json({ success: false, message: err.message });
    }
});

app.get("/admin/check-attendance", requireAuth, async (req, res) => {
    try {
        const date = req.query.date;
        const grade = req.query.grade;

        console.log("🔍 Checking attendance for:", { date, grade, year: CURRENT_YEAR });

        if (!date || !grade) {
            return res.json({
                success: false,
                exists: false,
                records: [],
                message: "Date and grade are required"
            });
        }

        const result = await sql.query`
            SELECT attendance_id, student_email, learner_name, status
            FROM Attendance 
            WHERE date_recorded = ${date} 
              AND grade_level = ${grade}
              AND academic_year = ${CURRENT_YEAR}
        `;

        console.log(`📊 Found: ${result.recordset.length} records`);

        res.json({
            success: true,
            exists: result.recordset.length > 0,
            records: result.recordset
        });
    } catch (err) {
        console.error("❌ Error checking attendance:", err);
        res.json({ success: false, exists: false, records: [], message: err.message });
    }
});

app.post("/admin/save-attendance", requireAuth, async (req, res) => {
    const { date, grade, absent_emails, all_learners, admin_name } = req.body;

    console.log("💾 Saving attendance for:", { date, grade, year: CURRENT_YEAR, count: all_learners?.length });

    if (!date || !grade) {
        return res.json({ success: false, message: "Date and grade are required" });
    }

    if (!all_learners || all_learners.length === 0) {
        return res.json({ success: false, message: "No learners provided" });
    }

    try {
        const admin = admin_name || 'Admin';

        let insertedCount = 0;
        let updatedCount = 0;

        for (const learner of all_learners) {
            const isAbsent = absent_emails.includes(learner.email);
            const status = isAbsent ? 'Absent' : 'Present';

            // Look for existing row for THIS year (not any year)
            const existing = await sql.query`
                SELECT attendance_id FROM Attendance 
                WHERE student_email = ${learner.email} 
                  AND date_recorded = ${date}
                  AND academic_year = ${CURRENT_YEAR}
            `;

            if (existing.recordset.length > 0) {
                await sql.query`
                    UPDATE Attendance 
                    SET status = ${status}, 
                        learner_name = ${learner.full_name},
                        grade_level = ${grade},
                        recorded_by = ${admin}
                    WHERE student_email = ${learner.email} 
                      AND date_recorded = ${date}
                      AND academic_year = ${CURRENT_YEAR}
                `;
                updatedCount++;
            } else {
                await sql.query`
                    INSERT INTO Attendance 
                        (student_email, learner_name, date_recorded, status, grade_level, recorded_by, academic_year)
                    VALUES 
                        (${learner.email}, ${learner.full_name}, ${date}, ${status}, ${grade}, ${admin}, ${CURRENT_YEAR})
                `;
                insertedCount++;
            }
        }

        await logActivity(admin, admin, 'admin', 'Recorded attendance',
            `Grade: ${grade}, Date: ${date}, Year: ${CURRENT_YEAR}, Total: ${all_learners.length}`);

        let message;
        if (insertedCount > 0 && updatedCount === 0) {
            message = `Attendance recorded for ${insertedCount} learner${insertedCount === 1 ? '' : 's'}`;
        } else if (updatedCount > 0 && insertedCount === 0) {
            message = `Attendance updated for ${updatedCount} learner${updatedCount === 1 ? '' : 's'}`;
        } else {
            message = `Attendance saved: ${insertedCount} new, ${updatedCount} updated`;
        }

        res.json({ success: true, message });

    } catch (err) {
        console.error("❌ Error saving attendance:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== CLASS RISK PREDICTION (BATCH) =====
// ============================================


// Helper: run a Python script and return its parsed JSON output
function runPythonJson(scriptName, payload) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(__dirname, scriptName);
        const proc = spawn('python', [scriptPath, JSON.stringify(payload)]);

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', chunk => stdout += chunk.toString());
        proc.stderr.on('data', chunk => stderr += chunk.toString());

        proc.on('error', err => reject(err));

        proc.on('close', code => {
            if (code !== 0) {
                return reject(new Error(stderr || `Python exited with code ${code}`));
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error('Bad JSON from Python: ' + stdout.slice(0, 200)));
            }
        });
    });
}

app.post("/api/predict-class-ai", requireAuth, async (req, res) => {
    console.log("🚀 /api/predict-class-ai endpoint reached!", { year: CURRENT_YEAR });
    const { subject, grade } = req.body;

    if (!subject || !grade) {
        return res.json({ success: false, message: "Subject and grade are required" });
    }

    try {
        // 1. Get learners in this class
        const studentsResult = await sql.query`
            SELECT l.email, l.full_name, l.grade_level, l.stream, l.gender
            FROM Learners l
            WHERE l.grade_level = ${grade}
            AND l.stream IN (
                SELECT stream FROM Subjects 
                WHERE subject_name = ${subject} 
                AND grade_level = ${grade}
            )
            ORDER BY l.full_name
        `;

        if (studentsResult.recordset.length === 0) {
            return res.json({
                success: true,
                students: [],
                stats: { total: 0, safe: 0, borderline: 0, at_risk: 0 }
            });
        }

        const results = [];

        for (const student of studentsResult.recordset) {
            // ---- Feature 1: Absences (current year only) ----
            const attendanceResult = await sql.query`
                SELECT 
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END) AS absent
                FROM Attendance 
                WHERE student_email = ${student.email}
                  AND academic_year = ${CURRENT_YEAR}
            `;
            const absences = attendanceResult.recordset[0]?.absent || 0;

            // ---- Feature 2: GPA (latest term average for this subject, current year) ----
            const marksByTerm = await sql.query`
                SELECT term, AVG(CAST(score AS FLOAT)) AS avg_score
                FROM Marks
                WHERE student_email = ${student.email} 
                  AND subject = ${subject}
                  AND academic_year = ${CURRENT_YEAR}
                GROUP BY term
            `;

            // Pick latest term that has marks
            const termOrder = ['Term 4', 'Term 3', 'Term 2', 'Term 1'];
            let latestAvg = 0;
            let latestTerm = null;
            for (const t of termOrder) {
                const row = marksByTerm.recordset.find(r => r.term === t);
                if (row) {
                    latestAvg = row.avg_score;
                    latestTerm = t;
                    break;
                }
            }

            const gpaScaled = latestAvg / 25;

            // ---- Feature 3: Age from grade level ----
            const gradeNum = parseInt(String(student.grade_level).replace(/\D/g, ''), 10) || 10;
            const age = gradeNum + 7;

            // ---- Feature 4: Gender ----
            const gender = (student.gender || '').toUpperCase() === 'M' ? 1 : 0;

            // ---- Call the model ----
            let prediction;
            try {
                prediction = await runPythonJson('predict_risk.py', {
                    Absences: absences,
                    GPA: gpaScaled,
                    Age: age,
                    Gender: gender
                });
            } catch (err) {
                console.error(`❌ Prediction failed for ${student.email}:`, err.message);
                prediction = {
                    risk_level: 'Unknown',
                    confidence: 0,
                    error: err.message
                };
            }

            results.push({
                email: student.email,
                full_name: student.full_name,
                grade_level: student.grade_level,
                stream: student.stream,
                average_score: parseFloat(latestAvg.toFixed(1)),
                latest_term: latestTerm,
                absences: absences,
                risk_level: prediction.risk_level,
                confidence: prediction.confidence,
                probabilities: prediction.probabilities || null
            });
        }

        const riskOrder = { 'At Risk': 0, 'Borderline': 1, 'Safe': 2, 'Unknown': 3 };
        results.sort((a, b) => (riskOrder[a.risk_level] ?? 9) - (riskOrder[b.risk_level] ?? 9));

        const stats = {
            total: results.length,
            at_risk: results.filter(r => r.risk_level === 'At Risk').length,
            borderline: results.filter(r => r.risk_level === 'Borderline').length,
            safe: results.filter(r => r.risk_level === 'Safe').length
        };

        console.log(`✅ Predicted ${results.length} learners:`, stats);

        res.json({ success: true, students: results, stats });

    } catch (err) {
        console.error("❌ Error predicting class risk:", err);
        res.json({ success: false, message: err.message });
    }
});

// ============================================
// ===== END OF YEAR PROMOTION ROUTES =====
// ============================================

// ---- Summary: how many learners in each grade still need a decision? ----
app.get("/admin/promotion-summary", requireAuth, async (req, res) => {
    try {
        console.log("📊 /admin/promotion-summary called (current year:", CURRENT_YEAR + ")");

        // Learners who have an enrollment for the current year, but no outcome yet
        // i.e., still awaiting a promotion decision
        const result = await sql.query`
            SELECT 
                e.grade_level,
                COUNT(*) AS total_learners
            FROM LearnerEnrollments e
            WHERE e.academic_year = ${CURRENT_YEAR}
              AND e.outcome IS NULL
              AND e.grade_level <> 'Grade 12'
            GROUP BY e.grade_level
            ORDER BY CAST(REPLACE(e.grade_level, 'Grade ', '') AS INT)
        `;

        // Get info about the most recent promotion batch, if any
        const batchResult = await sql.query`
            SELECT TOP 1
                promotion_batch_id,
                MIN(created_at) AS batch_date,
                COUNT(DISTINCT student_email) AS learner_count
            FROM LearnerEnrollments
            WHERE promotion_batch_id IS NOT NULL
            GROUP BY promotion_batch_id
            ORDER BY MIN(created_at) DESC
        `;

        const lastBatch = batchResult.recordset[0] || null;

        res.json({
            success: true,
            current_year: CURRENT_YEAR,
            next_year: CURRENT_YEAR + 1,
            grades: result.recordset,
            last_batch: lastBatch
        });
    } catch (err) {
        console.error("❌ /admin/promotion-summary error:", err);
        res.json({ success: false, message: err.message });
    }
});

// ---- Get learners in a specific grade awaiting a promotion decision ----
app.get("/admin/promotion-grade/:grade", requireAuth, async (req, res) => {
    try {
        const grade = req.params.grade;
        console.log(`📋 /admin/promotion-grade/${grade} (current year: ${CURRENT_YEAR})`);

        if (grade === 'Grade 12') {
            return res.json({
                success: false,
                message: "Grade 12 promotions are not managed here."
            });
        }

        const result = await sql.query`
            SELECT 
                l.email,
                l.full_name,
                l.grade_level,
                l.stream,
                l.gender,
                e.enrollment_id,
                e.academic_year,
                e.outcome
            FROM Learners l
            INNER JOIN LearnerEnrollments e 
                ON e.student_email = l.email
                AND e.academic_year = ${CURRENT_YEAR}
            WHERE l.grade_level = ${grade}
              AND e.outcome IS NULL
            ORDER BY l.full_name
        `;

        // Next grade calculation
        const gradeNum = parseInt(grade.replace(/\D/g, ''), 10);
        const nextGrade = `Grade ${gradeNum + 1}`;

        res.json({
            success: true,
            grade: grade,
            next_grade: nextGrade,
            current_year: CURRENT_YEAR,
            next_year: CURRENT_YEAR + 1,
            learners: result.recordset
        });
    } catch (err) {
        console.error("❌ /admin/promotion-grade error:", err);
        res.json({ success: false, message: err.message });
    }
});

// ---- List of past promotion batches (for undo) ----
app.get("/admin/promotion-batches", requireAuth, async (req, res) => {
    try {
        console.log("📚 /admin/promotion-batches called");

        const result = await sql.query`
            SELECT 
                promotion_batch_id,
                MIN(created_at) AS batch_date,
                MIN(created_by) AS performed_by,
                COUNT(DISTINCT student_email) AS learners_affected,
                COUNT(DISTINCT academic_year) AS years_covered
            FROM LearnerEnrollments
            WHERE promotion_batch_id IS NOT NULL
            GROUP BY promotion_batch_id
            ORDER BY MIN(created_at) DESC
        `;

        res.json({
            success: true,
            batches: result.recordset
        });
    } catch (err) {
        console.error("❌ /admin/promotion-batches error:", err);
        res.json({ success: false, message: err.message });
    }
});

app.post("/admin/apply-promotions", requireAuth, async (req, res) => {
    const { grade, repeat_emails } = req.body;
    const adminEmail = req.user?.email || 'unknown';

    console.log(`📤 /admin/apply-promotions called: grade=${grade}, repeaters=${repeat_emails?.length || 0}`);

    if (!grade) {
        return res.json({ success: false, message: "Grade is required." });
    }

    if (grade === 'Grade 12') {
        return res.json({ success: false, message: "Grade 12 promotions are not managed here." });
    }

    const repeaters = Array.isArray(repeat_emails) ? repeat_emails : [];

    try {
        // ---- 1. Get all learners in this grade awaiting a decision ----
        const learnersResult = await sql.query`
            SELECT 
                l.email,
                l.full_name,
                l.grade_level,
                l.stream,
                e.enrollment_id
            FROM Learners l
            INNER JOIN LearnerEnrollments e 
                ON e.student_email = l.email
                AND e.academic_year = ${CURRENT_YEAR}
            WHERE l.grade_level = ${grade}
              AND e.outcome IS NULL
            ORDER BY l.full_name
        `;

        const learners = learnersResult.recordset;

        if (learners.length === 0) {
            return res.json({
                success: false,
                message: `No learners in ${grade} are awaiting a promotion decision.`
            });
        }

        // ---- 2. Compute next grade ----
        const gradeNum = parseInt(grade.replace(/\D/g, ''), 10);
        const nextGrade = `Grade ${gradeNum + 1}`;
        const nextYear = CURRENT_YEAR + 1;

        // ---- 3. Generate a batch ID ----
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);              // 2026-10-12
        const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, ''); // 143022
        const suffix = Math.random().toString(36).substring(2, 6);   // 4 random chars
        const batchId = `${dateStr}_${timeStr}_${suffix}`;

        console.log(`🎫 Batch ID: ${batchId}`);

        // ---- 4. Apply each decision ----
        let promotedCount = 0;
        let repeatedCount = 0;

        for (const learner of learners) {
            const isRepeating = repeaters.includes(learner.email);

            if (isRepeating) {
                // ---- REPEAT: stay in same grade ----
                await sql.query`
                    UPDATE LearnerEnrollments 
                    SET outcome = 'Repeated',
                        promotion_batch_id = ${batchId}
                    WHERE enrollment_id = ${learner.enrollment_id}
                `;

                await sql.query`
                    INSERT INTO LearnerEnrollments 
                        (student_email, academic_year, grade_level, stream, created_by, promotion_batch_id)
                    VALUES 
                        (${learner.email}, ${nextYear}, ${grade}, ${learner.stream || null}, ${adminEmail}, ${batchId})
                `;

                // Learners.grade_level stays the same (no update needed)
                repeatedCount++;

            } else {
                // ---- PROMOTE: move to next grade ----
                await sql.query`
                    UPDATE LearnerEnrollments 
                    SET outcome = 'Promoted',
                        promotion_batch_id = ${batchId}
                    WHERE enrollment_id = ${learner.enrollment_id}
                `;

                await sql.query`
                    INSERT INTO LearnerEnrollments 
                        (student_email, academic_year, grade_level, stream, created_by, promotion_batch_id)
                    VALUES 
                        (${learner.email}, ${nextYear}, ${nextGrade}, ${learner.stream || null}, ${adminEmail}, ${batchId})
                `;

                // Update the learner's current grade
                await sql.query`
                    UPDATE Learners
                    SET grade_level = ${nextGrade}
                    WHERE email = ${learner.email}
                `;

                promotedCount++;
            }
        }

        // ---- 5. Log the activity ----
        await logActivity(
            adminEmail, adminEmail, 'admin',
            'Applied year-end promotions',
            `Batch: ${batchId}, Grade: ${grade}, Promoted: ${promotedCount}, Repeated: ${repeatedCount}`
        );

        console.log(`✅ Batch ${batchId}: ${promotedCount} promoted, ${repeatedCount} repeated`);

        res.json({
            success: true,
            batch_id: batchId,
            grade: grade,
            next_grade: nextGrade,
            promoted: promotedCount,
            repeated: repeatedCount,
            total: learners.length,
            message: `Applied ${promotedCount} promotions and ${repeatedCount} repeats.`
        });

    } catch (err) {
        console.error("❌ /admin/apply-promotions error:", err);
        res.json({ success: false, message: err.message });
    }
});

app.post("/admin/undo-batch/:batchId", requireAuth, async (req, res) => {
    const batchId = req.params.batchId;
    const adminEmail = req.user?.email || 'unknown';

    console.log(`↩️  /admin/undo-batch/${batchId} called`);

    if (!batchId) {
        return res.json({ success: false, message: "Batch ID is required." });
    }

    try {
        // ---- 1. Find all rows in this batch ----
        const batchRows = await sql.query`
            SELECT 
                enrollment_id,
                student_email,
                academic_year,
                grade_level,
                outcome,
                promotion_batch_id
            FROM LearnerEnrollments
            WHERE promotion_batch_id = ${batchId}
            ORDER BY student_email, academic_year
        `;

        const rows = batchRows.recordset;

        if (rows.length === 0) {
            return res.json({
                success: false,
                message: `No records found for batch ${batchId}.`
            });
        }

        // Group rows by learner — we need both the current-year row (outcome set) 
        // and the next-year row (created fresh) to undo cleanly
        const byLearner = {};
        for (const row of rows) {
            if (!byLearner[row.student_email]) {
                byLearner[row.student_email] = [];
            }
            byLearner[row.student_email].push(row);
        }

        let restoredCount = 0;

        for (const email of Object.keys(byLearner)) {
            const learnerRows = byLearner[email];

            // Find the row for the current year (has the outcome) 
            // and the row for the next year (fresh, gets deleted)
            const currentYearRow = learnerRows.find(r => r.academic_year === CURRENT_YEAR);
            const nextYearRow = learnerRows.find(r => r.academic_year === CURRENT_YEAR + 1);

            if (!currentYearRow) {
                console.warn(`⚠️ No current-year row for ${email}, skipping`);
                continue;
            }

            // Delete the next-year enrollment (created by the batch)
            if (nextYearRow) {
                await sql.query`
                    DELETE FROM LearnerEnrollments 
                    WHERE enrollment_id = ${nextYearRow.enrollment_id}
                `;
            }

            // Reset the current-year row's outcome
            await sql.query`
                UPDATE LearnerEnrollments 
                SET outcome = NULL,
                    promotion_batch_id = NULL
                WHERE enrollment_id = ${currentYearRow.enrollment_id}
            `;

            // Restore Learners.grade_level to the current-year grade
            await sql.query`
                UPDATE Learners
                SET grade_level = ${currentYearRow.grade_level}
                WHERE email = ${email}
            `;

            restoredCount++;
        }

        // ---- 2. Log the activity ----
        await logActivity(
            adminEmail, adminEmail, 'admin',
            'Undid promotion batch',
            `Batch: ${batchId}, Learners restored: ${restoredCount}`
        );

        console.log(`✅ Batch ${batchId} undone: ${restoredCount} learners restored`);

        res.json({
            success: true,
            batch_id: batchId,
            learners_restored: restoredCount,
            message: `Undid batch ${batchId}. ${restoredCount} learners restored to their pre-promotion state.`
        });

    } catch (err) {
        console.error("❌ /admin/undo-batch error:", err);
        res.json({ success: false, message: err.message });
    }
});

app.get("/admin/promotion-learners", requireAuth, async (req, res) => {
    try {
        console.log("📋 /admin/promotion-learners called (current year:", CURRENT_YEAR + ")");

        const result = await sql.query`
            SELECT 
                l.email,
                l.full_name,
                l.grade_level AS current_grade,
                l.stream,
                e.enrollment_id,
                e.academic_year,
                e.grade_level AS enrollment_grade,
                e.outcome,
                e.promotion_batch_id,
                e.created_by,
                e.created_at
            FROM Learners l
            INNER JOIN LearnerEnrollments e 
                ON e.student_email = l.email
                AND e.academic_year = ${CURRENT_YEAR}
            WHERE l.grade_level <> 'Grade 12'
            ORDER BY 
                CAST(REPLACE(l.grade_level, 'Grade ', '') AS INT),
                l.full_name
        `;

        res.json({
            success: true,
            current_year: CURRENT_YEAR,
            next_year: CURRENT_YEAR + 1,
            learners: result.recordset
        });
    } catch (err) {
        console.error("❌ /admin/promotion-learners error:", err);
        res.json({ success: false, message: err.message });
    }
});

app.post("/admin/change-promotion", requireAuth, async (req, res) => {
    const { email, new_outcome } = req.body;
    const adminEmail = req.user?.email || 'unknown';

    console.log(`🔄 /admin/change-promotion called: ${email} → ${new_outcome}`);

    if (!email || !new_outcome) {
        return res.json({ success: false, message: "Email and new_outcome are required." });
    }

    if (!['Promoted', 'Repeated'].includes(new_outcome)) {
        return res.json({ success: false, message: "new_outcome must be 'Promoted' or 'Repeated'." });
    }

    try {
        // ---- 1. Get the learner's current-year enrollment ----
        const enrollResult = await sql.query`
            SELECT enrollment_id, grade_level, stream, outcome
            FROM LearnerEnrollments
            WHERE student_email = ${email}
              AND academic_year = ${CURRENT_YEAR}
        `;

        if (enrollResult.recordset.length === 0) {
            return res.json({
                success: false,
                message: `No ${CURRENT_YEAR} enrollment found for ${email}.`
            });
        }

        const enrollment = enrollResult.recordset[0];

        if (enrollment.outcome === new_outcome) {
            return res.json({
                success: false,
                message: `Learner already has outcome '${new_outcome}'.`
            });
        }

        // ---- 2. Compute target grade based on the new outcome ----
        const gradeNum = parseInt(enrollment.grade_level.replace(/\D/g, ''), 10);
        const targetGrade = new_outcome === 'Promoted'
            ? `Grade ${gradeNum + 1}`
            : enrollment.grade_level;

        const nextYear = CURRENT_YEAR + 1;

        // ---- 3. Look for an existing next-year enrollment ----
        const nextEnrollResult = await sql.query`
            SELECT enrollment_id
            FROM LearnerEnrollments
            WHERE student_email = ${email}
              AND academic_year = ${nextYear}
        `;

        if (nextEnrollResult.recordset.length > 0) {
            // Update the existing row (from a previous promotion batch)
            await sql.query`
                UPDATE LearnerEnrollments
                SET grade_level = ${targetGrade},
                    promotion_batch_id = NULL
                WHERE enrollment_id = ${nextEnrollResult.recordset[0].enrollment_id}
            `;
        } else {
            // No next-year row exists yet — create one
            await sql.query`
                INSERT INTO LearnerEnrollments
                    (student_email, academic_year, grade_level, stream, created_by, promotion_batch_id)
                VALUES
                    (${email}, ${nextYear}, ${targetGrade}, ${enrollment.stream || null}, ${adminEmail}, NULL)
            `;
        }

        // ---- 4. Update the current-year outcome ----
        await sql.query`
            UPDATE LearnerEnrollments
            SET outcome = ${new_outcome},
                promotion_batch_id = NULL
            WHERE enrollment_id = ${enrollment.enrollment_id}
        `;

        // ---- 5. Update Learners.grade_level to match the target ----
        await sql.query`
            UPDATE Learner
            SET grade_level = ${targetGrade}
            WHERE email = ${email}
        `;

        // ---- 6. Log the activity ----
        await logActivity(
            adminEmail, adminEmail, 'admin',
            'Changed individual promotion',
            `Student: ${email}, New outcome: ${new_outcome}, Target grade: ${targetGrade}`
        );

        console.log(`✅ ${email} changed to ${new_outcome} → ${targetGrade}`);

        res.json({
            success: true,
            email: email,
            new_outcome: new_outcome,
            target_grade: targetGrade,
            message: `${email} changed to '${new_outcome}' and assigned to ${targetGrade}.`
        });

    } catch (err) {
        console.error("❌ /admin/change-promotion error:", err);
        res.json({ success: false, message: err.message });
    }
});
