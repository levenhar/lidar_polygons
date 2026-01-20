
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';

async function testUpload() {
    const form = new FormData();
    // Create a dummy file if needed, or use an existing one
    const dummyFile = 'test.tif';
    fs.writeFileSync(dummyFile, 'dummy content');

    form.append('dtm', fs.createReadStream(dummyFile));

    try {
        const response = await fetch('http://localhost:5000/api/upload-dtm', {
            method: 'POST',
            body: form
        });

        console.log('Status:', response.status);
        const data = await response.json();
        console.log('Response:', data);
    } catch (err) {
        console.error('Error:', err);
    } finally {
        if (fs.existsSync(dummyFile)) fs.unlinkSync(dummyFile);
    }
}

testUpload();
