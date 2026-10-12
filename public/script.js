function isValidEmail(email) {
    const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return pattern.test(email);
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

        if (!data.success) {
            alert(data.message);  // Only show error messages
            return;
        }

        localStorage.setItem("loggedInUser", JSON.stringify(data.user));
        // Save the JWT so future requests can be authenticated
        if (data.token) {
    localStorage.setItem("authToken", data.token);
}
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
    document.getElementById("menuView").style.display = "none";
    document.querySelectorAll(".tab-content").forEach(el => el.style.display = "none");
    const panel = document.getElementById(tabId);
    if (panel) panel.style.display = "block";

    if (tabId === "marks") loadMarks();
    if (tabId === "attendance") loadAttendance();
}

function showMenu() {
    document.querySelectorAll(".tab-content").forEach(el => el.style.display = "none");
    document.getElementById("menuView").style.display = "block";
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

// Carousel functions
let carouselIndex = 0;

function renderCarousel() {
    const items = document.querySelectorAll("#menu button");
    items.forEach((btn, i) => {
        const offset = i - carouselIndex;
        const abs = Math.abs(offset);
        const scale = offset === 0 ? 1.15 : Math.max(0.6, 1 - abs * 0.22);
        btn.style.transform =
            `translate(-50%, -50%) translateX(${offset * 95}px) scale(${scale}) rotateY(${offset * -40}deg)`;
        btn.style.zIndex = 100 - abs;
        btn.style.opacity = abs > 2 ? "0" : `${1 - abs * 0.3}`;
        btn.style.pointerEvents = offset === 0 ? "auto" : "none";
    });
}

function scrollMenu(direction) {
    const total = document.querySelectorAll("#menu button").length;
    carouselIndex = Math.min(Math.max(carouselIndex + direction, 0), total - 1);
    renderCarousel();
}

// Run carousel on page load
document.addEventListener("DOMContentLoaded", function () {
    const total = document.querySelectorAll("#menu button").length;
    if (total > 0) {
        carouselIndex = Math.floor((total - 1) / 2);
        renderCarousel();
    }
});
