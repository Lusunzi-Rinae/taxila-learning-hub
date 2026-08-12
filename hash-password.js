const bcrypt = require('bcrypt');

async function hashPassword() {
    const password = '12345678'; // Change this to your desired password
    const hash = await bcrypt.hash(password, 10);
    console.log('Password:', password);
    console.log('Hash:', hash);
}

hashPassword();