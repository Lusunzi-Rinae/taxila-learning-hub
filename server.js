// Load environment variables from .env file
require('dotenv').config();

const express = require("express");
const sql = require("mssql/msnodesqlv8");
const path = require("path");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const { exec } = require("child_process");
const multer = require("multer");
const app = express();
const PORT = 3000;

// ============================================
// ===== GEMINI INTEGRATION =====
// ============================================
const { GoogleGenAI } = require('@google/genai');

// Initialize Gemini with your API key from .env
const ai = new GoogleGenAI({ 
    apiKey: process.env.GEMINI_API_KEY 
});

// Data structure to hold conversation history for each student
const chatSessions = new Map();

app.use(express.json());
app.use(express.static("public"));

const config = {
    connectionString:
        "Driver={ODBC Driver 18 for SQL Server};" +
        "Server=localhost\\SQLEXPRESS;" +
        "Database=TAXILA_LEARNING_HUB;" +
        "Trusted_Connection=Yes;" +
        "TrustServerCertificate=Yes;" +
        "Encrypt=no;"
};

sql.connect(config)
    .then(() => console.log("✅ Connected to SQL Server"))
    .catch(err => console.log("❌ DB Error:", err));

// ---- Email setup for password reset ----
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: "lusunzirinae21@gmail.com",
        pass: "eeouohfvtwvrolvv"
    }
});

// Temporary in-memory store of reset codes
const resetCodes = new Map();

// ============================================
// ===== AUTH ROUTES =====
// ============================================

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/register", async (req, res) => {
    const { full_name, email, password, role } = req.body;

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        await sql.query`
            INSERT INTO Users (full_name, email, password, role)
            VALUES (${full_name}, ${email}, ${hashedPassword}, ${role})
        `;

        res.json({ success: true, message: "Registered successfully" });
    } catch (err) {
        res.json({ success: false, message: "Email already exists or database error" });
    }
});

app.post("/login", async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await sql.query`
            SELECT * FROM Users WHERE email = ${email}
        `;

        const user = result.recordset[0];

        if (!user) {
            return res.json({ success: false, message: "User not found" });
        }

        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.json({ success: false, message: "Wrong password" });
        }

        res.json({ success: true, message: "Login successful", user });

    } catch (err) {
        res.json({ success: false, message: "Database error" });
    }
});

// ============================================
// ===== ANNOUNCEMENT ROUTES =====
// ============================================

app.post("/add-announcement", async (req, res) => {
    const { title, message } = req.body;

    if (!title || !message) {
        return res.json({ success: false, message: "Please fill all fields" });
    }

    try {
        await sql.query`
            INSERT INTO Announcements (title, message)
            VALUES (${title}, ${message})
        `;

        res.json({ success: true, message: "Announcement posted successfully" });
    } catch (err) {
        console.log(err);
        res.json({ success: false, message: "Failed to post announcement" });
    }
});

app.get("/announcements", async (req, res) => {
    try {
        const result = await sql.query`
            SELECT * FROM Announcements ORDER BY announcement_id DESC
        `;

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

app.post("/upload-homework", upload.single("file"), async (req, res) => {
    const { title, description } = req.body;
    const file_path = "/uploads/" + req.file.filename;

    try {
        await sql.query`
            INSERT INTO Homework (title, description, file_path)
            VALUES (${title}, ${description}, ${file_path})
        `;

        res.json({ success: true, message: "Homework uploaded successfully" });
    } catch (err) {
        console.log(err);
        res.json({ success: false, message: "Upload failed" });
    }
});

app.get("/homework", async (req, res) => {
    try {
        const result = await sql.query`SELECT * FROM Homework ORDER BY homework_id DESC`;
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
// ===== USER MANAGEMENT ROUTES =====
// ============================================

app.get("/users", async (req, res) => {
    try {
        const result = await sql.query`SELECT user_id, full_name, email, role FROM Users`;
        res.json(result.recordset);
    } catch (err) {
        console.log(err);
        res.json([]);
    }
});

app.delete("/users/:id", async (req, res) => {
    const id = req.params.id;

    try {
        await sql.query`DELETE FROM Users WHERE user_id = ${id}`;
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// ============================================
// ===== MARKS ROUTES =====
// ============================================

app.post("/add-mark", async (req, res) => {
    const { student_email, subject, score, term } = req.body;
    
    try {
        await sql.query`
            INSERT INTO Marks (student_email, subject, score, term)
            VALUES (${student_email}, ${subject}, ${score}, ${term})
        `;
        res.json({ success: true, message: "Mark added" });
    } catch (err) {
        console.error("❌ Error adding mark:", err);
        res.json({ success: false, message: "Failed to add mark" });
    }
});

app.get("/marks/:email", async (req, res) => {
    try {
        const result = await sql.query`
            SELECT * FROM Marks WHERE student_email = ${req.params.email}
            ORDER BY created_at DESC
        `;
        res.json(result.recordset);
    } catch (err) {
        res.json([]);
    }
});

app.get("/all-marks", async (req, res) => {
    try {
        const result = await sql.query(`
            SELECT 
                m.mark_id,
                m.student_email,
                m.subject,
                m.score,
                m.term,
                m.created_at,
                u.full_name
            FROM Marks m
            LEFT JOIN Users u ON m.student_email = u.email
            ORDER BY m.created_at DESC
        `);
        
        res.json(result.recordset);
    } catch (err) {
        console.error("❌ Error fetching marks:", err);
        res.status(500).json({ error: err.message });
    }
});

app.delete("/delete-mark/:id", async (req, res) => {
    const id = req.params.id;
    
    try {
        await sql.query`DELETE FROM Marks WHERE mark_id = ${id}`;
        res.json({ success: true, message: "Mark deleted successfully" });
    } catch (err) {
        console.error("❌ Error deleting mark:", err);
        res.json({ success: false, message: "Failed to delete mark" });
    }
});

// ============================================
// ===== ATTENDANCE ROUTES =====
// ============================================

app.post("/add-attendance", async (req, res) => {
    const { student_email, date_recorded, status } = req.body;
    
    try {
        const userCheck = await sql.query`
            SELECT full_name FROM Users WHERE email = ${student_email}
        `;
        
        if (userCheck.recordset.length === 0) {
            return res.json({ success: false, message: "Student not found" });
        }
        
        await sql.query`
            INSERT INTO Attendance (student_email, date_recorded, status)
            VALUES (${student_email}, ${date_recorded}, ${status})
        `;
        
        res.json({ success: true, message: "Attendance saved successfully" });
    } catch (err) {
        console.error("❌ Error saving attendance:", err);
        res.json({ success: false, message: "Failed to save attendance" });
    }
});

app.get("/attendance/:email", async (req, res) => {
    try {
        const result = await sql.query`
            SELECT * FROM Attendance WHERE student_email = ${req.params.email}
            ORDER BY date_recorded DESC
        `;
        res.json(result.recordset);
    } catch (err) {
        res.json([]);
    }
});

app.get("/attendance/all", async (req, res) => {
    try {
        const result = await sql.query(`
            SELECT 
                attendance_id,
                student_email,
                date_recorded,
                status,
                created_at
            FROM Attendance 
            ORDER BY date_recorded DESC, created_at DESC
        `);
        
        const records = [];
        for (const record of result.recordset) {
            try {
                const userResult = await sql.query`
                    SELECT full_name FROM Users WHERE email = ${record.student_email}
                `;
                records.push({
                    ...record,
                    full_name: userResult.recordset.length > 0 ? userResult.recordset[0].full_name : record.student_email
                });
            } catch (e) {
                records.push({
                    ...record,
                    full_name: record.student_email
                });
            }
        }
        
        res.json(records);
        
    } catch (err) {
        console.error("❌ Error fetching attendance:", err);
        res.status(500).json({ error: err.message });
    }
});

app.delete("/delete-attendance/:id", async (req, res) => {
    const id = req.params.id;
    
    try {
        await sql.query`DELETE FROM Attendance WHERE attendance_id = ${id}`;
        res.json({ success: true, message: "Attendance deleted successfully" });
    } catch (err) {
        console.error("❌ Error deleting attendance:", err);
        res.json({ success: false, message: "Failed to delete attendance" });
    }
});

// ============================================
// ===== PASSWORD RESET ROUTES =====
// ============================================

app.post("/send-reset-code", async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.json({ success: false, message: "Please enter your email" });
    }

    try {
        const result = await sql.query`SELECT * FROM Users WHERE email = ${email}`;
        const user = result.recordset[0];

        if (!user) {
            return res.json({ success: false, message: "User not found" });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        resetCodes.set(email, { code, expires: Date.now() + 10 * 60 * 1000 });

        await transporter.sendMail({
            from: "Taxila Learning Hub <YOUR_EMAIL@gmail.com>",
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

app.post("/reset-password", async (req, res) => {
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

        const result = await sql.query`
            UPDATE Users SET password = ${hashedPassword}
            WHERE email = ${email}
        `;

        if (result.rowsAffected[0] === 0) {
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
// ===== STUDENT PERFORMANCE ROUTES =====
// ============================================

app.get("/student-performance/:email", async (req, res) => {
    try {
        const result = await sql.query(`
            SELECT 
                subject,
                AVG(CAST(score AS DECIMAL(5,2))) as average,
                MAX(CAST(score AS DECIMAL(5,2))) as highest,
                MIN(CAST(score AS DECIMAL(5,2))) as lowest,
                COUNT(*) as total_marks
            FROM Marks 
            WHERE student_email = ${req.params.email}
            GROUP BY subject
            ORDER BY subject
        `);
        res.json(result.recordset);
    } catch (err) {
        console.log(err);
        res.json([]);
    }
});

// ============================================
// ===== AI CHATBOT/TUTOR ROUTES =====
// ============================================

app.post("/api/chat", async (req, res) => {
    const { message, studentEmail } = req.body;
    
    if (!message) {
        return res.json({ error: "Please enter a message" });
    }
    
    console.log(`💬 Gemini Chat from ${studentEmail || 'Guest'}: ${message}`);
    
    try {
        let studentName = "Student";
        let studentContext = "";
        
        // Fetch student details from DB to personalize the AI
        if (studentEmail) {
            const userResult = await sql.query`
                SELECT full_name FROM Users WHERE email = ${studentEmail}
            `;
            if (userResult.recordset.length > 0) {
                studentName = userResult.recordset[0].full_name;
            }
            
            const marksResult = await sql.query`
                SELECT DISTINCT subject FROM Marks WHERE student_email = ${studentEmail}
            `;
            const subjects = marksResult.recordset.map(m => m.subject);
            if (subjects.length > 0) {
                studentContext = `This student is studying: ${subjects.join(', ')}. `;
            }
        }
        
        const systemPrompt = `You are an AI Tutor for Taxila Learning Hub. 
Your name is Gemini. You are helpful, encouraging, and educational.
${studentContext}
The student's name is ${studentName}.
Keep responses educational and appropriate for school students.
Use emojis occasionally to make responses engaging.
Keep responses concise but informative (2-4 paragraphs maximum).`;

        // Check if a chat session already exists for this email
        const sessionKey = studentEmail || 'guest';
        let chat = chatSessions.get(sessionKey);

        // If no active session exists, create a new one to store history
        if (!chat) {
            chat = ai.chats.create({
                model: 'gemini-2.5-flash',
                config: {
                    systemInstruction: systemPrompt,
                    temperature: 0.7,
                }
            });
            chatSessions.set(sessionKey, chat);
        }

        // Send the message using the stored chat session (so it remembers history!)
        const completion = await chat.sendMessage({ message: message });
        
        res.json({ 
            success: true, 
            response: completion.text,
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
            gemini: {
                status: hasKey ? "available" : "unavailable",
                model: "gemini-2.5-flash"
            }
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ============================================
// ===== DEBUG ROUTES =====
// ============================================

app.get("/debug-gemini", async (req, res) => {
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

app.get("/debug-attendance", async (req, res) => {
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

app.get("/simple-test", async (req, res) => {
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
    console.log(`  POST /register - Register user`);
    console.log(`  POST /login - Login user`);
    console.log(`  GET  /announcements - Get all announcements`);
    console.log(`  POST /add-announcement - Add announcement`);
    console.log(`  DELETE /delete-announcement/:id - Delete announcement`);
    console.log(`  GET  /homework - Get all homework`);
    console.log(`  POST /upload-homework - Upload homework`);
    console.log(`  DELETE /delete-homework/:id - Delete homework`);
    console.log(`  GET  /users - Get all users`);
    console.log(`  DELETE /users/:id - Delete user`);
    console.log(`  POST /add-mark - Add mark`);
    console.log(`  GET  /marks/:email - Get marks for student`);
    console.log(`  GET  /all-marks - Get all marks`);
    console.log(`  DELETE /delete-mark/:id - Delete mark`);
    console.log(`  POST /add-attendance - Add attendance`);
    console.log(`  GET  /attendance/:email - Get attendance for student`);
    console.log(`  GET  /attendance/all - Get all attendance`);
    console.log(`  DELETE /delete-attendance/:id - Delete attendance`);
    console.log(`  GET  /student-performance/:email - Get student performance`);
    console.log(`\n🤖 AI Routes:`);
    console.log(`  POST /api/chat - Dynamic Gemini AI Chat`);
    console.log(`  GET  /api/chat/status - AI Status`);
    console.log(`\n🔍 Test routes:`);
    console.log(`  GET  /simple-test - Simple connection test`);
    console.log(`  GET  /debug-attendance - Debug attendance`);
    console.log(`  GET  /debug-gemini - Check Gemini Key setup`);
    console.log(`\n✅ Server ready!`);
    exec(`start microsoft-edge:http://localhost:${PORT}`);
});