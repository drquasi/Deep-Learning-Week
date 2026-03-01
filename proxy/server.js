const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.post('/simplify', async (req, res) => {
    const { sentences } = req.body;

    if (!sentences || !Array.isArray(sentences)) {
        return res.status(400).json({ error: 'Invalid sentences format' });
    }

    if (!OPENAI_API_KEY || OPENAI_API_KEY === 'YOUR_OPENAI_API_KEY_HERE') {
        return res.status(500).json({ error: 'Proxy API Key not configured' });
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: `You are a vocabulary assistant. Identify advanced, academic, or complex English words in the provided sentences.
                            Return a JSON object where each key is a sentence and each value is an ARRAY of strings (the complex words found in that sentence).
                            STRICT RULES:
                            1. DO NOT identify proper nouns (names of people, places, etc.).
                            2. DO NOT identify common or simple words.
                            3. Focus on words that a non-native speaker or a young student might find difficult.
                            Example: {"The melancholy king sat alone.": ["melancholy"]}`
                    },
                    {
                        role: 'user',
                        content: JSON.stringify(sentences)
                    }
                ],
                response_format: { type: 'json_object' }
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error('OpenAI Error:', data.error);
            return res.status(500).json({ error: 'OpenAI API Error' });
        }

        const aiReplacements = JSON.parse(data.choices[0].message.content);
        res.json(aiReplacements);

    } catch (err) {
        console.error('Proxy Error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.listen(PORT, () => {
    console.log(`AdaptiRead Proxy running on http://localhost:${PORT}`);
});
