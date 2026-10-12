// auth.js
// Runs on every page. Patches fetch() to automatically include the auth token.
// Also handles 401 responses by redirecting to login.
// Also enforces an inactivity timeout.

(function () {

    // ============================================
    // ===== 1. FETCH INTERCEPTOR =====
    // ============================================
    const originalFetch = window.fetch;

    window.fetch = function (url, options = {}) {
        const token = localStorage.getItem('authToken');

        if (token && typeof url === 'string' && !url.startsWith('http')) {
            options.headers = {
                ...(options.headers || {}),
                'Authorization': 'Bearer ' + token
            };
        }

        return originalFetch(url, options).then(response => {
            if (response.status === 401) {
                console.warn("⚠️ Auth token rejected. Logging out.");
                localStorage.removeItem('authToken');
                localStorage.removeItem('loggedInUser');
                localStorage.removeItem('lastActivity');
                window.location.href = 'index.html';
                return response;
            }
            return response;
        });
    };

    // ============================================
    // ===== 2. INACTIVITY TIMEOUT =====
    // ============================================
    // If a logged-in user doesn't interact with the page for
    // INACTIVITY_LIMIT milliseconds, they're logged out.

    const INACTIVITY_LIMIT = 30 * 60 * 1000;   // 30 minutes

    function updateLastActivity() {
        if (localStorage.getItem('authToken')) {
            localStorage.setItem('lastActivity', Date.now().toString());
        }
    }

    // Update the timestamp on any interaction
    ['click', 'keypress', 'mousemove', 'scroll', 'touchstart'].forEach(evt => {
        document.addEventListener(evt, updateLastActivity, { passive: true });
    });

    // Check every 30 seconds whether the user has been inactive
    function checkInactivity() {
        const token = localStorage.getItem('authToken');
        if (!token) return;   // not logged in, nothing to do

        const lastActivity = parseInt(localStorage.getItem('lastActivity') || '0', 10);

        // If we've never recorded activity, record it now
        if (!lastActivity) {
            localStorage.setItem('lastActivity', Date.now().toString());
            return;
        }

        const idleFor = Date.now() - lastActivity;

        if (idleFor > INACTIVITY_LIMIT) {
            console.log("⏰ Inactivity timeout reached. Logging out.");
            alert("Your session has expired due to inactivity. Please log in again.");
            localStorage.removeItem('authToken');
            localStorage.removeItem('loggedInUser');
            localStorage.removeItem('lastActivity');
            window.location.href = 'index.html';
        }
    }

    // Run check every 30 seconds
    setInterval(checkInactivity, 30 * 1000);

    // Also check on page load (in case the user was away and just came back)
    document.addEventListener('DOMContentLoaded', () => {
        updateLastActivity();
        checkInactivity();
    });

    // ============================================
    // ===== 3. INITIAL LOG =====
    // ============================================
    console.log('🔐 Auth interceptor loaded (inactivity timeout: 30 min)');

})();
