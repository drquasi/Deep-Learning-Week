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
                        content: `You are a vocabulary assistant. Identify advanced, academic, technical, or specialized ENGLISH words.
                            STRICT RULES:
                            1. Include words that a beginner or intermediate English learner would find difficult.
                            2. Include specialized terminology (religious, technical, scientific, literary).
                            3. ONLY identify English words. 
                            4. DO NOT identify proper nouns (names of people, places, brands).
                            5. DO NOT identify common or simple words.
                            6. Return a JSON object with a single key "complex_words" containing an array of unique strings.
                            Example: {"complex_words": ["melancholy", "capricious"]}`
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

app.post('/examples', async (req, res) => {
    const { word, contextInfo } = req.body;

    if (!word) {
        return res.status(400).json({ error: 'Word is required' });
    }

    if (!OPENAI_API_KEY || OPENAI_API_KEY === 'YOUR_OPENAI_API_KEY_HERE') {
        return res.status(500).json({ error: 'Proxy API Key not configured' });
    }

    try {
        const prompt = `As an expert linguist, create exactly 6 DIVERSE and UNIQUE high-quality organic sentences for the word "${word}" ${contextInfo || ""}. 
Ensure these sentences are different from common dictionary examples. [Seed: ${Date.now()}]

Return a JSON object:
{
  "quiz": null,
  "sentences": [
    "A natural sentence containing the word '${word}'.",
    "A different natural sentence containing the word '${word}'.",
    "A third natural sentence containing the word '${word}'.",
    "A fourth natural sentence containing the word '${word}'.",
    "A fifth natural sentence containing the word '${word}'.",
    "A sixth natural sentence containing the word '${word}'."
  ]
}

STRICT RULES:
1. WORD INCLUSION: The word "${word}" MUST appear in every single sentence.
2. NO META-SENTENCES: No "I am studying ${word}" or "The word ${word} means...". Use the word for its meaning.
3. ORGANIC USAGE: Create sentences native speakers actually say. 
4. Exactly 6 sentences. JSON only.`;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' }
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error('OpenAI Error:', data.error);
            return res.status(500).json({ error: 'OpenAI API Error' });
        }

        const content = JSON.parse(data.choices[0].message.content);
        res.json(content);

    } catch (err) {
        console.error('Proxy Error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.listen(PORT, () => {
    console.log(`AdaptiRead Proxy running on http://localhost:${PORT}`);
});
