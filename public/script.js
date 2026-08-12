function isValidEmail(email) {
    const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return pattern.test(email);
}

async function register() {
    const full_name = document.getElementById("reg-name").value;
    const email = document.getElementById("reg-email").value;
    const password = document.getElementById("reg-password").value;
    const role = document.getElementById("reg-role").value;

    if (!full_name || !email || !password) {
        alert("Please fill all fields");
        return;
    }
    if (password.length < 6) {
        alert("Password must be at least 6 characters");
        return;
    }
    if (!isValidEmail(email)) {
        alert("Enter a valid email address");
        return;
    }

    try {
        const response = await fetch("/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ full_name, email, password, role })
        });
        const data = await response.json();
        console.log("REGISTER RESPONSE:", data);
        alert(data.message);
        if (data.success) showLogin();
    } catch (error) {
        console.error("Register error:", error);
        alert("Register failed. Check server or console.");
    }
}

async function login() {
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;

    if (!email || !password) {
        alert("Please enter email and password");
        return;
    }

    try {
        const response = await fetch("/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();
        console.log("LOGIN RESPONSE:", data);
        alert(data.message);

        if (!data.success) return;

        localStorage.setItem("loggedInUser", JSON.stringify(data.user));

        const role = (data.user?.role || "").toLowerCase();
        if (role === "learner") window.location.href = "learner.html";
        else if (role === "teacher") window.location.href = "teacher.html";
        else if (role === "admin") window.location.href = "admin.html";
        else alert("Unknown role: " + data.user?.role);

    } catch (error) {
        console.error("Login error:", error);
        alert("Login failed. Check server or console.");
    }
}

function showTab(tabId, btn) {
    document.getElementById("menuView").style.display = "none";   // hide the carousel
    document.querySelectorAll(".tab-content").forEach(el => el.style.display = "none");
    const panel = document.getElementById(tabId);
    if (panel) panel.style.display = "block";

    if (tabId === "marks") loadMarks();
    if (tabId === "attendance") loadAttendance();
}

function showMenu() {
    document.querySelectorAll(".tab-content").forEach(el => el.style.display = "none");
    document.getElementById("menuView").style.display = "block";  // bring the carousel back
    renderCarousel();
}

function loadMarks() {
    const user = JSON.parse(localStorage.getItem("loggedInUser"));
    fetch("/marks/" + encodeURIComponent(user.email))
        .then(res => res.json())
        .then(data => {
            const box = document.getElementById("marksList");
            if (data.length === 0) { box.innerHTML = "<p>No marks published yet.</p>"; return; }
            let html = "<ul>";
            data.forEach(m => html += `<li><b>${m.subject}</b>: ${m.score} (${m.term})</li>`);
            box.innerHTML = html + "</ul>";
        });
}

function loadAttendance() {
    const user = JSON.parse(localStorage.getItem("loggedInUser"));
    fetch("/attendance/" + encodeURIComponent(user.email))
        .then(res => res.json())
        .then(data => {
            const box = document.getElementById("attendanceList");
            if (data.length === 0) { box.innerHTML = "<p>No attendance records yet.</p>"; return; }
            let html = "<ul>";
            data.forEach(a => {
                const d = new Date(a.date_recorded).toLocaleDateString();
                html += `<li>${d}: ${a.status}</li>`;
            });
            box.innerHTML = html + "</ul>";
        });
}